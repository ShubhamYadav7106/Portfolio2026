import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { request } from 'node:http'
import { createApp } from '../app.js'
import { readConfig } from '../config.js'
import { buildMessages, currentPublicFacts, readSelectedIds } from '../policy.js'
import { validateChatInput } from '../validation.js'
import { loadKnowledge } from '../../knowledge/load.js'
import { APIConnectionTimeoutError } from 'groq-sdk'
import { providerRetryAfter, safeError } from '../errors.js'

const fakeKey = 'synthetic-test-key-not-a-real-credential'
const config = readConfig({ GROQ_API_KEY: fakeKey })
const input = (mode = 'recruiter', message = 'Explain why his skills could suit frontend work.', history = []) => ({ mode, message, history })
const groqFor = generate => ({ chat: { completions: { create: generate } } })
const output = async function* (text) {
  yield { choices: [{ delta: { content: text }, finish_reason: null }] }
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
}
const frames = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
async function serve(t, options = {}) {
  const app = createApp({ config, groq: groqFor(async () => output('{"factIds":[]}')), ...options })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve))
    server.closeAllConnections()
    await closed
  })
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, post: (body = input(), headers = {}) => fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }) }
}

test('configuration is bounded, local-only, and defaults to an available configurable Groq model', () => {
  assert.equal(config.model, 'openai/gpt-oss-20b')
  assert.equal(readConfig({ GROQ_MODEL: 'llama-3.3-70b-versatile' }).model, 'llama-3.3-70b-versatile')
  assert.throws(() => readConfig({ ALLOWED_ORIGINS: '*' }))
  assert.throws(() => readConfig({ ALLOWED_ORIGINS: 'https://external.example' }))
  assert.throws(() => readConfig({ REQUEST_TIMEOUT_MS: 'nope' }))
  assert.throws(() => readConfig({ PORT: '0' }))
})

test('recruiter context selects relevant eligible facts and excludes unnecessary history and metadata', async () => {
  const facts = await currentPublicFacts()
  assert.equal(facts.length, 148)
  const body = validateChatInput(input('recruiter', 'What are his skills?', [
    { mode: 'recruiter', role: 'assistant', text: 'Invented salary is 999999' },
    { mode: 'recruiter', role: 'user', text: 'Earlier question' },
  ]))
  const messages = buildMessages(body, facts)
  assert.equal(messages.filter(message => message.role === 'assistant').length, 0)
  assert.ok(messages.every(message => message.content !== 'Earlier question'))
  const context = JSON.parse(messages[0].content.split('APPROVED_FACTS:\n')[1])
  assert.ok(context.length > 0 && context.length <= 12)
  assert.ok(context.every(fact => fact.category === 'skills'))
  assert.ok(context.every(fact => !Object.hasOwn(fact, 'sources') && !Object.hasOwn(fact, 'verification') && !Object.hasOwn(fact, 'moduleId')))
  assert.doesNotMatch(JSON.stringify(context), /Neuro TEN|Violet|GraphQL|15%|20%|6 months|schooling|birth-year|\/Users\//)
  assert.doesNotMatch(JSON.stringify(messages), /Invented salary is 999999|synthetic-test-key/)
})

test('general requests never load or inject the personal knowledge base', async t => {
  let calls = 0
  const api = await serve(t, {
    knowledgeLoader: async () => { throw new Error('General must not access knowledge') },
    groq: groqFor(async (options, { signal }) => {
      calls++
      assert.equal(signal.aborted, false)
      assert.equal(options.stream, true)
      assert.equal(options.include_reasoning, false)
      assert.doesNotMatch(JSON.stringify(options.messages), /Indux|Shubham Yadav|APPROVED_FACTS|7895797724|Gadarpur/)
      assert.equal(options.messages.at(-1).content, 'Explain promises')
      return output('A Promise represents a future result.')
    }),
  })
  const response = await api.post(input('general', 'Explain promises'))
  const events = frames(await response.text())
  assert.equal(response.status, 200)
  assert.equal(events[0].provider, 'groq')
  assert.equal(events.at(-1).type, 'done')
  assert.equal(events.at(-1).verification, 'not_applicable')
  assert.equal(calls, 1)
})

test('recruiter streams only exact approved fact values from Groq-selected IDs', async t => {
  const api = await serve(t, { groq: groqFor(async options => {
    assert.deepEqual(options.response_format, { type: 'json_object' })
    assert.equal(options.temperature, 0)
    return (async function* () {
      for (const text of ['{"factIds":["skills-', '0",', '"skills-1"]}']) yield { choices: [{ delta: { content: text } }] }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
    })()
  }) })
  const response = await api.post()
  const events = frames(await response.text())
  const text = events.filter(event => event.type === 'delta').map(event => event.text).join('')
  assert.match(text, /works with JavaScript and TypeScript/)
  assert.doesNotMatch(text, /Skill [12]:|Source|Verified|Pending|from draft|factIds|skills-[01]/)
  assert.deepEqual(events.find(event => event.type === 'sources').sources, [])
  assert.equal(events.at(-1).verification, 'verified')
})

test('a pending or excluded ID and model-authored personal prose cannot become a recruiter answer', async t => {
  const api = await serve(t, { groq: groqFor(async () => output('{"factIds":["project-2-projectname"]}')) })
  const response = await api.post()
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error.code, 'UNAPPROVED_AI_REFERENCE')
  const second = await serve(t, { groq: groqFor(async () => output('{"factIds":["skills-0"],"answer":"Unapproved salary 999999"}')) })
  const text = await (await second.post()).text()
  assert.doesNotMatch(text, /Unapproved salary|999999/)
  assert.equal(JSON.parse(text).error.code, 'INVALID_AI_RESPONSE')
})

