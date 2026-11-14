import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

const requests = new AsyncLocalStorage()
export function withRequestLogContext(callback, { metadataOnly = false } = {}) {
  return requests.run({ requestId: randomUUID(), metadataOnly }, callback)
}
export function requestLogContext(req, res, next) {
  requests.run({ requestId: randomUUID() }, next)
}
export function redactLog(value) {
  if (Array.isArray(value)) return value.map(redactLog)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /key|token|authorization|password|secret|cookie/i.test(key) ? '[REDACTED]' : redactLog(item)]))
  if (typeof value !== 'string') return value
  let text = value
  // Literal credential replacement also covers nonstandard provider key formats.
  for (const [key, secret] of Object.entries(process.env)) if (/KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION/i.test(key) && secret?.length >= 6) text = text.split(secret).join('[REDACTED]')
  return text.replace(/((?:api[_ -]?key|password|secret|access[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:gsk_|sk-|AIza)[\w-]+/g, '[REDACTED KEY]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[REDACTED EMAIL]')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[REDACTED URL]')
    .replace(/(?:\+?\d[\d ().-]{8,}\d)/g, '[REDACTED NUMBER]')
    .replace(/\/(?:Users|home|private)\/[^\s"']+/g, '[REDACTED PATH]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}
export function requestLog(event, details = {}) {
  const context = requests.getStore()
  if (!context) return
  if (context.metadataOnly) {
    // Worker diagnostics contain operational metadata only: no prompts, fact
    // IDs/values, generated text, provider messages, headers or credentials.
    if (!['provider_attempt', 'provider_error', 'quota_deferred', 'metrics', 'error'].includes(event)) return
    const safe = {}
    const labels = ['provider', 'account', 'mode', 'origin', 'stage', 'code', 'finishReason', 'failureStage', 'routingReason', 'limitType', 'providerCode', 'providerParameter', 'providerFailure', 'errorKind']
    const counters = ['status', 'providerStatus', 'elapsedMs', 'retryAfterSeconds', 'factCount', 'historyMessages', 'promptCharacters', 'estimatedRequestTokens', 'maxCompletionTokens', 'responseCharacters', 'providerCalls']
    for (const key of labels) if (typeof details[key] === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(details[key])) safe[key] = details[key]
    for (const key of counters) if (typeof details[key] === 'number' && Number.isFinite(details[key])) safe[key] = details[key]
    for (const group of ['usage', 'limits']) if (details[group] && typeof details[group] === 'object') {
      safe[group] = Object.fromEntries(Object.entries(details[group]).filter(([key, value]) => /^[A-Za-z]+$/.test(key) && typeof value === 'number' && Number.isFinite(value)))
    }
    try { console.info(JSON.stringify({ requestId: context.requestId, event, ...safe })) } catch { /* Diagnostics must never affect a response. */ }
    return
  }
  try { console.info(JSON.stringify(redactLog({ ...context, event, ...details }))) } catch { /* Diagnostics must never affect a response. */ }
}
