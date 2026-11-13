import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createCachedKnowledgeLoader } from '../knowledge/load.js'
import Groq, { APIConnectionError, APIConnectionTimeoutError } from 'groq-sdk'
import { currentPublicFacts, buildRecruiterRagMessages, retrieveRecruiterRagFacts, recruiterConversation, readSelectedIds, isRecruiterCollectionRequest, recruiterCollectionCounts, isRecruiterGeneralQuestion, recruiterQuestion, recruiterFactualAnswer, recruiterProjectLinks } from './policy.js'
import { PERSONAL_FALLBACK, factKind } from '../src/services/assistant/recruiterResponder.js'
import { responseStyle, hasInternalMetadata } from '../src/services/assistant/responseStyle.js'
import { PublicError, safeError, recruiterProviderDiagnostic, providerRetryAfter } from './errors.js'
import { rateHeaders, tokenUsage, recruiterCooldown, geminiCooldown, createRecruiterTokenBudget } from './groqMetrics.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const normalize = value => value.trim().toLowerCase().replace(/\s+/g, ' ')

// One fallback and one delayed retry, sequentially, within the original deadline.
export async function recoverRecruiterRequest(attempt, { signal, timeoutMs, deadlineAt, wait = delay, clock = Date.now }) {
  const deadline = deadlineAt ?? clock() + timeoutMs
  let fallbackUsed = false
  let retryUsed = false
  let provider
  for (;;) {
    signal.throwIfAborted()
    if (clock() >= deadline) throw new PublicError(504, 'TIMEOUT', 'The AI response timed out. Please try again.')
    try { return await attempt(provider) } catch (error) {
      signal.throwIfAborted()
      const seconds = Math.max(3, error.retryAfterSeconds || 0)
      if (error.canUseGemini && !fallbackUsed && clock() < deadline) {
        fallbackUsed = true
        provider = 'gemini'
        continue
      }
      if (!error.recoverable || retryUsed || clock() + seconds * 1000 + 1000 >= deadline) throw error
      retryUsed = true
      // The next attempt reevaluates current quotas and cooldowns for both
      // providers. Only the immediate, eligible fallback pins a provider.
      provider = undefined
      await wait(seconds * 1000, undefined, { signal })
      // Re-evaluate quota routing unless the backup was already selected.
    }
  }
}

