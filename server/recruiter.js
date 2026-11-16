import { requestLog } from './requestLogging.js'
import { createHash } from 'node:crypto'
import { createCachedKnowledgeLoader } from '../knowledge/load.js'
import { APIConnectionError, APIConnectionTimeoutError } from 'groq-sdk'
import { currentPublicFacts, buildRecruiterRagMessages, retrieveRecruiterRagFacts, isRecruiterCollectionRequest, isRecruiterGeneralQuestion, recruiterFactualAnswer, isRecruiterMixedQuestion, recruiterRequestParts } from './policy.js'
import { PERSONAL_FALLBACK } from '../src/services/assistant/recruiterResponder.js'
import { responseStyle } from '../src/services/assistant/responseStyle.js'
import { PublicError, safeError, recruiterProviderDiagnostic } from './errors.js'
import { rateHeaders, tokenUsage, recruiterCooldown, createRecruiterTokenBudget } from './groqMetrics.js'
import { needsFreshClock, providerRequest } from './providerRequest.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const normalize = value => value.trim().toLowerCase().replace(/\s+/g, ' ')

// max_completion_tokens includes hidden reasoning as well as visible output.
// Scale both from request/context size and the existing response-style contract.
function completionBudget(input, facts, messages, maximum) {
  const style = responseStyle(input.message)
  const encoder = new TextEncoder()
  const requestTokens = Math.ceil(encoder.encode(input.message).length / 3)
  const historyTokens = messages.slice(1, -1).reduce((sum, message) => sum + Math.ceil(encoder.encode(message.content).length / 3), 0)
  const complexity = requestTokens + Math.min(256, historyTokens) + Math.min(256, facts.length * 8)
  const reasoning = 256 + Math.min(768, Math.ceil(complexity / 64) * 64)
  const answer = style.simple ? 96 : style.maxWords * 2
  const minimum = style.detailed || isRecruiterCollectionRequest(input) ? 1536 : 512
  return Math.min(maximum, Math.max(minimum, Math.ceil((reasoning + answer) / 128) * 128))
}

