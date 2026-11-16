import { validateKnowledge, todayUTC, isEligibleFact } from '../knowledge/validation.js'
import { createRecruiterService } from '../server/recruiter.js'
import { buildMessages } from '../server/policy.js'
import { providerRequest } from '../server/providerRequest.js'
import { validateChatInput } from '../server/validation.js'
import { ConversationStream, completionBudget } from '../server/responseStream.js'
import { PublicError, safeError } from '../server/errors.js'
import { withRequestLogContext, requestLog } from '../server/requestLogging.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const clients = new Map()
let activeRequests = 0
let recruiterState

const integer = (value, fallback, min, max) => {
  const parsed = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error('Invalid Worker configuration')
  return parsed
}

function config(env) {
  const origins = String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
  if (!origins.length) throw new Error('ALLOWED_ORIGINS is required')
  return {
    origins,
    model: String(env.GROQ_MODEL || 'openai/gpt-oss-20b').trim(),
    recruiterApiKey: String(env.GROQ_RECRUITER_API_KEY || '').trim(),
    generalApiKey: String(env.GROQ_GENERAL_API_KEY || '').trim(),
    fallbackApiKey: String(env.GROQ_FALLBACK_API_KEY || '').trim(),
    recruiterTpmThresholdPercent: integer(env.GROQ_RECRUITER_TPM_THRESHOLD_PERCENT, 85, 1, 100),
    recruiterQuotaMaxAgeMs: integer(env.GROQ_RECRUITER_QUOTA_MAX_AGE_MS, 15000, 1000, 120000),
    recruiterQuotaProbeMs: integer(env.GROQ_RECRUITER_QUOTA_PROBE_MS, 60000, 1000, 3600000),
    timeoutMs: integer(env.REQUEST_TIMEOUT_MS, 60000, 1000, 120000),
    maxConcurrent: integer(env.MAX_CONCURRENT_REQUESTS, 4, 1, 20),
    maxCompletionTokens: integer(env.MAX_COMPLETION_TOKENS, 2048, 256, 4096),
    rateLimitWindowMs: integer(env.RATE_LIMIT_WINDOW_MS, 60000, 1000, 3600000),
    rateLimitMax: integer(env.RATE_LIMIT_MAX, 20, 1, 1000),
  }
}

async function parseProviderError(response) {
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { message: 'Provider request failed.' } }
  const detail = body?.error || body || {}
  const error = new Error(typeof detail.message === 'string' ? detail.message : 'Provider request failed')
  error.status = response.status
  error.headers = response.headers
  error.error = detail
  return error
}

async function requestProvider({ key, baseUrl }, body, signal) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw await parseProviderError(response)
  return { data: body.stream ? parseSse(response.body, signal) : await response.json(), response }
}

function fetchProvider({ key, baseUrl }) {
  return {
    chat: {
      completions: {
        create: (body, { signal } = {}) => {
          // Both await and withResponse share one fetch; quota headers stay
          // available without consuming or duplicating the response stream.
          let response
          const execute = () => response ??= requestProvider({ key, baseUrl }, body, signal)
          return {
            then: (resolve, reject) => execute().then(result => result.data).then(resolve, reject),
            withResponse: execute,
          }
        },
      },
    },
  }
}

async function* parseSse(body, signal) {
  if (!body) throw new Error('Provider returned no stream')
  const reader = body.getReader()
  let pending = ''
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        try { yield JSON.parse(data) } catch { /* Ignore incomplete SSE framing. */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function loadKnowledge(storage) {
  if (!storage?.get) throw new PublicError(503, 'KNOWLEDGE_UNAVAILABLE', 'Verified background information is temporarily unavailable.')
  const snapshot = await storage.get('approved-knowledge', { type: 'json' })
  if (!snapshot?.index || !Array.isArray(snapshot.modules)) throw new PublicError(503, 'KNOWLEDGE_UNAVAILABLE', 'Verified background information is temporarily unavailable.')
  const today = todayUTC()
  const result = validateKnowledge(snapshot.index, snapshot.modules, { today })
  return { errors: result.errors, facts: result.facts.filter(fact => isEligibleFact(fact, { today })) }
}

function workerConfig(env) {
  const value = config(env)
  value.maxConcurrent = Math.min(value.maxConcurrent, 4)
  return value
}

function allowedOrigin(request, settings) {
  const origin = request.headers.get('Origin')
  return !origin || settings.origins.includes(origin) ? origin : null
}

function responseHeaders(origin) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  }
}