export function createGeminiProvider(config) {
  if (!config.geminiApiKey || !config.geminiModel) return null
  const client = new Groq({ apiKey: config.geminiApiKey, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', timeout: config.timeoutMs, maxRetries: 0 })
  // Groq's chat resource hardcodes /openai/v1/chat/completions. Reuse its
  // streaming/abort transport, but supply Google's actual compatible path.
  return { chat: { completions: { create: (body, options) => client.post('/chat/completions', { body, ...options, stream: body.stream ?? false }) } } }
}

// Match the whole social message; never swallow a question appended to a greeting.
function localSocialReply(message) {
  const text = normalize(message).replace(/[’‘]/g, "'")
    .replace(/\b(?:i'm|im|i am) just (?:telling|saying)(?: (?:you|u))? (?:by|bye|goodbye)\b/g, 'bye')
    .replace(/\b(?:see (?:you|ya)(?: later)?|take care|good ?bye|good night|milte hain|phir milenge|chalo bye)\b/g, 'bye')
    .replace(/\b(?:thank you|thank u|thanks a lot|bahut shukriya)\b/g, 'thanks')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().replace(/\s+/g, ' ')
  const words = text.split(' ')
  const allowed = new Set('hi hii hello hey heyy namaste namaskar bye by byee bbye alvida thanks thankyou thx shukriya dhanyavaad ok okay k okayy alright cool nice great got it bro bhai bhaiya yaar dost buddy sir ji friend then you too and'.split(' '))
  if (!text || !words.every(word => allowed.has(word))) return null
  if (words.some(word => ['bye', 'by', 'byee', 'bbye', 'alvida'].includes(word))) return 'Bye! Take care.'
  if (words.some(word => ['thanks', 'thankyou', 'thx', 'shukriya', 'dhanyavaad'].includes(word))) return 'You’re welcome!'
  if (words.some(word => ['hi', 'hii', 'hello', 'hey', 'heyy', 'namaste', 'namaskar'].includes(word))) return 'Hi! I’m Ask Shubham AI, Shubham’s personal portfolio AI assistant.'
  if (/\b(?:ok|okay|k|okayy|alright|cool|nice|great|got it)\b/.test(text)) return 'Got it. I’m here if you have another question.'
  return null
}

export function createRecruiterService({ config, groq, gemini, knowledgeLoader, acquire = () => () => {}, onMetrics = () => {}, now = Date.now, cacheTtlMs = 300000, cacheMax = 128 }) {
  const cache = new Map()
  const flights = new Map()
  let cooldown = null
  let dailyCooldown = null
  let geminiCooldownUntil = 0
  const tokenBudget = createRecruiterTokenBudget({ now, thresholdPercent: config.recruiterTpmThresholdPercent ?? 85, maxAgeMs: config.recruiterQuotaMaxAgeMs ?? 15000, probeIntervalMs: config.recruiterQuotaProbeMs ?? 60000 })
  const stats = { requests: 0, localAnswers: 0, cacheHits: 0, sharedRequests: 0, providerCalls: 0, rateLimits: 0, cooldownHits: 0 }
  const emit = metric => onMetrics({ mode: 'recruiter', ...metric })
  const snapshot = facts => hash([new Date(now()).toISOString().slice(0, 10), facts])
  const snapshotLoader = knowledgeLoader ?? createCachedKnowledgeLoader()
  let resumeUrl = null
  const current = async () => {
    const facts = await currentPublicFacts(snapshotLoader)
    const nextUrl = facts.find(fact => fact.id === 'resume')?.value ?? null
    if (resumeUrl !== nextUrl) {
      for (const [key, entry] of cache) if (entry.answer.knowledgeIds.includes('resume')) cache.delete(key)
      resumeUrl = nextUrl
    }
    return facts
  }
  const cached = key => {
    const entry = cache.get(key)
    if (!entry) return null
    cache.delete(key)
    if (entry.expiresAt <= now()) return null
    cache.set(key, entry)
    return entry.answer
  }
  function remember(key, answer) {
    // Only grounded public answers; versioned by eligible facts and bounded context.
    if (!answer.knowledgeIds.length && !answer.generalQuestion || /(?:don[’']t|do not) have|cannot confirm|can[’']t confirm/i.test(answer.text)) return
    cache.delete(key)
    cache.set(key, { answer: { text: answer.text, knowledgeIds: [...answer.knowledgeIds], generalQuestion: answer.generalQuestion === true }, expiresAt: now() + cacheTtlMs })
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value)
  }
  const backupAvailable = () => Boolean(gemini && config.geminiModel) && geminiCooldownUntil <= now()
  const activeCooldown = () => [cooldown, dailyCooldown].filter(item => item && item.until > now()).sort((a, b) => b.until - a.until)[0]
  function rateError() {
    const active = activeCooldown()
    const error = new PublicError(429, 'PROVIDER_RATE_LIMIT', 'Groq’s request limit was reached. Please wait before retrying.')
    error.retryAfterSeconds = Math.max(1, Math.ceil(((active?.until ?? now()) - now()) / 1000))
    error.limitType = active?.type ?? 'UNKNOWN'
    return error
  }
  async function select(input, facts, signal, forcedProvider, messages) {
    const release = acquire()
    let usage = null
    let limits = {}
    let finishReason = 'missing'
    let responseCharacters = 0
    let selectedProvider = 'groq'
    let ticket
    const started = now()
    const generalQuestion = input.generalQuestion ?? isRecruiterGeneralQuestion(input, facts)
    const collection = !generalQuestion && isRecruiterCollectionRequest(input)
    const budget = Math.min(config.maxCompletionTokens, collection || responseStyle(input.message).detailed ? 2048 : 1024)
    const metric = { origin: 'groq', stage: 'answer', factCount: facts.length, maxCompletionTokens: budget }
    let failureStage = 'prepare'
    try {
      signal.throwIfAborted()
      // Preparation belongs inside the release boundary too: errors here must
      // not permanently consume an active-request slot.
      Object.assign(metric, { historyMessages: messages.length - 2, promptCharacters: JSON.stringify(messages).length })
      const cooling = activeCooldown()
      // UTF-8 bytes/3 is deliberately conservative for this English/JSON context;
      // reserve the full completion allowance, including possible reasoning.
      const estimate = Math.ceil(new TextEncoder().encode(JSON.stringify(messages)).length / 3) + messages.length * 8 + budget
      const route = (forcedProvider === 'gemini' && backupAvailable()) || cooling || !config.recruiterApiKey || !groq
        ? { provider: 'gemini', reason: cooling ? 'groq_cooldown' : forcedProvider ? 'groq_upstream_failure' : 'groq_not_configured', ...(cooling ? { retryAfterSeconds: Math.max(1, Math.ceil((cooling.until - now()) / 1000)) } : {}) }
        : tokenBudget.reserve(estimate, budget)
      selectedProvider = route.provider
      ticket = route.ticket
      Object.assign(metric, { origin: selectedProvider, routingReason: route.reason, estimatedRequestTokens: estimate })
      if (selectedProvider === 'gemini' && (!gemini || !config.geminiModel)) {
        if (cooling) { stats.cooldownHits++; throw rateError() }
        throw new PublicError(503, route.reason === 'groq_not_configured' ? 'NOT_CONFIGURED' : 'FALLBACK_NOT_CONFIGURED', 'The backup assistant is not configured. Please try again later.')
      }
      if (selectedProvider === 'gemini' && geminiCooldownUntil > now()) {
        const problem = new PublicError(429, 'BACKUP_RATE_LIMIT', 'The backup assistant is rate limited. Please wait before retrying.')
        problem.retryAfterSeconds = Math.min(Math.max(1, Math.ceil((geminiCooldownUntil - now()) / 1000)), route.retryAfterSeconds ?? Infinity)
        // No provider call occurred. The one existing retry may reevaluate both
        // providers when the earliest known eligibility deadline passes.
        problem.recoverable = true
        problem.provider = 'groq'
        if (route.retryAfterSeconds !== undefined && route.retryAfterSeconds < (geminiCooldownUntil - now()) / 1000) {
          problem.code = 'PROVIDER_RATE_LIMIT'
          problem.message = 'Groq’s current usage window cannot admit this request, and the backup is cooling down. Please retry after the indicated delay.'
        }
        throw problem
      }
      const client = selectedProvider === 'groq' ? groq : gemini
      const model = selectedProvider === 'groq' ? config.model : config.geminiModel
      failureStage = 'request'
      stats.providerCalls++
      const request = client.chat.completions.create({
        model, messages, stream: true, temperature: 0,
        ...(selectedProvider === 'groq' ? { max_completion_tokens: budget } : { max_tokens: budget }),
        response_format: { type: 'json_object' },
        ...(selectedProvider === 'groq' && model.startsWith('openai/gpt-oss-') ? { include_reasoning: false, reasoning_effort: 'low' } : {}),
      }, { signal })
      let stream
      if (typeof request.withResponse === 'function') {
        const result = await request.withResponse()
        stream = result.data
        if (selectedProvider === 'groq') {
          limits = rateHeaders(result.response.headers)
          tokenBudget.observe(ticket, result.response.headers)
        }
      } else stream = await request
      failureStage = 'stream'
      let buffer = ''
      let complete = false
      for await (const chunk of stream) {
        signal.throwIfAborted()
        usage = tokenUsage(chunk) || usage
        const choice = chunk.choices?.[0]
        if (['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(choice?.finish_reason)) finishReason = choice.finish_reason
        if (choice?.finish_reason === 'stop') complete = true
        if (typeof choice?.delta?.content === 'string') buffer += choice.delta.content
        responseCharacters = buffer.length
        if (buffer.length > 12000) throw new PublicError(502, 'INVALID_AI_RESPONSE', 'The AI response could not be validated. Please retry.')
        // A terminal stop finishes generation; optional transport tails must not
        // turn a complete answer into an unrelated stream failure.
        if (complete) break
      }
      if (!complete) throw new PublicError(502, finishReason === 'length' ? 'RESPONSE_TOKEN_LIMIT' : finishReason === 'content_filter' ? 'RESPONSE_BLOCKED' : 'INCOMPLETE_RESPONSE', 'The AI response ended early. Please retry.')
      failureStage = 'validation'
      let answer
      {
        try { answer = JSON.parse(buffer.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')) } catch { throw new PublicError(502, 'INVALID_AI_RESPONSE', 'The AI response could not be validated. Please retry.') }
        if (!answer || Object.keys(answer).length !== 2 || typeof answer.answer !== 'string' || !answer.answer.trim() || answer.answer.length > 6000 || hasInternalMetadata(answer.answer)) throw new PublicError(502, 'INVALID_AI_RESPONSE', 'The AI response could not be validated. Please retry.')
      }
      const references = readSelectedIds(JSON.stringify({ factIds: Array.isArray(answer.factIds) ? [...new Set(answer.factIds)] : answer.factIds }), { complete: true, maximum: facts.length })
      const allowed = new Map(facts.map((fact, index) => [`f${index}`, fact.id]))
      if (references.some(id => !allowed.has(id))) throw new PublicError(502, 'UNAPPROVED_AI_REFERENCE', 'The AI response could not be completed. Please retry.')
      const ids = references.map(id => allowed.get(id))
      // Keep an explicitly approved project/employer relationship attached even
      // when the model cites only the project name in a short overview.
      for (const link of recruiterProjectLinks(facts)) if (facts.some(fact => fact.moduleId === link.project && ids.includes(fact.id))) {
        for (const fact of [link.evidence, link.employer]) if (!ids.includes(fact.id)) ids.push(fact.id)
      }
      if (!generalQuestion) {
        // Social replies need no personal evidence. Unsupported personal claims do.
        // Keep the numeric/link checks below even when no facts were cited.
        const withoutIdentity = answer.answer.replace(/I[’']m Ask Shubham AI, Shubham[’']s personal portfolio AI assistant\.?/g, '').replaceAll('’', "'").replace(PERSONAL_FALLBACK.replaceAll('’', "'"), '')
        const clarification = /^(?:do you mean|are you (?:asking|referring)|which|could you clarify|can you clarify|did you mean)\b[^.!?]*\?$/i.test(answer.answer.trim())
        if (!ids.length && !clarification && /\b(?:shubham|he|his|him|they|their|education|school|college|university|degree|internship|projects?|skills?|employer|salary|available|availability|relocat\w*|verified|pending|private|works?|worked|stud\w*|graduat\w*|born|lives|based|earned|join\w*|notice|age|experience|achiev\w*|awards?|developer|engineer)\b/i.test(withoutIdentity)) throw new PublicError(502, 'UNGROUNDED_RESPONSE', 'The answer did not include supporting facts. Please retry.')
        const evidence = facts.filter(fact => ids.includes(fact.id))
        const relationshipOverview = collection || !/\b(?:stack|tools|technologies|technology|when|dates?|year|repo|repository|link|url|demo)\b/.test(recruiterQuestion(input.message))
        for (const link of relationshipOverview ? recruiterProjectLinks(evidence) : []) {
          if (!answer.answer.toLowerCase().includes(String(link.employer.value).toLowerCase()) || !/internship|company work|professional work|professional project/i.test(answer.answer)) throw new PublicError(502, 'INCOMPLETE_RELATIONSHIP', 'The AI omitted the project’s company context. Please retry.')
        }
        if (collection) {
          const expected = recruiterCollectionCounts(facts)
          const cited = recruiterCollectionCounts(evidence)
          const kinds = ['skills', 'projects', 'certifications', 'awards', ...(/experience|intern|compan|employ/.test(recruiterQuestion(input.message)) ? ['experienceEntries'] : [])]
          if (kinds.some(kind => expected[kind] !== cited[kind])) throw new PublicError(502, 'INCOMPLETE_COLLECTION', 'The AI omitted items from the requested list. Please retry.')
        }
        const supported = evidence.map(fact => `${factKind(fact)} ${fact.value}`).join(' ').toLowerCase()
        const numbers = value => value.match(/\d+(?:[.,]\d+)*/g) || []
        const supportedNumbers = new Set(numbers(supported))
        if (collection) for (const total of Object.values(recruiterCollectionCounts(evidence))) if (total > 0) supportedNumbers.add(String(total))
        const links = answer.answer.match(/https?:\/\/[^\s<>]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []
        const prose = withoutIdentity.replace(/^\s*(\d+)[.)]\s+/gm, (marker, ordinal) => Number(ordinal) > 0 && Number(ordinal) <= evidence.length ? '' : marker).replace(/\bf\d+\b/g, '')
        if (numbers(prose).some(number => !supportedNumbers.has(number)) || links.some(link => !supported.includes(link.replace(/[.,;!?)]+$/, '').toLowerCase())) || /\bf\d+\b/.test(answer.answer) || facts.some(fact => fact.id.includes('-') && answer.answer.includes(fact.id))) throw new PublicError(502, 'UNAPPROVED_AI_REFERENCE', 'The AI response could not be validated. Please retry.')
      }
      emit({ ...metric, status: 200, elapsedMs: now() - started, limits, usage, finishReason, responseCharacters })
      return { text: answer.answer.trim(), knowledgeIds: ids, generalQuestion, provider: selectedProvider }
    } catch (error) {
      if (error?.status === 429 && !(error instanceof PublicError)) {
        const delay = selectedProvider === 'gemini' ? geminiCooldown(error, now()) : recruiterCooldown(error, now())
        if (selectedProvider === 'gemini') {
          geminiCooldownUntil = Math.max(geminiCooldownUntil, now() + delay.seconds * 1000)
          emit({ ...metric, status: 429, elapsedMs: now() - started, retryAfterSeconds: delay.seconds, cooldownOrigin: delay.origin, usage })
          const problem = new PublicError(429, 'BACKUP_RATE_LIMIT', 'The backup assistant is rate limited. Please wait before retrying.')
          problem.retryAfterSeconds = delay.seconds
          problem.provider = selectedProvider
          problem.recoverable = failureStage === 'request'
          throw problem
        }
        const nextCooldown = { until: now() + delay.seconds * 1000, type: delay.type }
        if (['RPD', 'TPD'].includes(delay.type)) {
          if (!dailyCooldown || nextCooldown.until > dailyCooldown.until) dailyCooldown = nextCooldown
        } else if (!cooldown || nextCooldown.until > cooldown.until) cooldown = nextCooldown
        tokenBudget.observe(ticket, error.headers)
        stats.rateLimits++
        emit({ ...metric, status: 429, elapsedMs: now() - started, limits: rateHeaders(error.headers), limitType: delay.type, retryAfterSeconds: delay.seconds, cooldownOrigin: delay.origin, usage })
        const problem = rateError()
        problem.recoverable = failureStage === 'request'
        // Only a rejected HTTP admission may fall back. Never replace an active
        // response, an invalid answer, or a canceled/timed-out generation.
        problem.canUseGemini = failureStage === 'request' && responseCharacters === 0 && backupAvailable()
        if (failureStage === 'request') usage = { totalTokens: 0, completionTokens: 0 }
        throw problem
      }
      const diagnostic = recruiterProviderDiagnostic(error)
      // The SDK throws provider SSE error events from inside iteration, before
      // our JSON parser runs. A failed JSON generation with no answer content
      // is distinct from a disconnected/partially delivered stream.
      const emptyJsonGeneration = selectedProvider === 'groq' && failureStage === 'stream'
        && responseCharacters === 0 && diagnostic.providerCode === 'json_validate_failed'
        && !(error instanceof PublicError) && !signal.aborted
      let problem = safeError(error)
      problem.recoverable = error instanceof PublicError ? error.recoverable === true : emptyJsonGeneration || failureStage === 'request'
        && ([429, 500, 502, 503, 504].includes(error?.status) || error instanceof APIConnectionError)
      if (problem.recoverable && !(error instanceof PublicError)) problem.retryAfterSeconds = error?.headers?.get?.('retry-after') ? providerRetryAfter(error, now()) : 3
      if (!(error instanceof PublicError) && [400, 401, 403, 404, 422].includes(error?.status)) {
        const configuration = [401, 403, 404].includes(error.status)
        problem = new PublicError(502, configuration ? 'PROVIDER_CONFIGURATION' : 'PROVIDER_REJECTED', configuration ? 'The AI provider configuration needs attention. Please try again later.' : 'The AI provider rejected this response. Please retry.')
      }
      // One sequential backup attempt for a rejected/unreachable upstream or a
      // completed malformed/incomplete answer. Never retry a live stream, abort,
      // timeout, unknown fact reference or unsupported factual claim.
      const rejectedRequest = failureStage === 'request' && !(error instanceof PublicError) && ([500, 502, 503, 504].includes(error?.status) || error instanceof APIConnectionError && !(error instanceof APIConnectionTimeoutError))
      const invalidCompletedAnswer = failureStage === 'validation' && ['INVALID_AI_RESPONSE', 'INCOMPLETE_COLLECTION', 'INCOMPLETE_RELATIONSHIP'].includes(error?.code)
      problem.canUseGemini = selectedProvider === 'groq' && !signal.aborted && backupAvailable() && (emptyJsonGeneration || rejectedRequest || invalidCompletedAnswer)
      emit({ ...metric, status: problem.status, code: problem.code, failureStage, elapsedMs: now() - started, limits, usage, finishReason, responseCharacters,
        ...diagnostic,
        ...(['TypeError', 'ReferenceError', 'SyntaxError', 'APIConnectionError', 'AuthenticationError', 'PermissionDeniedError', 'BadRequestError', 'NotFoundError', 'InternalServerError'].includes(error?.name) ? { errorKind: error.name } : {}),
      })
      problem.provider ??= selectedProvider
      throw problem
    } finally { tokenBudget.finish(ticket, usage); release() }
  }
  function subscribe(flight, signal) {
    return new Promise((resolve, reject) => {
      const subscriber = {}
      flight.subscribers.add(subscriber)
      const leave = () => {
        signal?.removeEventListener('abort', abort)
        flight.subscribers.delete(subscriber)
        if (!flight.settled && !flight.subscribers.size) flight.controller.abort()
      }
      const abort = () => { leave(); reject(new DOMException('Response stopped', 'AbortError')) }
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
      flight.promise.then(value => { leave(); resolve(value) }, error => { leave(); reject(error) })
    })
  }
  async function respond(input, { signal, deadlineAt = Date.now() + 15000 } = {}) {
    stats.requests++
    signal?.throwIfAborted()
    const socialReply = localSocialReply(input.message)
    if (socialReply) {
      stats.localAnswers++
      emit({ origin: 'knowledge', providerCalls: 0 })
      return { text: socialReply, knowledgeIds: [], provider: 'knowledge' }
    }
    const facts = await current()
    signal?.throwIfAborted()
    // Resolve routing once against the complete eligible snapshot. Preserve the
    // original text for technical/code requests; normalize only personal queries.
    const generalQuestion = isRecruiterGeneralQuestion(input, facts)
    if (!generalQuestion) input = { ...input, message: recruiterQuestion(input.message) }
    const factual = recruiterFactualAnswer(input, facts)
    input = { ...input, generalQuestion: factual ? false : generalQuestion }
    if (input.generalQuestion) input.generalContext = [...recruiterConversation(input)].reverse().find(item => item.role === 'user' && isRecruiterGeneralQuestion({ message: item.content }, facts))
    if (factual) {
      stats.localAnswers++
      emit({ origin: 'knowledge', providerCalls: 0 })
      return factual
    }
    if (!facts.length && !input.generalQuestion) {
      stats.localAnswers++
      emit({ origin: 'knowledge', providerCalls: 0 })
      return { text: PERSONAL_FALLBACK, knowledgeIds: [], provider: 'knowledge' }
    }
    const version = snapshot(facts)
    const relevant = input.generalQuestion ? [] : retrieveRecruiterRagFacts(input, facts)
    const messages = buildRecruiterRagMessages(input, relevant)
    // Resume URL changes invalidate resume-dependent entries only. Prompts
    // containing the resume still include its exact current value in the key.
    const cacheVersion = snapshot(facts.filter(fact => fact.id !== 'resume'))
    const key = hash([config.model, config.geminiModel, cacheVersion, input.generalQuestion, messages])
    const saved = cached(key)
    if (saved && saved.knowledgeIds.every(id => facts.some(fact => fact.id === id))) {
      stats.cacheHits++
      emit({ origin: 'cache', providerCalls: 0 })
      return { ...saved, provider: 'knowledge' }
    }
    let flight = flights.get(key)
    if (flight && (flight.controller.signal.aborted || flight.deadlineAt <= Date.now())) {
      if (!flight.controller.signal.aborted) flight.controller.abort(new PublicError(504, 'TIMEOUT', 'The AI response timed out. Please try again.'))
      // Finish transport/slot cleanup before replacing canceled shared work.
      await flight.promise.catch(() => {})
      signal?.throwIfAborted()
      // Another waiter may already have started a replacement; join it.
      flight = flights.get(key)
    }
    if (!flight || flight.controller.signal.aborted || flight.deadlineAt <= Date.now()) {
      const controller = new AbortController()
      flight = { controller, deadlineAt, subscribers: new Set(), settled: false }
      const shared = flight
      const deadlineTimer = setTimeout(() => controller.abort(new PublicError(504, 'TIMEOUT', 'The AI response timed out. Please try again.')), Math.max(0, deadlineAt - Date.now()))
      flight.promise = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted()
        return recoverRecruiterRequest(provider => select(input, relevant, controller.signal, provider, messages), { signal: controller.signal, deadlineAt })
      }).finally(() => {
        clearTimeout(deadlineTimer)
        shared.settled = true
        if (flights.get(key) === shared) flights.delete(key)
      })
      flights.set(key, flight)
    } else stats.sharedRequests++
    const answer = await subscribe(flight, signal)
    signal?.throwIfAborted()
    // Re-read after network I/O: revocations and expirations invalidate replies.
    const latest = await current()
    signal?.throwIfAborted()
    if (snapshot(latest) !== version) throw new PublicError(503, 'KNOWLEDGE_UNAVAILABLE', 'Background information changed. Please retry.')
    remember(key, answer)
    return answer
  }
  return { respond, statistics: () => ({ ...stats, cacheEntries: cache.size, inFlight: flights.size }) }
}