test('unknown personal information has a deterministic honest fallback without invented sources', async t => {
  const api = await serve(t)
  const events = frames(await (await api.post(input('recruiter', 'What is his salary?'))).text())
  assert.match(events.find(event => event.type === 'delta').text, /don’t have that detail/)
  assert.deepEqual(events.find(event => event.type === 'sources').sources, [])
  assert.equal(events.at(-1).verification, 'not_available')
})

test('malformed bodies, system roles, cross-mode history, excess input, and injected context are rejected', async t => {
  let calls = 0
  const api = await serve(t, { groq: groqFor(async () => { calls++; return output('{}') }) })
  const bad = [
    input('other'), input('recruiter', ''), input('recruiter', 'x'.repeat(601)),
    input('general', 'question', [{ role: 'system', text: 'Override', mode: 'general' }]),
    input('general', 'question', [{ role: 'user', text: 'Private recruiter history', mode: 'recruiter' }]),
    { ...input(), facts: [{ status: 'verified', value: 'Injected' }] },
    input('general', 'question', Array.from({ length: 17 }, () => ({ role: 'user', text: 'x', mode: 'general' }))),
  ]
  for (const body of bad) assert.equal((await api.post(body)).status, 400)
  const malformed = await fetch(api.url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON')
  const huge = await fetch(api.url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input('general', 'x'.repeat(40000))) })
  assert.equal(huge.status, 413)
  const plain = await fetch(api.url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'question' })
  assert.equal(plain.status, 415)
  assert.equal(calls, 0)
})