function errorResponse(error, origin) {
  const problem = safeError(error)
  const payload = { code: problem.code, message: problem.message, ...(problem.retryAfterSeconds ? { retryAfterSeconds: problem.retryAfterSeconds } : {}) }
  return new Response(JSON.stringify({ error: payload }), {
    status: problem.status,
    headers: { ...responseHeaders(origin), 'Content-Type': 'application/json', ...(problem.status === 429 ? { 'Retry-After': String(problem.retryAfterSeconds || 5) } : {}) },
  })
}

function rateLimited(request, settings) {
  const key = request.headers.get('CF-Connecting-IP') || 'anonymous'
  const now = Date.now()
  const current = clients.get(key)
  if (!current || current.resetAt <= now) {
    clients.set(key, { count: 1, resetAt: now + settings.rateLimitWindowMs })
    if (clients.size > settings.rateLimitMax * 4) for (const [candidate, entry] of clients) if (entry.resetAt <= now) clients.delete(candidate)
    return false
  }
  current.count++
  return current.count > settings.rateLimitMax
}

function eventStream(run, origin) {
  return new Response(new ReadableStream({
    start(controller) {
      run(async event => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')))
        .catch(error => {
          const problem = safeError(error)
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', code: problem.code, message: problem.message }) + '\n'))
        })
        .finally(() => controller.close())
    },
    cancel() {},
  }), { status: 200, headers: { ...responseHeaders(origin), 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' } })
}

async function chat(request, env, input, settings, origin) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  request.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
  const groq = fetchProvider({ key: input.mode === 'general' ? settings.generalApiKey : settings.recruiterApiKey, baseUrl: 'https://api.groq.com/openai/v1' })
  const fallback = settings.fallbackApiKey ? fetchProvider({ key: settings.fallbackApiKey, baseUrl: 'https://api.groq.com/openai/v1' }) : null
  const send = async enqueue => enqueue({ type: 'pending', mode: input.mode, timeoutMs: settings.timeoutMs })
  try {
    if (input.mode === 'recruiter') {
      const fingerprint = JSON.stringify(settings)
      if (recruiterState?.fingerprint !== fingerprint || recruiterState?.storage !== env.KNOWLEDGE) recruiterState = { fingerprint, storage: env.KNOWLEDGE, service: createRecruiterService({ config: settings, groq, fallback, knowledgeLoader: () => loadKnowledge(env.KNOWLEDGE), onMetrics: metric => requestLog('metrics', metric), acquire: () => {
        if (activeRequests >= settings.maxConcurrent) throw new PublicError(429, 'BUSY', 'Too many active AI responses. Please retry shortly.')
        activeRequests++
        return () => { activeRequests-- }
      } }) }
      const answer = await recruiterState.service.respond(input, { signal: controller.signal, deadlineAt: Date.now() + Math.min(settings.timeoutMs, 15000) })
      return async enqueue => {
        await enqueue({ type: 'start', provider: answer.provider, mode: 'recruiter' })
        for (const text of answer.text.match(/[\s\S]{1,160}/g) || []) await enqueue({ type: 'delta', text })
        await enqueue({ type: 'sources', sources: [] })
        await enqueue({ type: 'done', provider: answer.provider, mode: 'recruiter', verification: answer.knowledgeIds.length ? 'verified' : 'not_available', generalQuestion: answer.generalQuestion === true })
      }
    }
    if (!settings.generalApiKey) throw new PublicError(503, 'NOT_CONFIGURED', 'The AI assistant is not configured yet. Please try again later.')
    const messages = buildMessages(input)
    const stream = await groq.chat.completions.create(providerRequest({ model: settings.model, messages, input, maxTokens: completionBudget(input.mode, input.message, settings.maxCompletionTokens) }), { signal: controller.signal })
    return async enqueue => {
      await send(enqueue)
      await enqueue({ type: 'start', provider: 'groq', mode: 'general', model: settings.model })
      const conversation = new ConversationStream(input.message)
      let outputLength = 0
      let normalEnd = false
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0]
        if (choice?.finish_reason === 'stop') normalEnd = true
        const delta = choice?.delta?.content
        if (typeof delta !== 'string' || !delta) continue
        outputLength += delta.length
        if (outputLength > 24000) throw new PublicError(502, 'RESPONSE_LIMIT', 'The AI response exceeded the local limit. Please ask a shorter question.')
        for (const text of conversation.push(delta)) await enqueue({ type: 'delta', text })
        if (conversation.done) break
      }
      if (!normalEnd) throw new PublicError(502, 'INCOMPLETE_RESPONSE', 'The AI response ended early. Please retry.')
      for (const text of conversation.push('', true)) await enqueue({ type: 'delta', text })
      if (!outputLength || !conversation.started) throw new PublicError(502, 'EMPTY_RESPONSE', 'The AI service returned an empty response. Please retry.')
      await enqueue({ type: 'done', provider: 'groq', mode: 'general', verification: 'not_applicable' })
    }
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', abort)
  }
}

export default {
  async fetch(request, env) {
    const settings = workerConfig(env)
    const origin = allowedOrigin(request, settings)
    if (request.method === 'OPTIONS') return origin ? new Response(null, { headers: { ...responseHeaders(origin), 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' } }) : new Response(null, { status: 403 })
    if (!origin && request.headers.get('Origin')) return new Response(JSON.stringify({ error: { code: 'ORIGIN_DENIED', message: 'This origin is not allowed.' } }), { status: 403, headers: { ...responseHeaders(null), 'Content-Type': 'application/json' } })
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/health') return new Response(JSON.stringify({ status: 'ok', provider: 'groq', configured: Boolean(settings.recruiterApiKey && settings.generalApiKey), model: settings.model }), { headers: { ...responseHeaders(origin), 'Content-Type': 'application/json' } })
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/chat') return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }), { status: 404, headers: { ...responseHeaders(origin), 'Content-Type': 'application/json' } })
    if (rateLimited(request, settings)) return new Response(JSON.stringify({ error: { code: 'RATE_LIMIT', message: 'Too many requests. Please wait before trying again.' } }), { status: 429, headers: { ...responseHeaders(origin), 'Content-Type': 'application/json', 'Retry-After': '60' } })
    if (activeRequests >= settings.maxConcurrent) return errorResponse(new PublicError(429, 'BUSY', 'Too many active AI responses. Please retry shortly.'), origin)
    let counted = false
    try {
      if ((Number(request.headers.get('Content-Length')) || 0) > 32768) throw new PublicError(413, 'INPUT_TOO_LARGE', 'The request is too large.')
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new PublicError(415, 'INVALID_CONTENT_TYPE', 'Use application/json for chat requests.')
      const input = validateChatInput(await request.json())
      if (input.mode === 'general') {
        activeRequests++
        counted = true
      }
      const work = input.mode === 'recruiter'
        ? await withRequestLogContext(() => chat(request, env, input, settings, origin).catch(error => {
          requestLog('error', { code: error?.code, status: error?.status })
          throw error
        }), { metadataOnly: true })
        : await chat(request, env, input, settings, origin)
      return eventStream(async enqueue => work(enqueue), origin)
    } catch (error) {
      return errorResponse(error, origin)
    } finally {
      if (counted) activeRequests--
    }
  },
}
