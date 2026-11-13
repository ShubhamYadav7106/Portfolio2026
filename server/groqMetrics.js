const numericHeaders = {
  'x-ratelimit-limit-requests': 'dailyRequestLimit',
  'x-ratelimit-remaining-requests': 'dailyRequestsRemaining',
  'x-ratelimit-limit-tokens': 'tokensPerMinuteLimit',
  'x-ratelimit-remaining-tokens': 'tokensPerMinuteRemaining',
}
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null
const header = (headers, key) => typeof headers?.get === 'function' ? headers.get(key) : headers?.[key]

export function durationSeconds(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return number(Number(value))
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|[dhms])/g)]
  if (!matches.length || matches.map(match => match[0]).join('') !== value.trim()) return null
  return number(matches.reduce((sum, [, amount, unit]) => sum + Number(amount) * ({ d: 86400, h: 3600, m: 60, s: 1, ms: 0.001 })[unit], 0))
}

// Only numeric operational fields leave this boundary, never arbitrary headers.
export function rateHeaders(headers) {
  const result = {}
  for (const [key, label] of Object.entries(numericHeaders)) {
    const raw = header(headers, key)
    if (typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw) && number(Number(raw)) !== null) result[label] = Number(raw)
  }
  for (const [key, label] of [['x-ratelimit-reset-requests', 'dailyRequestsResetSeconds'], ['x-ratelimit-reset-tokens', 'tokensResetSeconds']]) {
    const seconds = durationSeconds(header(headers, key))
    if (seconds !== null) result[label] = seconds
  }
  return result
}

export function tokenUsage(chunk) {
  const usage = chunk?.x_groq?.usage || chunk?.usage
  if (!usage) return null
  return {
    promptTokens: number(usage.prompt_tokens), completionTokens: number(usage.completion_tokens),
    reasoningTokens: number(usage.completion_tokens_details?.reasoning_tokens), totalTokens: number(usage.total_tokens),
  }
}

export function quotaType(error) {
  // Inspect trusted provider error text only to classify; never log/return it.
  const text = `${typeof error?.error?.code === 'string' ? error.error.code : ''} ${typeof error?.message === 'string' ? error.message : ''}`
  if (/\bTPD\b|tokens per day|daily token/i.test(text)) return 'TPD'
  if (/\bRPD\b|requests per day|daily request/i.test(text)) return 'RPD'
  if (/\b(?:TPM|ITPM|OTPM)\b|tokens per minute/i.test(text)) return 'TPM'
  if (/\bRPM\b|requests per minute/i.test(text)) return 'RPM'
  const limits = rateHeaders(error?.headers)
  // Groq's request counter is DAILY, not RPM.
  if (limits.dailyRequestsRemaining === 0) return 'RPD'
  if (limits.tokensPerMinuteRemaining === 0) return 'TPM'
  return 'UNKNOWN'
}

export function recruiterCooldown(error, now = Date.now()) {
  const type = quotaType(error)
  const raw = header(error?.headers, 'retry-after')
  let seconds = typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : typeof raw === 'string' ? (Date.parse(raw) - now) / 1000 : NaN
  if (!Number.isFinite(seconds) || seconds < 0) {
    const limits = rateHeaders(error?.headers)
    seconds = type === 'RPD' ? limits.dailyRequestsResetSeconds ?? 86400 : type === 'TPD' ? 86400 : type === 'TPM' ? limits.tokensResetSeconds ?? 60 : 60
  }
  const limits = rateHeaders(error?.headers)
  const reset = type === 'RPD' ? limits.dailyRequestsResetSeconds : type === 'TPM' ? limits.tokensResetSeconds : undefined
  if (reset !== undefined) seconds = Math.max(seconds, reset)
  // Saturate absurd numeric values safely; never retry before Retry-After.
  return { type, seconds: Math.max(1, Math.min(Math.ceil(seconds), Math.floor(Number.MAX_SAFE_INTEGER / 1000))) }
}

// Google supplies RetryInfo and QuotaFailure, not Groq's daily request headers.
export function geminiCooldown(error, now = Date.now()) {
  const raw = Array.isArray(error?.error) ? error.error[0] : error?.error
  const body = raw?.error || raw || {}
  const details = Array.isArray(body.details) ? body.details : []
  const waits = details.filter(item => String(item['@type']).endsWith('/google.rpc.RetryInfo'))
    .map(item => durationSeconds(item.retryDelay)).filter(value => value !== null)
  const retry = header(error?.headers, 'retry-after')
  const seconds = typeof retry === 'string' && /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) : typeof retry === 'string' ? (Date.parse(retry) - now) / 1000 : NaN
  if (Number.isFinite(seconds) && seconds >= 0) waits.push(seconds)
  const daily = details.filter(item => String(item['@type']).endsWith('/google.rpc.QuotaFailure'))
    .some(item => Array.isArray(item.violations) && item.violations.some(violation => /per.?day|daily/i.test(String(violation.quotaId || ''))))
  // A 24-hour policy hold requires an actual daily quota violation. Generic
  // provider text can mention daily limits without identifying the exhausted one.
  return { seconds: Math.max(1, Math.ceil(waits.length ? Math.max(...waits) : daily ? 86400 : 60)), origin: waits.length ? 'provider_retry' : daily ? 'daily_quota_violation' : 'unknown_quota_backoff' }
}