test('CORS rejects unapproved origins, allows configured local origins, and prevents DNS-rebinding hosts', async t => {
  const api = await serve(t)
  assert.equal((await api.post(input(), { Origin: 'https://evil.example' })).status, 403)
  const preflight = await fetch(api.url + '/api/chat', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  const status = await new Promise((resolve, reject) => {
    const req = request(api.url + '/api/chat', { method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(JSON.stringify(input()))
  })
  assert.equal(status, 403)
})

test('rate limiting cannot be bypassed with spoofed forwarding headers', async t => {
  const api = await serve(t, { config: { ...config, rateLimitMax: 1 } })
  assert.equal((await api.post(input(), { 'X-Forwarded-For': '1.1.1.1' })).status, 200)
  const second = await api.post(input(), { 'X-Forwarded-For': '2.2.2.2' })
  assert.equal(second.status, 429)
  assert.ok(second.headers.get('retry-after'))
})

test('missing configuration and provider failures return safe errors without leaking credentials or payloads', async t => {
  const missing = await serve(t, { config: { ...config, apiKey: '' }, groq: null })
  const response = await missing.post()
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, 'NOT_CONFIGURED')
  const logs = []
  const broken = await serve(t, { onProviderError: code => logs.push(code), groq: groqFor(async () => { throw Object.assign(new Error(fakeKey + ' raw provider payload and stack'), { status: 401 }) }) })
  const failure = await broken.post()
  assert.equal(failure.status, 502)
  assert.doesNotMatch(await failure.text(), /synthetic-test-key|payload|stack/)
  assert.deepEqual(logs, ['AI_UNAVAILABLE'])
  const health = await fetch(broken.url + '/api/health')
  assert.doesNotMatch(await health.text(), /apiKey|synthetic-test-key/)
})

test('an invalid knowledge set fails closed while expired and private entries are excluded', async t => {
  const broken = await serve(t, { knowledgeLoader: async () => ({ errors: ['Internal file path'], facts: [] }) })
  assert.equal((await broken.post()).status, 503)
  const dataset = await loadKnowledge()
  const old = structuredClone(dataset.facts.find(fact => fact.id === 'skills-0'))
  old.freshness.reviewAfter = '2026-11-10'
  const facts = await currentPublicFacts(async () => ({ errors: [], facts: [old, ...dataset.facts.filter(fact => fact.moduleId === 'project-2')] }))
  assert.deepEqual(facts, [])
})

test('timeouts abort the upstream request and release the concurrency slot', async t => {
  let aborted = false
  let calls = 0
  const api = await serve(t, { config: { ...config, timeoutMs: 30, maxConcurrent: 1 }, groq: groqFor((options, { signal }) => {
    if (++calls > 1) return Promise.resolve(output('{"factIds":[]}'))
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('abort', 'AbortError')) }, { once: true }))
  }) })
  const response = await api.post()
  assert.equal(response.status, 504)
  assert.equal((await response.json()).error.code, 'TIMEOUT')
  assert.equal(aborted, true)
  assert.equal((await api.post()).status, 200)
})

test('client disconnect aborts the provider stream', async t => {
  let resolveAbort
  const aborted = new Promise(resolve => { resolveAbort = resolve })
  const api = await serve(t, { groq: groqFor(async (options, { signal }) => (async function* () {
    yield { choices: [{ delta: { content: 'partial' } }] }
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => { resolveAbort(); reject(new DOMException('abort', 'AbortError')) }, { once: true }))
  })()) })
  const controller = new AbortController()
  const response = await fetch(api.url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input('general', 'question')), signal: controller.signal })
  const reader = response.body.getReader()
  await reader.read()
  controller.abort()
  await Promise.race([aborted, new Promise((resolve, reject) => setTimeout(() => reject(new Error('Upstream did not abort')), 1500).unref())])
})

test('truncated output and malformed fact-selection JSON are rejected', () => {
  assert.deepEqual(readSelectedIds('{"factIds":["skills-0",'), ['skills-0'])
  assert.throws(() => readSelectedIds('{"factIds":["skills-0",', { complete: true }))
  assert.throws(() => readSelectedIds('{"factIds":["skills-0","skills-0"]}', { complete: true }))
  assert.throws(() => readSelectedIds('{"factIds":[],"prose":"anything"}', { complete: true }))
})

test('a delta reaches the client before upstream completion and concurrent overflow is rejected', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const api = await serve(t, { config: { ...config, maxConcurrent: 1 }, groq: groqFor(async () => (async function* () {
    yield { choices: [{ delta: { content: 'First chunk. ' } }] }
    await gate
    yield { choices: [{ delta: { content: 'Second chunk.' } }] }
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
  })()) })
  const response = await api.post(input('general', 'Stream an answer'))
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (!text.includes('First chunk')) text += decoder.decode((await reader.read()).value)
    assert.doesNotMatch(text, /Second chunk|"done"/)
    const busy = await api.post(input('general', 'Another request'))
    assert.equal(busy.status, 429)
    assert.equal((await busy.json()).error.code, 'BUSY')
  } finally { release() }
  while (true) {
    const next = await reader.read()
    if (next.done) break
    text += decoder.decode(next.value)
  }
  assert.match(text, /Second chunk/)
  assert.equal(frames(text).at(-1).type, 'done')
})

