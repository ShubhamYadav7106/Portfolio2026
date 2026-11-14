import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'

// A fixed path prevents accidentally loading a frontend/root .env file.
export function loadServerConfig() {
  loadEnv({ path: fileURLToPath(new URL('./.env', import.meta.url)), quiet: true })
  return readConfig(process.env)
}

export function readConfig(env = {}) {
  function integer(name, fallback, min, max) {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name])
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid server setting: ${name}`)
    return value
  }
  const origins = (env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(value => value.trim()).filter(Boolean)
  for (const origin of origins) {
    let url
    try { url = new URL(origin) } catch { throw new Error('Invalid ALLOWED_ORIGINS') }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('ALLOWED_ORIGINS must contain exact local origins')
  }
  const model = (env.GROQ_MODEL || 'openai/gpt-oss-20b').trim()
  if (!/^[a-zA-Z0-9][\w./-]{0,127}$/.test(model)) throw new Error('Invalid GROQ_MODEL')
  return {
    fallbackApiKey: (env.GROQ_FALLBACK_API_KEY || '').trim(),
    recruiterApiKey: (env.GROQ_RECRUITER_API_KEY || '').trim(),
    generalApiKey: (env.GROQ_GENERAL_API_KEY || '').trim(), model, origins,
    recruiterTpmThresholdPercent: integer('GROQ_RECRUITER_TPM_THRESHOLD_PERCENT', 85, 1, 100),
    recruiterQuotaMaxAgeMs: integer('GROQ_RECRUITER_QUOTA_MAX_AGE_MS', 15000, 1000, 120000),
    recruiterQuotaProbeMs: integer('GROQ_RECRUITER_QUOTA_PROBE_MS', 60000, 1000, 3600000),
    port: integer('PORT', 3001, 1, 65535),
    timeoutMs: integer('REQUEST_TIMEOUT_MS', 60000, 1000, 120000),
    rateLimitWindowMs: integer('RATE_LIMIT_WINDOW_MS', 60000, 1000, 3600000),
    rateLimitMax: integer('RATE_LIMIT_MAX', 20, 1, 1000),
    maxConcurrent: integer('MAX_CONCURRENT_REQUESTS', 4, 1, 20),
    maxCompletionTokens: integer('MAX_COMPLETION_TOKENS', 2048, 256, 4096),
  }
}
