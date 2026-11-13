const CHAT_ENDPOINT = import.meta.env?.PROD
  ? 'https://ask-shubham-ai.shubhamyadav98372.workers.dev/api/chat'
  : '/api/chat'

const ERROR_MESSAGES = {
  NOT_CONFIGURED: 'The AI assistant isn’t configured yet. Please check back later.',
  RATE_LIMIT: 'Too many messages. Please wait a moment before retrying.',
  PROVIDER_RATE_LIMIT: 'Groq’s request or token limit was reached. Please wait before retrying.',
  BUSY: 'Too many active AI responses. Please retry shortly.',
  TIMEOUT: 'The AI response timed out. Please try again.',
  INVALID_INPUT: 'That message or conversation is too large. Please shorten it or clear the chat.',
  INPUT_TOO_LARGE: 'That conversation is too large. Please clear the chat and try again.',
  KNOWLEDGE_UNAVAILABLE: 'Verified background information is temporarily unavailable.',
  UNAVAILABLE: 'Couldn’t connect to the assistant. Please try again.',
  AI_UNAVAILABLE: 'The assistant is temporarily unavailable. Please try again.',
  EMPTY_RESPONSE: 'The assistant returned an empty answer. Please retry.',
}
// Recruiter-specific diagnostics; General Mode keeps its existing messages.
const RECRUITER_ERROR_MESSAGES = {
  PROVIDER_CONFIGURATION: 'The AI provider configuration needs attention. Please try again later.',
  PROVIDER_REJECTED: 'The AI provider rejected this response. Please retry.',
  COLLECTION_TOO_LARGE: 'Please request one topic at a time so I can return the complete list.',
  INCOMPLETE_COLLECTION: 'The AI omitted items from the requested list. Please retry for the complete answer.',
  INCOMPLETE_RELATIONSHIP: 'The AI omitted the project’s company context. Please retry for an accurate answer.',
  FALLBACK_NOT_CONFIGURED: 'Groq is at its safe usage limit and the backup assistant is not configured yet. Please try again later.',
  BACKUP_RATE_LIMIT: 'The backup assistant is rate limited. Please wait before retrying.',
  INCOMPLETE_RESPONSE: 'The AI connection ended before the answer finished. Please retry.',
  RESPONSE_TOKEN_LIMIT: 'The AI reached its response limit before finishing. Please retry with a shorter question.',
  RESPONSE_BLOCKED: 'The AI provider could not return this response. Please rephrase your question.',
  INVALID_AI_RESPONSE: 'The AI returned an invalid answer format. Please retry.',
  UNAPPROVED_AI_REFERENCE: 'The answer could not be matched to approved information. Please retry.',
  UNGROUNDED_RESPONSE: 'The answer lacked supporting information. Please retry.',
  INVALID_STREAM: 'The response stream was interrupted or invalid. Please retry.',
}

export class ChatServiceError extends Error {
  constructor(code, retryAfterSeconds, limitType, mode) {
    const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 && retryAfterSeconds <= 86400 ? Math.ceil(retryAfterSeconds) : undefined
    const quotas = { RPM: 'per-minute request limit', TPM: 'per-minute token limit', RPD: 'daily request quota', TPD: 'daily token quota' }
    const quota = Object.hasOwn(quotas, limitType) ? quotas[limitType] : undefined
    super(code === 'PROVIDER_RATE_LIMIT' && quota ? `Groq’s ${quota} was reached.${delay ? ` Please retry in ${delay} second${delay === 1 ? '' : 's'}.` : ' Please wait before retrying.'}` : code === 'PROVIDER_RATE_LIMIT' && delay ? `Groq’s request or token limit was reached. Please retry in ${delay} second${delay === 1 ? '' : 's'}.` : ERROR_MESSAGES[code] || 'The AI response couldn’t be completed. Please try again.')
    this.code = code
    if (mode === 'recruiter' && Object.hasOwn(RECRUITER_ERROR_MESSAGES, code)) this.message = RECRUITER_ERROR_MESSAGES[code]
    this.userMessage = this.message
    this.retryAfterSeconds = delay
  }
}

function boundedHistory(history, mode) {
  const result = history.filter(item => (item.mode === undefined || item.mode === mode) && ['user', 'assistant'].includes(item.role) && typeof item.text === 'string' && item.text.trim() && item.text.length <= (item.role === 'user' ? 600 : 8000))
    .slice(-16).map(item => ({ role: item.role, text: item.text, mode }))
  while (result.reduce((sum, item) => sum + item.text.length, 0) > 16000 || new TextEncoder().encode(JSON.stringify(result)).length > 26000) result.shift()
  return result
}