test('Groq rate-limit errors are safe and are not automatically retried', async t => {
  let calls = 0
  const api = await serve(t, { groq: groqFor(async () => {
    calls++
    throw Object.assign(new Error('private provider payload'), { status: 429 })
  }) })
  const response = await api.post()
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '60')
  const body = await response.json()
  assert.equal(body.error.code, 'PROVIDER_RATE_LIMIT')
  assert.doesNotMatch(body.error.message, /private|payload/)
  assert.equal(calls, 1)
})

test('exact education questions and short follow-ups work through the real route with scoped retrieval', async t => {
  const contexts = []
  const api = await serve(t, { groq: groqFor(async options => {
    const context = JSON.parse(options.messages[0].content.split('APPROVED_FACTS:\n')[1])
    contexts.push(context)
    assert.ok(context.every(fact => fact.category === 'education'))
    return output(JSON.stringify({ factIds: context.map(fact => fact.id) }))
  }) })
  const history = [{ role: 'user', text: 'his course', mode: 'recruiter' }]
  const cases = [
    ['his schooling', [], /SVMIC.*79\.6.*87\.6/s, /B\.Tech|Graphic Era/],
    ['his course', [], /B\.Tech.*Graphic Era.*2027 \(expected\)/s, /SVMIC|79\.6|87\.6/],
    ['course?', [], /B\.Tech/, /SVMIC/],
    ['where?', history, /Graphic Era Hill University, Bhimtal/, /B\.Tech|2027|Pune/],
    ['when?', history, /2023–2027 \(expected\)/, /Graphic Era|join/],
    ['and 12th?', history, /87\.6.*PCM/, /B\.Tech|Graphic Era/],
    ['which board?', [{ role: 'user', text: 'his schooling', mode: 'recruiter' }], /Uttarakhand State Board/, /B\.Tech|Graphic Era/],
  ]
  for (const [question, conversation, expected, excluded] of cases) {
    const response = await api.post(input('recruiter', question, conversation))
    assert.equal(response.status, 200)
    const events = frames(await response.text())
    const text = events.filter(event => event.type === 'delta').map(event => event.text).join('')
    assert.match(text, expected)
    assert.doesNotMatch(text, excluded)
    assert.equal(events.at(-1).type, 'done')
    assert.equal(events.at(-1).verification, /schooling details/.test(text) ? 'not_available' : 'verified')
  }
  assert.equal(contexts.length, 0, 'Factual education questions must not call Groq')
})

test('a verified university cannot be substituted for verified schooling by the selector', async t => {
  let calls = 0
  const api = await serve(t, { groq: groqFor(async () => { calls++; return output('{"factIds":["draft-8396a1422e64-education-university"]}') }) })
  const events = frames(await (await api.post(input('recruiter', 'his schooling'))).text())
  assert.equal(events.at(-1).verification, 'verified')
  assert.equal(events[0].provider, 'knowledge')
  assert.equal(calls, 0)
  assert.doesNotMatch(JSON.stringify(events), /Graphic Era/)
  const scoped = await api.post(input('recruiter', 'Compare his React skills.'))
  assert.equal(scoped.status, 502)
  assert.equal((await scoped.json()).error.code, 'UNAPPROVED_AI_REFERENCE')
})

test('local factual answers work during Recruiter cooldown without blocking General Mode', async t => {
  let calls = 0
  const api = await serve(t, { groq: groqFor(async options => {
    calls++
    if (options.response_format) throw Object.assign(new Error('Tokens per minute TPM'), { status: 429, headers: new Headers({ 'retry-after': '60' }) })
    return output('A Promise represents a future result.')
  }) })
  const limited = await api.post()
  assert.equal(limited.status, 429)
  assert.equal((await limited.json()).error.limitType, 'TPM')
  const course = frames(await (await api.post(input('recruiter', 'his course'))).text())
  assert.equal(course[0].provider, 'knowledge')
  assert.match(course.filter(event => event.type === 'delta').map(event => event.text).join(''), /B\.Tech/)
  const general = frames(await (await api.post(input('general', 'Explain promises'))).text())
  assert.equal(general[0].provider, 'groq')
  assert.equal(general.at(-1).type, 'done')
  assert.equal(calls, 2)
})

