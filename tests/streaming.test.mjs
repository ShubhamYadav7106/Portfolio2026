import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { streamChat, ChatServiceError } from '../src/services/assistant/streamResponder.js'

const start = { type: 'start', provider: 'groq', mode: 'general' }
const done = { type: 'done', provider: 'groq', mode: 'general', verification: 'not_applicable' }
const responseFor = events => new Response(events.map(event => JSON.stringify(event) + '\n').join(''), { headers: { 'Content-Type': 'application/x-ndjson' } })

test('NDJSON deltas survive arbitrary byte boundaries and UTF-8 splits', async () => {
  const bytes = new TextEncoder().encode([start, { type: 'delta', text: 'Hello 👋' }, done].map(event => JSON.stringify(event) + '\n').join(''))
  let index = 0
  const deltas = []
  const reply = await streamChat('hello', { mode: 'general', onDelta: text => deltas.push(text), fetchImpl: async () => new Response(new ReadableStream({ pull(controller) {
    if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index))
    else controller.close()
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } }) })
  assert.equal(reply.text, 'Hello 👋')
  assert.deepEqual(deltas, ['Hello 👋'])
  assert.equal(reply.provider, 'groq')
})

test('the frontend sends a bounded same-mode history to its local endpoint without credentials', async () => {
  const history = [{ role: 'user', text: 'Other mode data', mode: 'recruiter' }, ...Array.from({ length: 20 }, () => ({ role: 'assistant', text: '文'.repeat(7000), mode: 'general' }))]
  await streamChat('question', { mode: 'general', history, fetchImpl: async (url, options) => {
    assert.equal(url, '/api/chat')
    assert.equal(options.credentials, 'omit')
    assert.deepEqual(Object.keys(options.headers), ['Content-Type', 'Accept'])
    assert.equal(options.headers.Accept, 'application/x-ndjson')
    const body = JSON.parse(options.body)
    assert.ok(body.history.length <= 16)
    assert.ok(body.history.every(item => item.mode === 'general' && !item.text.includes('Other mode')))
    assert.ok(body.history.reduce((sum, item) => sum + item.text.length, 0) <= 16000)
    assert.ok(new TextEncoder().encode(options.body).length < 32000)
    return responseFor([start, { type: 'delta', text: 'Answer' }, done])
  } })
})

test('backend configuration and network errors never silently become mock answers', async () => {
  await assert.rejects(streamChat('question', { fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'NOT_CONFIGURED', message: 'RAW INTERNAL SECRET' } }), { status: 503 }) }), error => error instanceof ChatServiceError && error.code === 'NOT_CONFIGURED' && !error.message.includes('SECRET'))
  await assert.rejects(streamChat('question', { fetchImpl: async () => { throw new Error('RAW INTERNAL SECRET') } }), error => error instanceof ChatServiceError && !error.message.includes('SECRET'))
})

test('incomplete streams and post-header errors do not become successful replies', async () => {
  await assert.rejects(streamChat('question', { mode: 'general', fetchImpl: async () => responseFor([start, { type: 'delta', text: 'Partial' }]) }), { code: 'INCOMPLETE_RESPONSE' })
  await assert.rejects(streamChat('question', { mode: 'general', fetchImpl: async () => responseFor([start, { type: 'delta', text: 'Partial' }, { type: 'error', code: 'TIMEOUT', message: 'internal detail' }]) }), { code: 'TIMEOUT' })
})

test('provider limits display safe retry timing and stay distinct from local overload and timeouts', async () => {
  const limited = async () => new Response(JSON.stringify({ error: { code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds: 38, message: 'secret provider details' } }), { status: 429 })
  await assert.rejects(streamChat('his course', { fetchImpl: limited }), error => {
    assert.equal(error.code, 'PROVIDER_RATE_LIMIT')
    assert.equal(error.retryAfterSeconds, 38)
    assert.match(error.userMessage, /Groq.*retry in 38 seconds/)
    assert.doesNotMatch(error.userMessage, /busy|secret|provider details/i)
    return true
  })
  const streamed = responseFor([start, { type: 'delta', text: 'Partial.' }, { type: 'error', code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds: 19, message: 'secret' }])
  await assert.rejects(streamChat('Explain promises', { mode: 'general', fetchImpl: async () => streamed }), error => error.code === 'PROVIDER_RATE_LIMIT' && error.retryAfterSeconds === 19)
  assert.match(new ChatServiceError('BUSY').userMessage, /Too many active AI responses/)
  assert.match(new ChatServiceError('TIMEOUT').userMessage, /timed out/)
  assert.doesNotMatch(new ChatServiceError('PROVIDER_RATE_LIMIT', Infinity).userMessage, /Infinity/)
  assert.doesNotMatch(new ChatServiceError('PROVIDER_RATE_LIMIT', '<script>secret</script>').userMessage, /script|secret/)
})