// One recovery attempt within the original deadline. Prefer another account;
// only a transient stream with no content may retry the same account.
export async function recoverRecruiterRequest(attempt, { signal, timeoutMs, deadlineAt, clock = Date.now, provider } = {}) {
  const deadline = deadlineAt ?? clock() + timeoutMs
  const excluded = []
  let rateLimit
  for (let count = 0; count < 2; count++) {
    signal.throwIfAborted()
    if (clock() >= deadline) throw new PublicError(504, 'TIMEOUT', 'The AI response timed out. Please try again.')
    try { return await attempt(provider, excluded) } catch (error) {
      signal.throwIfAborted()
      if (count || !(error.canUseFallback || error.canRetryEmptyStream) || clock() >= deadline) {
        if (rateLimit && error.code === 'PROVIDER_RATE_LIMIT') error.retryAfterSeconds = Math.min(error.retryAfterSeconds, Math.max(1, Math.ceil((rateLimit - clock()) / 1000)))
        throw error
      }
      if (error.code === 'PROVIDER_RATE_LIMIT') rateLimit = clock() + error.retryAfterSeconds * 1000
      if (error.canUseFallback) {
        // Empty-stream recovery may reuse this account if the preferred
        // alternative cannot pass quota admission. Still only one more call.
        if (!error.canRetryEmptyStream) excluded.push(error.account || 'groq')
        provider = error.account === 'groq-fallback' ? 'groq' : 'groq-fallback'
      } else provider = error.account
    }
  }
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

export function createRecruiterService({ config, groq, fallback, knowledgeLoader, acquire = () => () => {}, onMetrics = () => {}, now = Date.now, cacheTtlMs = 300000, cacheMax = 128 }) {
  const cache = new Map()
  const flights = new Map()
  const makeAccount = (client, key) => ({ client, key, provider: 'groq', model: config.model, cooldown: null, dailyCooldown: null,
    budget: createRecruiterTokenBudget({ now, thresholdPercent: config.recruiterTpmThresholdPercent ?? 85, maxAgeMs: config.recruiterQuotaMaxAgeMs ?? 15000, probeIntervalMs: config.recruiterQuotaProbeMs ?? 60000 }),
  })
  const accounts = {
    groq: makeAccount(groq, config.recruiterApiKey),
    'groq-fallback': makeAccount(fallback, config.fallbackApiKey !== config.recruiterApiKey ? config.fallbackApiKey : ''),
  }
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
  const activeCooldown = account => [account.cooldown, account.dailyCooldown].filter(item => item && item.until > now()).sort((a, b) => b.until - a.until)[0]
  const alternativeAvailable = selected => Object.entries(accounts).some(([name, account]) => name !== selected && account.client && account.key && !activeCooldown(account))
  function rateError(seconds = 1, type = 'UNKNOWN') {
    const error = new PublicError(429, 'PROVIDER_RATE_LIMIT', 'Groq’s request limit was reached. Please wait before retrying.')
    error.retryAfterSeconds = Math.max(1, Math.ceil(seconds))
    error.limitType = type
    return error
  }
  async function select(input, facts, signal, forcedProvider, messages, excluded = []) {
    const release = acquire()
    let usage = null
    let limits = {}
    let finishReason = 'missing'
    let responseCharacters = 0
    let selectedProvider = 'groq'
    let ticket
    let account
    const started = now()
    const generalQuestion = input.generalQuestion ?? isRecruiterGeneralQuestion(input, facts)
    const budget = completionBudget(input, facts, messages, config.maxCompletionTokens)
    const metric = { origin: 'groq', stage: 'answer', factCount: facts.length, maxCompletionTokens: budget }
    let buffer = ''
    let failureStage = 'prepare'
    try {
      signal.throwIfAborted()
      const options = providerRequest({ model: config.model, messages, input, maxTokens: budget })
      messages = options.messages
      // Preparation belongs inside the release boundary too: errors here must
      // not permanently consume an active-request slot.
      Object.assign(metric, { historyMessages: messages.length - 3, promptCharacters: JSON.stringify(messages).length })
      // Count model input, not JSON field names/escaping used by the transport.
      // Keep the conservative bytes/3 allowance and full output reservation.
      const encoder = new TextEncoder()
      const estimate = 3 + messages.reduce((sum, message) => sum + Math.ceil(encoder.encode(message.content).length / 3) + Math.ceil(encoder.encode(message.role).length / 3) + 8, 0) + budget
      const candidates = (forcedProvider === 'groq-fallback' ? ['groq-fallback', 'groq'] : ['groq', 'groq-fallback']).filter(name => !excluded.includes(name))
      const deferred = []
      let route
      for (const name of candidates) {
        const candidate = accounts[name]
        if (!candidate.client || !candidate.key) continue
        const cooling = activeCooldown(candidate)
        const admission = cooling ? { reason: 'cooldown', retryAfterSeconds: (cooling.until - now()) / 1000 } : candidate.budget.reserve(estimate, budget)
        if (!admission.ticket) {
          requestLog('quota_deferred', { provider: 'groq', account: name, routingReason: admission.reason, retryAfterSeconds: admission.retryAfterSeconds })
          deferred.push(admission)
          continue
        }
        selectedProvider = name
        account = candidate
        route = admission
        ticket = admission.ticket
        break
      }
      if (!account) {
        if (deferred.length) {
          stats.cooldownHits++
          throw rateError(Math.min(...deferred.map(item => item.retryAfterSeconds)))
        }
        throw new PublicError(503, forcedProvider ? 'FALLBACK_NOT_CONFIGURED' : 'NOT_CONFIGURED', 'The assistant is not configured. Please try again later.')
      }
      Object.assign(metric, { origin: 'groq', account: selectedProvider, routingReason: route.reason, estimatedRequestTokens: estimate })
      const client = account.client
      requestLog('provider_attempt', { provider: 'groq', account: selectedProvider, stage: 'answer', factIds: facts.map(fact => fact.id) })
      failureStage = 'request'
      stats.providerCalls++
      // Use the same plain-text request contract as General Mode.
      const request = client.chat.completions.create(options, { signal })
      let stream
      if (typeof request.withResponse === 'function') {
        const result = await request.withResponse()
        stream = result.data
        limits = rateHeaders(result.response.headers)
        account.budget.observe(ticket, result.response.headers)
      } else stream = await request
      failureStage = 'stream'
      let complete = false
      for await (const chunk of stream) {
        signal.throwIfAborted()
        const chunkUsage = tokenUsage(chunk)
        if (chunkUsage) usage = { ...usage, ...Object.fromEntries(Object.entries(chunkUsage).filter(([, value]) => value !== null)) }
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
      const text = buffer.trim()
      const internalMetadata = !generalQuestion && ['approvalReference', 'approvedValue', 'approvedAt', 'reviewAfter', 'legacyEntryId'].some(field => text.includes(field))
      if (!text || internalMetadata) throw new PublicError(502, 'INVALID_AI_RESPONSE', 'The AI response could not be completed. Please retry.')
      // These IDs identify approved source context, not model-certified claims.
      const ids = generalQuestion ? [] : facts.map(fact => fact.id)
      emit({ ...metric, status: 200, elapsedMs: now() - started, limits, usage, finishReason, responseCharacters })
      return { text, knowledgeIds: ids, generalQuestion, provider: 'groq', account: selectedProvider }
    } catch (error) {
      requestLog('provider_error', { provider: 'groq', account: selectedProvider, stage: failureStage, reason: error?.message, code: error?.code, status: error?.status, ...recruiterProviderDiagnostic(error) })
      if (error?.status === 429 && !(error instanceof PublicError) && account) {
        const hold = recruiterCooldown(error, now())
        const next = { until: now() + hold.seconds * 1000, type: hold.type }
        const field = ['RPD', 'TPD'].includes(hold.type) ? 'dailyCooldown' : 'cooldown'
        if (!account[field] || next.until > account[field].until) account[field] = next
        account.budget.observe(ticket, error.headers)
        account.budget.deferProbeUntil(next.until)
        stats.rateLimits++
        emit({ ...metric, status: 429, elapsedMs: now() - started, limits: rateHeaders(error.headers), limitType: hold.type, retryAfterSeconds: hold.seconds, usage })
        const problem = rateError(hold.seconds, hold.type)
        const otherHold = Object.entries(accounts).filter(([name, candidate]) => name !== selectedProvider && candidate.client && candidate.key)
          .map(([, candidate]) => activeCooldown(candidate)).find(Boolean)
        if (otherHold) problem.retryAfterSeconds = Math.min(problem.retryAfterSeconds, Math.max(1, Math.ceil((otherHold.until - now()) / 1000)))
        problem.account = selectedProvider
        problem.canUseFallback = failureStage === 'request' && responseCharacters === 0 && alternativeAvailable(selectedProvider)
        if (failureStage === 'request') usage = { totalTokens: 0, completionTokens: 0 }
        throw problem
      }
      const diagnostic = recruiterProviderDiagnostic(error)
      let problem = safeError(error)
      if (!(error instanceof PublicError) && [400, 401, 403, 404, 422].includes(error?.status)) {
        const configuration = [401, 403, 404].includes(error.status)
        problem = new PublicError(502, configuration ? 'PROVIDER_CONFIGURATION' : 'PROVIDER_REJECTED', configuration ? 'The AI provider configuration needs attention. Please try again later.' : 'The AI provider rejected this response. Please retry.')
      }
      // Reuse the single recovery loop for an upstream failure, invalid answer,
      // or transient empty stream. No recovery after content, abort or timeout.
      const rejectedRequest = failureStage === 'request' && !(error instanceof PublicError) && ([400, 404, 500, 502, 503, 504].includes(error?.status) || error instanceof APIConnectionError && !(error instanceof APIConnectionTimeoutError))
      const invalidCompletedAnswer = failureStage === 'validation' && error?.code === 'INVALID_AI_RESPONSE'
      const emptyStream = failureStage === 'stream' && responseCharacters === 0 && finishReason === 'missing'
        && (error?.status === 502 || error instanceof APIConnectionError && !(error instanceof APIConnectionTimeoutError))
      problem.canRetryEmptyStream = !signal.aborted && emptyStream
      problem.canUseFallback = !signal.aborted && alternativeAvailable(selectedProvider) && (rejectedRequest || invalidCompletedAnswer || emptyStream)
      emit({ ...metric, status: problem.status, code: problem.code, failureStage, elapsedMs: now() - started, limits, usage, finishReason, responseCharacters,
        ...diagnostic,
        ...(['TypeError', 'ReferenceError', 'SyntaxError', 'APIConnectionError', 'AuthenticationError', 'PermissionDeniedError', 'BadRequestError', 'NotFoundError', 'InternalServerError'].includes(error?.name) ? { errorKind: error.name } : {}),
      })
      problem.account ??= selectedProvider
      throw problem
    } finally {
      if (buffer) requestLog('raw_response', { provider: 'groq', account: selectedProvider, stage: 'answer', response: buffer })
      account?.budget.finish(ticket, usage); release()
    }
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
  async function respond(input, { signal, deadlineAt = Date.now() + config.timeoutMs } = {}) {
    stats.requests++
    signal?.throwIfAborted()
    const socialReply = localSocialReply(input.message)
    if (socialReply) {
      requestLog('intent', { intent: 'social', direct: true, factIds: [] })
      stats.localAnswers++
      emit({ origin: 'knowledge', providerCalls: 0 })
      return { text: socialReply, knowledgeIds: [], provider: 'knowledge' }
    }
    const facts = await current()
    signal?.throwIfAborted()
    // Resolve routing once against the complete eligible snapshot. Preserve the
    // original text for technical/code requests; normalize only personal queries.
    const generalQuestion = isRecruiterGeneralQuestion(input, facts)
    // Preserve original wording for the LLM; retrieval normalizes internally.
    const factual = recruiterFactualAnswer(input, facts)
    const mixedIntent = !factual && !generalQuestion && isRecruiterMixedQuestion(input, facts)
    requestLog('intent', { intent: generalQuestion ? 'general' : mixedIntent ? 'mixed' : 'personal', direct: Boolean(factual), factIds: factual?.knowledgeIds })
    input = { ...input, generalQuestion: factual ? false : generalQuestion }
    if (factual) {
      stats.localAnswers++
      emit({ origin: 'knowledge', providerCalls: 0 })
      return factual
    }
    if (!facts.length && !input.generalQuestion && !mixedIntent) {
      stats.localAnswers++
      emit({ origin: 'knowledge', providerCalls: 0 })
      return { text: PERSONAL_FALLBACK, knowledgeIds: [], provider: 'knowledge' }
    }
    const version = snapshot(facts)
    const parts = mixedIntent ? recruiterRequestParts(input, facts) : []
    const personalPart = mixedIntent ? { ...input, message: parts.filter(part => !part.general).map(part => part.message).join('; ') } : input
    const personalFactual = mixedIntent ? recruiterFactualAnswer(personalPart, facts)
      ?? (!facts.length ? { text: PERSONAL_FALLBACK, knowledgeIds: [], provider: 'knowledge' } : null) : null
    // Only split to preserve a complete, existing direct FAQ answer. All other
    // questions retain their wording and use one coherent generation.
    const mixed = mixedIntent && Boolean(personalFactual)
    const generalInput = mixed ? { ...input, generalQuestion: true, message: parts.filter(part => part.general).map(part => part.message).join('; ') } : null
    const generalMessages = mixed ? buildRecruiterRagMessages(generalInput, []) : null
    input = { ...input, runtimeConfiguration: {
      recruiter: Object.entries(accounts).filter(([, account]) => account.client && account.key)
        .map(([name, account]) => ({ role: name === 'groq' ? 'primary' : 'fallback', provider: account.provider, model: account.model })),
      general: { configured: Boolean(config.generalApiKey), provider: accounts.groq.provider, model: config.model },
    } }
    const relevant = input.generalQuestion || mixed ? [] : retrieveRecruiterRagFacts(input, facts)
    requestLog('retrieval', { factIds: relevant.map(fact => fact.id) })
    const messages = mixed ? generalMessages : buildRecruiterRagMessages(input, relevant)
    const cacheVersion = snapshot(facts.filter(fact => fact.id !== 'resume'))
    const cacheable = !needsFreshClock(input)
    const key = hash(['plain-recruiter-v1', config.model, cacheVersion, input.timeZone, input.generalQuestion, input.message, messages, personalFactual, cacheable ? null : now()])
    const saved = cacheable ? cached(key) : null
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
        const generate = async (requestInput, requestFacts, requestMessages) => {
          return recoverRecruiterRequest((provider, excluded) => select(requestInput, requestFacts, controller.signal, provider, requestMessages, excluded), { signal: controller.signal, deadlineAt })
        }
        const general = mixed ? await generate(generalInput, [], generalMessages) : null
        const answer = personalFactual ?? await generate(input, relevant, messages)
        return general ? { ...answer, provider: personalFactual ? general.provider : answer.provider, text: `${general.text} ${answer.text}`, generalQuestion: false } : answer
      }).then(async answer => {
        // Commit validation/cache before dropping the shared flight, so a request
        // arriving during snapshot validation cannot duplicate generation.
        const latest = await current()
        controller.signal.throwIfAborted()
        if (snapshot(latest) !== version) throw new PublicError(503, 'KNOWLEDGE_UNAVAILABLE', 'Background information changed. Please retry.')
        if (cacheable) remember(key, answer)
        return answer
      }).finally(() => {
        clearTimeout(deadlineTimer)
        shared.settled = true
        if (flights.get(key) === shared) flights.delete(key)
      })
      flights.set(key, flight)
    } else stats.sharedRequests++
    const answer = await subscribe(flight, signal)
    signal?.throwIfAborted()
    return answer
  }
  return { respond, statistics: () => ({ ...stats, cacheEntries: cache.size, inFlight: flights.size }) }
}
