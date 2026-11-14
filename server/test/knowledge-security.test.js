import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { build } from 'esbuild'
import { createServer } from 'vite'
import { loadKnowledge, knowledgeRoot } from '../../knowledge/load.js'
import { isEligibleFact } from '../../knowledge/validation.js'
import { createApp } from '../app.js'
import { readConfig } from '../config.js'
import { currentPublicFacts, recruiterFactualAnswer } from '../policy.js'
import { createRecruiterService } from '../recruiter.js'

const root = new URL('../../', import.meta.url)
const input = message => ({ mode: 'recruiter', message, history: [] })

test('private storage preserves the approved dataset, file permissions and exact direct answers', async () => {
  const data = await loadKnowledge()
  assert.deepEqual(data.errors, [])
  const publicFacts = await currentPublicFacts()
  assert.deepEqual(publicFacts, data.facts.filter(fact => isEligibleFact(fact)))
  const mode = (await stat(knowledgeRoot())).mode & 0o777
  assert.equal(mode & 0o077, 0)
  assert.equal((await stat(new URL('index.json', knowledgeRoot()))).mode & 0o077, 0)
  const service = createRecruiterService({ config: readConfig(), groq: null })
  for (const message of ['Who is Shubham?', 'his course', 'his schooling', 'What are his technical skills?', 'When can he join?', 'Can he relocate?', 'How can I contact Shubham?', 'Where can I view the resume?', 'What projects has he worked on?']) {
    const expected = recruiterFactualAnswer(input(message), publicFacts)
    assert.ok(expected)
    assert.deepEqual(await service.respond(input(message)), expected)
  }
  assert.equal(service.statistics().providerCalls, 0)
})

test('public Worker export excludes all private/pending facts, review notes and presentation provenance', () => {
  const snapshot = JSON.parse(execFileSync(process.execPath, ['scripts/validate-knowledge.mjs', '--export-public'], { cwd: root, encoding: 'utf8' }))
  assert.deepEqual(Object.keys(snapshot.index).sort(), ['assistantName', 'modules', 'schemaVersion'])
  assert.ok(snapshot.modules.length)
  for (const module of snapshot.modules) {
    assert.deepEqual(module.presentation, [])
    assert.ok(module.facts.every(fact => isEligibleFact(fact)))
  }
})

test('frontend import graph has no knowledge data, server code or real-data mock dependency', async () => {
  for (const development of [true, false]) {
    const bundle = await build({ absWorkingDir: new URL('../../', import.meta.url).pathname, entryPoints: ['src/services/assistant/chatProvider.js'], bundle: true, write: false, metafile: true, format: 'esm', define: { 'import.meta.env.DEV': String(development), 'import.meta.env.VITE_CHAT_MOCK': '"true"' } })
    for (const file of Object.keys(bundle.metafile.inputs)) assert.doesNotMatch(file, /knowledge\/|server\/|mockResponder|knowledgeStore/)
  }
})

test('knowledge data cannot be tracked again through ordinary git add', async () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
  assert.ok(!tracked.some(path => path.startsWith('server/private/') || path.startsWith('knowledge/') && path.endsWith('.json') && path !== 'knowledge/schema.json'))
  const ignored = execFileSync('git', ['check-ignore', 'server/private/knowledge/index.json', 'knowledge/profile.json', 'server/.env'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
  assert.equal(ignored.length, 3)
  assert.ok(!(await readdir(new URL('../../knowledge/', import.meta.url))).includes('index.json'))
})

test('public backend exposes neither knowledge files nor restricted facts in chat/model context', async t => {
  const publicFacts = await currentPublicFacts()
  const data = await loadKnowledge()
  let calls = 0
  const app = createApp({ config: readConfig({ GROQ_RECRUITER_API_KEY: 'synthetic' }), knowledgeLoader: async () => data,
    groqRecruiter: { chat: { completions: { create(body) {
      calls++
      const context = JSON.parse(body.messages[0].content.split('APPROVED_FACTS:\n')[1])
      for (const item of context) assert.ok(publicFacts.some(fact => fact.value === item.value))
      assert.ok(!JSON.stringify(body).includes('approvalReference'))
      return (async function* () { yield { choices: [{ delta: { content: 'A conditional assessment based on documented public work.' }, finish_reason: 'stop' }] } })()
    } } } },
  })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  for (const path of ['/server/private/knowledge/index.json', '/knowledge/index.json', '/api/knowledge', '/api/knowledge/export', '/server/.env']) {
    const response = await fetch(base + path)
    assert.equal(response.status, 404)
    assert.doesNotMatch(await response.text(), /approvedValue|approvalReference|gsk_/)
  }
  const response = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(input('How might his engineering background help a product team?')) })
  const output = await response.text()
  assert.equal(response.status, 200)
  assert.doesNotMatch(output, /APPROVED_FACTS|approvalReference|approvedValue|factIds/)
  assert.equal(calls, 1)
})