export async function streamChat(question, { mode = 'recruiter', history = [], signal, onDelta = () => {}, onSources = () => {}, fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  const controller = new AbortController()
  let expired = false
  let reader
  let timer
  const requestedAt = Date.now()
  const setDeadline = duration => {
    clearTimeout(timer)
    timer = setTimeout(() => { expired = true; controller.abort() }, duration)
  }
  const abort = () => controller.abort()
  if (signal?.aborted) throw new DOMException('Response stopped', 'AbortError')
  signal?.addEventListener('abort', abort, { once: true })
  // Allow the server's maximum supported deadline plus transport grace until
  // its pending frame supplies the actual configured deadline. Never heartbeat
  // or token-reset this timer; a stalled request must still end.
  setDeadline(timeoutMs ?? (mode === 'recruiter' ? 17000 : 135000))
  try {
    const response = await fetchImpl(CHAT_ENDPOINT, {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, signal: controller.signal,
      body: JSON.stringify({ mode, message: question, history: boundedHistory(history, mode) }),
    })
    if (!response.ok) {
      let code
      let retryAfterSeconds
      let limitType
      try {
        const error = (await response.json()).error
        code = error?.code
        retryAfterSeconds = error?.retryAfterSeconds
        if (mode === 'recruiter') limitType = error?.limitType
      } catch { /* no provider/proxy error text is exposed */ }
      throw new ChatServiceError(code || 'UNAVAILABLE', retryAfterSeconds ?? Number(response.headers.get('Retry-After')), limitType, mode)
    }
    if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new ChatServiceError('INVALID_STREAM')
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let started = false
    let pending = false
    let provider
    let text = ''
    let sources = []
    let finished = null
    function event(line) {
      if (!line.trim()) return
      let data
      try { data = JSON.parse(line) } catch { throw new ChatServiceError('INVALID_STREAM') }
      if (data.type === 'error') throw new ChatServiceError(data.code, data.retryAfterSeconds, mode === 'recruiter' ? data.limitType : undefined, mode)
      if (data.type === 'pending') {
        if (pending || started || data.mode !== mode || !Number.isInteger(data.timeoutMs) || data.timeoutMs < 1 || data.timeoutMs > 120000) throw new ChatServiceError('INVALID_STREAM')
        pending = true
        if (timeoutMs === undefined) setDeadline(Math.max(1, data.timeoutMs + (mode === 'recruiter' ? 2000 : 10000) - (Date.now() - requestedAt)))
        return
      }
      if (data.type === 'start') {
        if (started || !(data.provider === 'groq' || mode === 'recruiter' && ['knowledge', 'gemini'].includes(data.provider)) || data.mode !== mode) throw new ChatServiceError('INVALID_STREAM')
        started = true
        provider = data.provider
      } else if (!started) throw new ChatServiceError('INVALID_STREAM')
      else if (data.type === 'delta') {
        if (typeof data.text !== 'string' || text.length + data.text.length > 30000) throw new ChatServiceError('INVALID_STREAM')
        text += data.text
        onDelta(data.text)
      } else if (data.type === 'sources') {
        if (!Array.isArray(data.sources) || data.sources.length > 16 || data.sources.some(source => typeof source.id !== 'string' || typeof source.label !== 'string' || source.status !== 'verified' || !/^\/#[-a-z0-9]+$/.test(source.href))) throw new ChatServiceError('INVALID_STREAM')
        sources = data.sources
        onSources(sources)
      } else if (data.type === 'done') {
        if (!text || data.provider !== provider || data.mode !== mode || !(mode === 'general' ? data.verification === 'not_applicable' : ['verified', 'not_available'].includes(data.verification))) throw new ChatServiceError('INVALID_STREAM')
        finished = { text, sources, mode, provider, verification: data.verification, generalQuestion: mode === 'recruiter' && data.generalQuestion === true }
      } else throw new ChatServiceError('INVALID_STREAM')
    }
    while (!finished) {
      const chunk = await reader.read()
      controller.signal.throwIfAborted()
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done })
      if (buffer.length > 65536) throw new ChatServiceError('INVALID_STREAM')
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1 && !finished) {
        event(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
      if (chunk.done) {
        if (buffer.trim() && !finished) event(buffer)
        if (!finished) throw new ChatServiceError('INCOMPLETE_RESPONSE')
      }
    }
    return finished
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Response stopped', 'AbortError')
    if (expired) throw new ChatServiceError('TIMEOUT')
    if (error instanceof ChatServiceError) {
      if (mode === 'recruiter' && Object.hasOwn(RECRUITER_ERROR_MESSAGES, error.code)) throw new ChatServiceError(error.code, error.retryAfterSeconds, undefined, mode)
      throw error
    }
    throw new ChatServiceError('UNAVAILABLE')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    await reader?.cancel().catch(() => {})
  }
}
