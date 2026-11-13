import express from 'express'
import cors from 'cors'
import { rateLimit } from 'express-rate-limit'
import { once } from 'node:events'
import { PublicError, safeError } from './errors.js'
import { validateChatInput } from './validation.js'
import { buildMessages } from './policy.js'
import { ConversationStream, completionBudget } from './responseStream.js'
import { createRecruiterService } from './recruiter.js'

export function createApp({ config, groqRecruiter, groqGeneral, geminiRecruiter, knowledgeLoader, onProviderError = () => {}, onRecruiterMetrics = () => {} }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', false)
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
    if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return res.status(403).json({ error: { code: 'HOST_DENIED', message: 'This API is available locally only.' } })
    if (req.get('origin') && !config.origins.includes(req.get('origin'))) return res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'This origin is not allowed.' } })
    next()
  })
  app.use(cors({ origin: config.origins, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'], credentials: false, maxAge: 600 }))
  app.get('/api/health', (req, res) => res.json({ status: 'ok', provider: 'groq', configured: Boolean(config.recruiterApiKey && config.generalApiKey), model: config.model }))
  app.use('/api/chat', rateLimit({ windowMs: config.rateLimitWindowMs, limit: config.rateLimitMax, standardHeaders: 'draft-8', legacyHeaders: false, validate: { xForwardedForHeader: false }, message: { error: { code: 'RATE_LIMIT', message: 'Too many requests. Please wait before trying again.' } } }))
  app.use(express.json({ limit: '32kb', strict: true }))
  let activeRequests = 0
  let providerAvailableAt = 0
  const recruiter = createRecruiterService({ config, groq: groqRecruiter, gemini: geminiRecruiter, knowledgeLoader, onMetrics: onRecruiterMetrics, acquire: () => {
    if (activeRequests >= config.maxConcurrent) throw new PublicError(429, 'BUSY', 'Too many active AI responses. Please retry shortly.')
    activeRequests++
    return () => { activeRequests-- }
  } })
  app.locals.recruiterStatistics = recruiter.statistics

  app.post('/api/chat', async (req, res) => {
    let timer
    let timedOut = false
    let acquired = false
    let requestMode
    const startedAt = Date.now()
    const controller = new AbortController()
    const providerController = new AbortController()
    const abortProvider = () => providerController.abort()
    controller.signal.addEventListener('abort', abortProvider, { once: true })
    const disconnect = () => { if (!res.writableEnded) controller.abort() }
    req.once('aborted', disconnect)
    res.once('close', disconnect)
    const send = async event => {
      controller.signal.throwIfAborted()
      if (res.destroyed || res.writableEnded) throw new DOMException('Disconnected', 'AbortError')
      if (!res.headersSent) {
        res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' })
        res.flushHeaders()
      }
      if (!res.write(JSON.stringify(event) + '\n')) await once(res, 'drain', { signal: controller.signal })
    }
    try {
      if (!req.is('application/json')) throw new PublicError(415, 'INVALID_CONTENT_TYPE', 'Use application/json for chat requests.')
      const input = validateChatInput(req.body)
      requestMode = input.mode
      if (input.mode === 'recruiter') {
        const deadlineAt = startedAt + 15000
        timer = setTimeout(() => { timedOut = true; controller.abort() }, Math.max(1, deadlineAt - Date.now()))
        if (req.get('accept')?.includes('application/x-ndjson')) await send({ type: 'pending', mode: input.mode, timeoutMs: 15000 })
        // Race all work, including knowledge I/O, against the same request
        // signal. Provider subscribers detach and cancel when the request ends.
        let rejectAbort
        const aborted = new Promise((resolve, reject) => { rejectAbort = () => reject(new PublicError(timedOut ? 504 : 499, timedOut ? 'TIMEOUT' : 'CANCELLED', timedOut ? 'The AI response timed out. Please try again.' : 'Response stopped.')) })
        controller.signal.addEventListener('abort', rejectAbort, { once: true })
        let answer
        try {
          controller.signal.throwIfAborted()
          answer = await Promise.race([recruiter.respond(input, { signal: controller.signal, deadlineAt }), aborted])
        } finally { controller.signal.removeEventListener('abort', rejectAbort) }
        await send({ type: 'start', provider: answer.provider, mode: 'recruiter' })
        // Recruiter text is already complete and grounding-validated. A second
        // sentence limiter could reject valid answers or silently drop facts.
        for (const text of answer.text.match(/[\s\S]{1,160}/g) || []) await send({ type: 'delta', text })
        await send({ type: 'sources', sources: [] })
        await send({ type: 'done', provider: answer.provider, mode: 'recruiter', verification: answer.knowledgeIds.length ? 'verified' : 'not_available', generalQuestion: answer.generalQuestion === true })
        res.end()
        return
      }
      if (!config.generalApiKey || !groqGeneral) throw new PublicError(503, 'NOT_CONFIGURED', 'The AI assistant is not configured yet. Please check back later.')
      if (providerAvailableAt > Date.now()) {
        const problem = new PublicError(429, 'PROVIDER_RATE_LIMIT', 'Groq’s request or token limit was reached. Please wait before retrying.')
        problem.retryAfterSeconds = Math.ceil((providerAvailableAt - Date.now()) / 1000)
        throw problem
      }
      if (activeRequests >= config.maxConcurrent) throw new PublicError(429, 'BUSY', 'Too many active AI responses. Please retry shortly.')
      activeRequests++
      acquired = true
      timer = setTimeout(() => { timedOut = true; controller.abort() }, config.timeoutMs)
      if (req.get('accept')?.includes('application/x-ndjson')) await send({ type: 'pending', mode: input.mode, timeoutMs: config.timeoutMs })
      controller.signal.throwIfAborted()
      const messages = buildMessages(input)
      const options = {
        model: config.model, messages, stream: true, max_completion_tokens: completionBudget(input.mode, input.message, config.maxCompletionTokens),
        ...(config.model.startsWith('openai/gpt-oss-') ? { include_reasoning: false, reasoning_effort: 'low' } : {}),
      }
      const stream = await groqGeneral.chat.completions.create(options, { signal: providerController.signal })
      await send({ type: 'start', provider: 'groq', mode: input.mode, model: config.model })
      const conversation = new ConversationStream(input.message)
      let outputLength = 0
      let normalEnd = false
      let conciseEnd = false
      for await (const chunk of stream) {
        controller.signal.throwIfAborted()
        const choice = chunk.choices?.[0]
        if (choice?.finish_reason === 'stop') normalEnd = true
        const delta = choice?.delta?.content
        if (typeof delta !== 'string' || !delta) continue
        outputLength += delta.length
        if (outputLength > 24000) throw new PublicError(502, 'RESPONSE_LIMIT', 'The AI response exceeded the local limit. Please ask a shorter question.')
        for (const text of conversation.push(delta)) await send({ type: 'delta', text })
        if (conversation.done) { conciseEnd = true; break }
      }
      if (conciseEnd) { providerController.abort(); normalEnd = true }
      if (!normalEnd) throw new PublicError(502, 'INCOMPLETE_RESPONSE', 'The AI response ended early. Please retry.')
      if (!conciseEnd) for (const text of conversation.push('', true)) await send({ type: 'delta', text })
      if (!outputLength || !conversation.started) throw new PublicError(502, 'EMPTY_RESPONSE', 'The AI service returned an empty response. Please retry.')
      await send({ type: 'done', provider: 'groq', mode: input.mode, verification: 'not_applicable' })
      res.end()
    } catch (error) {
      if (res.destroyed) return
      if (controller.signal.aborted && !timedOut) return
      const problem = safeError(error, timedOut)
      if (requestMode !== 'recruiter' && problem.code === 'PROVIDER_RATE_LIMIT' && !(error instanceof PublicError)) providerAvailableAt = Math.max(providerAvailableAt, Date.now() + problem.retryAfterSeconds * 1000)
      // Log only stable codes and bounded operational details, never keys,
      // prompts, provider payloads, raw errors, conversations or personal data.
      onProviderError(problem.code, { mode: requestMode, elapsedMs: Date.now() - startedAt, status: problem.status, ...(problem.retryAfterSeconds ? { retryAfterSeconds: problem.retryAfterSeconds } : {}),
        ...(requestMode === 'recruiter' && Number.isInteger(error?.status) && !(error instanceof PublicError) && error.status >= 100 && error.status <= 599 ? { providerStatus: error.status } : {}),
        ...(requestMode === 'recruiter' && ['TypeError', 'ReferenceError', 'SyntaxError', 'APIConnectionError', 'AuthenticationError', 'PermissionDeniedError', 'BadRequestError', 'NotFoundError', 'InternalServerError'].includes(error?.name) ? { errorKind: error.name } : {}),
      })
      const payload = { code: problem.code, message: problem.message, ...(problem.retryAfterSeconds ? { retryAfterSeconds: problem.retryAfterSeconds } : {}), ...(problem.limitType ? { limitType: problem.limitType } : {}) }
      if (problem.status === 429 && !res.headersSent) res.set('Retry-After', String(problem.retryAfterSeconds || 5))
      if (res.headersSent) res.end(JSON.stringify({ type: 'error', ...payload }) + '\n')
      else res.status(problem.status).json({ error: payload })
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', abortProvider)
      providerController.abort()
      req.off('aborted', disconnect)
      res.off('close', disconnect)
      if (acquired) activeRequests--
    }
  })
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }))
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    const tooLarge = error?.type === 'entity.too.large'
    res.status(tooLarge ? 413 : 400).json({ error: { code: tooLarge ? 'INPUT_TOO_LARGE' : 'INVALID_JSON', message: tooLarge ? 'The request is too large.' : 'The request body must be valid JSON.' } })
  })
  return app
}
