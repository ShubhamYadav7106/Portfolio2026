import Groq from 'groq-sdk'
import { loadServerConfig } from './config.js'
import { createApp } from './app.js'

const config = loadServerConfig()
const makeProvider = apiKey => apiKey ? new Groq({ apiKey, timeout: config.timeoutMs, maxRetries: 0 }) : null
const groqRecruiter = makeProvider(config.recruiterApiKey)
const groqGeneral = makeProvider(config.generalApiKey)
const groqFallback = makeProvider(config.fallbackApiKey)
const app = createApp({ config, groqRecruiter, groqGeneral, groqFallback,
  onProviderError: (code, details) => console.warn(`Ask Shubham AI: ${code}`, details),
  onRecruiterMetrics: details => console.info('Ask Shubham AI recruiter metrics:', details),
})
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Ask Shubham AI local API: http://127.0.0.1:${config.port}`)
  if (!config.recruiterApiKey) console.log('Recruiter Mode is not configured. Set GROQ_RECRUITER_API_KEY in server/.env.')
  if (!config.generalApiKey) console.log('General AI Mode is not configured. Set GROQ_GENERAL_API_KEY in server/.env.')
})
server.headersTimeout = 10000
server.requestTimeout = 10000
function shutdown() {
  server.close()
  server.closeIdleConnections()
  setTimeout(() => server.closeAllConnections(), config.timeoutMs + 1000).unref()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