test('Vite denies raw private storage, traversal and @fs access while the public site remains accessible', async t => {
  const vite = await createServer({ root: root.pathname, server: { port: 0, strictPort: false, host: '127.0.0.1' } })
  await vite.listen()
  t.after(() => vite.close())
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`
  const site = await fetch(base)
  assert.equal(site.status, 200)
  const privateFile = new URL('profile.json', knowledgeRoot()).pathname
  for (const path of ['/server/private/knowledge/profile.json', '/knowledge/load.js', '/@fs' + privateFile, '/server/private/knowledge/profile.json?raw', '/server/.env']) {
    const response = await fetch(base + path)
    assert.ok([403, 404].includes(response.status), `${path}: ${response.status}`)
    assert.doesNotMatch(await response.text(), /approvedValue|approvalReference|gsk_/)
  }
})

test('Worker reads private storage through its binding and sends only approved public facts to the model', async t => {
  const bundle = await build({ absWorkingDir: root.pathname, entryPoints: ['worker/index.js'], bundle: true, write: false, metafile: true, format: 'esm', platform: 'node' })
  assert.ok(!Object.keys(bundle.metafile.inputs).some(file => file.endsWith('.json') && /knowledge\//.test(file)))
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)).default
  const snapshot = JSON.parse(execFileSync(process.execPath, ['scripts/validate-knowledge.mjs', '--export-public'], { cwd: root, encoding: 'utf8' }))
  const fact = snapshot.modules[0].facts[0]
  snapshot.modules[0].facts.push({ ...fact, id: 'synthetic-private', value: 'PRIVATE_SENTINEL', visibility: 'private', verification: { ...fact.verification, approvedValue: 'PRIVATE_SENTINEL' } })
  snapshot.modules[0].facts.push({ ...fact, id: 'synthetic-pending', value: 'PENDING_SENTINEL', status: 'pending_review', verification: { approvedBy: null, approvedAt: null, approvalReference: null, approvedValue: null } })
  let reads = 0, calls = 0
  const env = { ALLOWED_ORIGINS: 'https://portfolio.example', GROQ_RECRUITER_API_KEY: 'synthetic', KNOWLEDGE: { async get(key, options) {
    reads++
    assert.equal(key, 'approved-knowledge'); assert.equal(options.type, 'json')
    return structuredClone(snapshot)
  } } }
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url, options) => {
    calls++
    const body = JSON.parse(options.body)
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_SENTINEL|PENDING_SENTINEL|approvalReference/)
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'A grounded conditional assessment.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const call = (path, body) => worker.fetch(new Request('https://api.example' + path, { method: body ? 'POST' : 'GET', headers: { Origin: 'https://portfolio.example', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env)
  for (const path of ['/knowledge/index.json', '/server/private/knowledge/index.json', '/api/knowledge']) assert.equal((await call(path)).status, 404)
  const expected = recruiterFactualAnswer(input('his course'), await currentPublicFacts())
  const direct = await call('/api/chat', input('his course'))
  const events = (await direct.text()).trim().split('\n').map(JSON.parse)
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), expected.text)
  const generated = await call('/api/chat', input('How might his background help an engineering team?'))
  const output = await generated.text()
  assert.match(output, /grounded conditional assessment/)
  assert.doesNotMatch(output, /PRIVATE_SENTINEL|PENDING_SENTINEL|approvalReference|approvedValue/)
  assert.equal(calls, 1)
  assert.ok(reads >= 2)
})
