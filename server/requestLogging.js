import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

const requests = new AsyncLocalStorage()
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
  try { console.info(JSON.stringify(redactLog({ ...context, event, ...details }))) } catch { /* Diagnostics must never affect a response. */ }
}