// One local process / Recruiter key. Unknown quotas are never replaced by defaults.
export function createRecruiterTokenBudget({ now = Date.now, thresholdPercent = 85, maxAgeMs = 15000, probeIntervalMs = 60000 } = {}) {
  let sample = null
  let latchedUntil = 0
  let nextProbeAt = 0
  let dailyUntil = 0
  let order = 0
  const ledger = new Set()
  function advance() {
    const time = now()
    if (sample && time >= sample.resetAt) {
      sample = null
      nextProbeAt = 0 // A known reset permits a new user-request probe.
      for (const ticket of ledger) if (ticket.finished) ledger.delete(ticket)
    }
    if (latchedUntil && time >= latchedUntil) latchedUntil = 0
    return time
  }
  function used() {
    if (!sample) return null
    let extra = 0
    for (const ticket of ledger) {
      if (ticket === sample.ticket) {
        // Its own header already accounts for admission; reserve future output.
        extra += ticket.finished ? ticket.completion ?? ticket.outputBudget : ticket.outputBudget
      } else if (!ticket.finished || ticket.finished > sample.ticket.issued) {
        // A concurrent request may not be reflected by this header snapshot.
        extra += ticket.total ?? ticket.estimate
      }
    }
    return sample.used + extra
  }
  const deferred = (reason, until) => ({ provider: 'gemini', reason, retryAfterSeconds: Math.max(1, Math.ceil((until - now()) / 1000)) })
  return {
    reserve(estimate, outputBudget) {
      const time = advance()
      if (time < dailyUntil) return deferred('daily_quota_exhausted', dailyUntil)
      if (time < latchedUntil) return deferred('threshold_latched', latchedUntil)
      const fresh = sample && time - sample.observedAt <= maxAgeMs
      if (fresh && used() + estimate >= sample.limit * thresholdPercent / 100) {
        // A request too large for the remaining budget does not establish that
        // current usage has reached the threshold. Reevaluate smaller requests.
        return deferred('tpm_threshold', sample.resetAt)
      }
      if (!fresh) {
        // Serialize a real user request to learn headers; never send quota probes
        // in the background or assume this interval is the provider's window.
        if (time < nextProbeAt || [...ledger].some(ticket => !ticket.finished)) return deferred('quota_unknown_or_stale', Math.max(nextProbeAt, time + 1000))
        nextProbeAt = time + probeIntervalMs
      }
      const ticket = { issued: ++order, estimate, outputBudget, finished: 0, total: null, completion: null }
      ledger.add(ticket) // Synchronous reservation precedes network I/O.
      return { provider: 'groq', ticket, reason: fresh ? 'quota_available' : 'serialized_quota_probe' }
    },
    observe(ticket, headers) {
      const time = advance()
      const { tokensPerMinuteLimit: limit, tokensPerMinuteRemaining: remaining, tokensResetSeconds: reset, dailyRequestsRemaining, dailyRequestsResetSeconds } = rateHeaders(headers)
      if (dailyRequestsRemaining === 0) {
        // The request counter is daily. A TPM reset cannot clear this hold.
        // Missing daily reset data uses the existing conservative daily retry
        // policy; it is not evidence of an actual midnight/reset time.
        dailyUntil = Math.max(dailyUntil, time + (dailyRequestsResetSeconds ?? 86400) * 1000)
      }
      if (!(limit > 0 && remaining >= 0 && remaining <= limit && reset > 0 && reset <= 3600)) return
      // Ignore late responses from requests older than our current snapshot.
      if (sample && ticket.issued < sample.ticket.issued) return
      const resetAt = time + reset * 1000
      sample = { ticket, limit, used: Math.max(limit - remaining, sample?.used ?? 0), resetAt, observedAt: time }
      for (const previous of ledger) if (previous !== ticket && previous.finished && previous.finished < ticket.issued) ledger.delete(previous)
      if (latchedUntil) latchedUntil = Math.max(latchedUntil, resetAt)
      if (used() >= limit * thresholdPercent / 100) latchedUntil = Math.max(latchedUntil, resetAt)
    },
    finish(ticket, usage) {
      if (!ticket) return
      ticket.finished = ++order
      ticket.total = number(usage?.totalTokens)
      // Completion tokens already include reasoning; never add them twice.
      ticket.completion = number(usage?.completionTokens)
      if (!sample) ledger.delete(ticket)
      else if (used() >= sample.limit * thresholdPercent / 100) latchedUntil = Math.max(latchedUntil, sample.resetAt)
    },
  }
}