test('invalid stream ordering, incorrect modes, and unsafe source links are rejected', async () => {
  await assert.rejects(streamChat('question', { mode: 'general', fetchImpl: async () => responseFor([{ type: 'delta', text: 'Unframed' }]) }), { code: 'INVALID_STREAM' })
  await assert.rejects(streamChat('question', { mode: 'general', fetchImpl: async () => responseFor([{ ...start, mode: 'recruiter' }]) }), { code: 'INVALID_STREAM' })
  await assert.rejects(streamChat('question', { mode: 'general', fetchImpl: async () => responseFor([start, { type: 'sources', sources: [{ id: 'x', label: 'x', href: 'javascript:alert(1)', status: 'verified' }] }]) }), { code: 'INVALID_STREAM' })
})

test('local factual answers are explicitly labeled knowledge only in Recruiter Mode', async () => {
  const events = [
    { type: 'start', provider: 'knowledge', mode: 'recruiter' },
    { type: 'delta', text: 'Shubham is open to relocation across India.' },
    { type: 'done', provider: 'knowledge', mode: 'recruiter', verification: 'verified' },
  ]
  const reply = await streamChat('Can he relocate?', { mode: 'recruiter', fetchImpl: async () => responseFor(events) })
  assert.equal(reply.provider, 'knowledge')
  await assert.rejects(streamChat('question', { mode: 'general', fetchImpl: async () => responseFor(events.map(event => ({ ...event, mode: 'general' }))) }), { code: 'INVALID_STREAM' })
  await assert.rejects(streamChat('question', { mode: 'recruiter', fetchImpl: async () => responseFor(events.map(event => event.type === 'done' ? { ...event, provider: 'groq' } : event)) }), { code: 'INVALID_STREAM' })
})

test('Recruiter errors distinguish RPM, TPM and daily quotas without changing General errors', async () => {
  for (const [limitType, expected] of [['RPM', /per-minute request/], ['TPM', /per-minute token/], ['RPD', /daily request/], ['TPD', /daily token/]]) {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds: 60, limitType } }), { status: 429 })
    await assert.rejects(streamChat('question', { mode: 'recruiter', fetchImpl }), error => expected.test(error.message))
    await assert.rejects(streamChat('question', { mode: 'general', fetchImpl }), error => /request or token limit/.test(error.message))
  }
  assert.doesNotMatch(new ChatServiceError('PROVIDER_RATE_LIMIT', 60, 'toString').message, /function|native code/)
  assert.doesNotMatch(new ChatServiceError('PROVIDER_RATE_LIMIT', 60, '__proto__').message, /Object/)
})

test('stop propagates to fetch and a client timeout has a safe distinct error', async () => {
  const controller = new AbortController()
  let upstreamSignal
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    upstreamSignal = signal
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })
  const response = streamChat('question', { signal: controller.signal, fetchImpl })
  controller.abort()
  await assert.rejects(response, { name: 'AbortError' })
  assert.equal(upstreamSignal.aborted, true)
  await assert.rejects(streamChat('question', { timeoutMs: 5, fetchImpl }), { code: 'TIMEOUT' })
})

test('frontend always uses the backend, including development with the old mock flag', async () => {
  for (const [development, flag] of [[true, false], [true, true], [false, true]]) {
    const result = await build({
      entryPoints: ['src/services/assistant/chatProvider.js'], bundle: true, write: false, format: 'esm', platform: 'node',
      define: { 'import.meta.env.DEV': String(development), 'import.meta.env.VITE_CHAT_MOCK': JSON.stringify(String(flag)) },

    })
    const provider = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
    let calls = 0
    const reply = await provider.respondToChat('question', { mode: 'general', fetchImpl: async () => {
      calls++
      return responseFor([start, { type: 'delta', text: 'API stream' }, done])
    } })
    assert.equal(provider.isMockDevelopment, false)
    assert.equal(reply.provider, 'groq')
    assert.equal(calls, 1)
  }
})
