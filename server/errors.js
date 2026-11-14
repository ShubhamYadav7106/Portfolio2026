import { APIConnectionTimeoutError } from 'groq-sdk'

export class PublicError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

// Provider bodies can contain generated text, prompts or identifiers. Classify
// the actual body locally; only a bounded allowlist may enter operational logs.
export function recruiterProviderDiagnostic(error) {
  if (error instanceof PublicError) return {}
  const raw = Array.isArray(error?.error) ? error.error[0] : error?.error
  const body = raw?.error || raw || {}
  const codes = ['invalid_api_key', 'model_not_found', 'invalid_request_error', 'rate_limit_exceeded', 'context_length_exceeded', 'json_validate_failed', 'NOT_FOUND', 'INVALID_ARGUMENT', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'PERMISSION_DENIED', 'UNAUTHENTICATED']
  const code = typeof body.code === 'string' ? body.code : body.status
  const message = typeof body.message === 'string' ? body.message : typeof error?.message === 'string' ? error.message : ''
  const parameters = ['model', 'response_format', 'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'include_reasoning', 'stream', 'messages']
  const kind = error?.constructor?.name
  return {
    ...(['APIConnectionError', 'APIConnectionTimeoutError', 'AuthenticationError', 'PermissionDeniedError', 'BadRequestError', 'NotFoundError', 'InternalServerError'].includes(kind) ? { errorKind: kind } : {}),
    ...(Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? { providerStatus: error.status } : {}),
    ...(codes.includes(code) ? { providerCode: code } : {}),
    ...(parameters.includes(body.param) ? { providerParameter: body.param } : {}),
    ...(code === 'json_validate_failed' || /failed to (?:generate|validate).*json/i.test(message) ? { providerFailure: 'json_generation' } : /model.*(?:not found|not supported|does not exist|no longer available)/i.test(message) ? { providerFailure: 'model_unavailable' } : /unsupported|not supported|not allowed/i.test(message) ? { providerFailure: 'unsupported_parameter' } : /overload|high demand|temporar.*unavail/i.test(message) ? { providerFailure: 'upstream_unavailable' } : {}),
  }
}

// Read only the standard cooldown header. Never reflect provider payloads.
export function providerRetryAfter(error, now = Date.now()) {
  const headers = error?.headers
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after']
  if (typeof raw !== 'string' || !raw.trim()) return 5
  const seconds = /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : (Date.parse(raw) - now) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(86400, Math.max(1, Math.ceil(seconds))) : 5
}

export function safeError(error, timedOut = false) {
  if (timedOut || error instanceof APIConnectionTimeoutError || [408, 504].includes(error?.status)) return new PublicError(504, 'TIMEOUT', 'The AI response timed out. Please try again.')
  if (error instanceof PublicError) return error
  if (error?.status === 429) {
    const problem = new PublicError(429, 'PROVIDER_RATE_LIMIT', 'Groq’s request or token limit was reached. Please wait before retrying.')
    problem.retryAfterSeconds = providerRetryAfter(error)
    return problem
  }
  return new PublicError(502, 'AI_UNAVAILABLE', 'The AI service is unavailable. Please try again later.')
}