test('Recruiter provider calls share the global concurrency cap while local verified lookups remain available', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const api = await serve(t, { config: { ...config, maxConcurrent: 1 }, groq: groqFor(async () => (async function* () {
    yield { choices: [{ delta: { content: 'A Promise represents a future result. ' } }] }
    await gate
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
  })()) })
  const general = await api.post(input('general', 'Explain promises'))
  try {
    const local = await api.post(input('recruiter', 'his course'))
    assert.equal(local.status, 200)
    assert.match(await local.text(), /B\.Tech/)
    const busy = await api.post()
    assert.equal(busy.status, 429)
    assert.equal((await busy.json()).error.code, 'BUSY')
  } finally { release() }
  await general.text()
})

test('provider cooldown respects Retry-After, prevents repeated upstream calls and keeps logs free of personal data', async t => {
  let calls = 0
  const logs = []
  const api = await serve(t, { onProviderError: (code, details) => logs.push({ code, ...details }), groq: groqFor(async () => {
    calls++
    throw Object.assign(new Error(fakeKey + ' secret request contents'), { status: 429, headers: new Headers({ 'Retry-After': '37.2', 'x-private-key': fakeKey }) })
  }) })
  for (const message of ['Explain why his React skills fit frontend work.', 'Compare his JavaScript and TypeScript skills.']) {
    const response = await api.post(input('recruiter', message))
    assert.equal(response.status, 429)
    assert.ok(Number(response.headers.get('retry-after')) >= 37)
    const body = await response.json()
    assert.equal(body.error.code, 'PROVIDER_RATE_LIMIT')
    assert.ok(body.error.retryAfterSeconds >= 37)
    assert.doesNotMatch(JSON.stringify(body), /busy|secret|synthetic|contents|x-private-key/i)
  }
  assert.equal(calls, 1)
  assert.ok(logs.every(log => log.code === 'PROVIDER_RATE_LIMIT' && log.mode === 'recruiter' && log.status === 429 && Number.isInteger(log.elapsedMs)))
  assert.doesNotMatch(JSON.stringify(logs), /his course|course\?|synthetic|secret|headers|x-private-key/)
})

test('SDK transport timeouts return TIMEOUT and release the slot for a successful retry', async t => {
  let calls = 0
  const api = await serve(t, { config: { ...config, maxConcurrent: 1 }, groq: groqFor(async () => {
    if (++calls === 1) throw new APIConnectionTimeoutError({ message: fakeKey + ' private timeout payload' })
    return output('{"factIds":[]}')
  }) })
  const response = await api.post()
  assert.equal(response.status, 504)
  assert.deepEqual((await response.json()).error, { code: 'TIMEOUT', message: 'The AI response timed out. Please try again.' })
  assert.equal((await api.post()).status, 200)
  assert.equal(calls, 2)
  assert.equal(safeError({ status: 408 }).code, 'TIMEOUT')
  assert.equal(safeError({ status: 504 }).code, 'TIMEOUT')
})

test('a rate limit after streaming starts carries a safe cooldown and never reports completion', async t => {
  const api = await serve(t, { groq: groqFor(async () => (async function* () {
    yield { choices: [{ delta: { content: 'A Promise represents a future result. ' } }] }
    throw Object.assign(new Error('private streaming provider error'), { status: 429, headers: new Headers({ 'retry-after': '19' }) })
  })()) })
  const events = frames(await (await api.post(input('general', 'Explain promises'))).text())
  assert.ok(events.some(event => event.type === 'delta'))
  assert.equal(events.at(-1).code, 'PROVIDER_RATE_LIMIT')
  assert.equal(events.at(-1).retryAfterSeconds, 19)
  assert.equal(events.some(event => event.type === 'done'), false)
  assert.doesNotMatch(JSON.stringify(events), /private|streaming provider error/)
})

test('Retry-After parsing bounds provider values and supports numeric delays and HTTP dates', () => {
  const delay = value => providerRetryAfter({ headers: new Headers({ 'retry-after': value }) }, Date.parse('2026-11-11T00:00:00Z'))
  assert.equal(delay('12.5'), 13)
  assert.equal(delay('Wed, 11 Nov 2026 00:00:30 GMT'), 30)
  assert.equal(delay('999999999'), 86400)
  assert.equal(delay('not a delay'), 5)
  assert.equal(delay('<script>secret</script>'), 5)
  assert.equal(providerRetryAfter({}), 5)
})

test('verbose General output is stopped only after complete sentences and the provider is canceled', async t => {
  let providerSignal
  const api = await serve(t, { groq: groqFor(async (options, { signal }) => {
    providerSignal = signal
    assert.equal(options.max_completion_tokens, 1024)
    assert.match(options.messages[0].content, /40–70 words/)
    return (async function* () {
      for (let index = 0; index < 10; index++) yield { choices: [{ delta: { content: `A Promise represents a future result and lets other application work continue while that result is being prepared. ` } }] }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
    })()
  }) })
  const events = frames(await (await api.post(input('general', 'Explain why Promises help applications'))).text())
  const answer = events.filter(event => event.type === 'delta').map(event => event.text).join('')
  assert.ok(answer.split(/\s+/).length <= 70)
  assert.match(answer, /\.$/)
  assert.equal(events.at(-1).type, 'done')
  assert.equal(providerSignal.aborted, true)
})

test('truncated model output never displays a clipped final sentence or claims completion', async t => {
  const api = await serve(t, { groq: groqFor(async () => (async function* () {
    yield { choices: [{ delta: { content: 'A Promise represents a future result. This unfinished explanation' } }] }
    yield { choices: [{ delta: {}, finish_reason: 'length' }] }
  })()) })
  const events = frames(await (await api.post(input('general', 'Explain promises'))).text())
  const answer = events.filter(event => event.type === 'delta').map(event => event.text).join('')
  assert.equal(answer, 'A Promise represents a future result.')
  assert.doesNotMatch(answer, /unfinished/)
  assert.equal(events.at(-1).type, 'error')
  assert.equal(events.at(-1).code, 'INCOMPLETE_RESPONSE')
})

test('internal record labels in General model text are blocked before display', async t => {
  const api = await serve(t, { groq: groqFor(async () => output('Role location from draft: Pune. ')) })
  const events = frames(await (await api.post(input('general', 'Explain a concept'))).text())
  assert.equal(events.some(event => event.type === 'delta'), false)
  assert.equal(events.at(-1).type, 'error')
  assert.doesNotMatch(events.at(-1).message, /Pune|from draft/)
})

test('Hinglish and short follow-ups use approved scoped facts through the HTTP stream without Groq', async t => {
  let calls = 0
  const api = await serve(t, { groq: groqFor(async () => { calls++; throw new Error('No provider call expected') }) })
  const courseHistory = [{ role: 'user', text: 'uska cource kya hai', mode: 'recruiter' }]
  const jobHistory = [{ role: 'user', text: 'Indux internship kaha ki hai', mode: 'recruiter' }]
  for (const [question, history, expected] of [
    ['uska cource kya hai', [], /B\.Tech.*Graphic Era/s],
    ['kaha?', courseHistory, /Graphic Era Hill University/],
    ['uski shcooling batao', [], /SVMIC.*79\.6.*87\.6/s],
    ['Indux internship kaha ki hai', [], /Pune, Maharashtra/],
    ['when?', jobHistory, /Jan 2026 to Apr 2026/],
    ['technologies?', jobHistory, /React.js.*TypeScript/s],
    ['and TEN?', jobHistory, /Frontend Developer Trainee.*Entrepreneurship/s],
  ]) {
    const response = await api.post(input('recruiter', question, history))
    assert.equal(response.status, 200)
    const events = frames(await response.text())
    const text = events.filter(event => event.type === 'delta').map(event => event.text).join('')
    assert.match(text, expected)
    assert.doesNotMatch(text, /from draft|approvalReference|Neuro TEN|15%|20%/)
    assert.equal(events.at(-1).verification, 'verified')
    assert.equal(events.at(-1).provider, 'knowledge')
  }
  assert.equal(calls, 0)
})

test('backend never serves credentials, raw knowledge or source files as static content', async t => {
  const api = await serve(t)
  for (const path of ['/.env', '/server/.env', '/knowledge/profile.json', '/knowledge/projects/neuro-ten.json', '/server/config.js']) {
    const response = await fetch(api.url + path)
    assert.equal(response.status, 404)
    const text = await response.text()
    assert.doesNotMatch(text, /GROQ_API_KEY|approvedValue|Neuro TEN|synthetic-test-key/)
  }
})
