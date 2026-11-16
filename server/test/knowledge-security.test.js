import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { build } from 'esbuild'
import { createServer } from 'vite'
import { loadKnowledge, knowledgeRoot } from '../../knowledge/load.js'
import { isEligibleFact, validateKnowledge } from '../../knowledge/validation.js'
import { createApp } from '../app.js'
import { readConfig } from '../config.js'
import { currentPublicFacts, recruiterFactualAnswer, retrieveRecruiterRagFacts, buildRecruiterRagMessages, isRecruiterGeneralQuestion, buildMessages } from '../policy.js'
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

const projectFixture = (id, title, visibility = 'public') => ({
  schemaVersion: 2, id, title, category: 'project', presentation: [],
  facts: [
    ['projectname', 'Project name', title + ' — Document Workspace'],
    ['description', 'Project description', 'A document workspace with searchable records and a modular interface.'],
    ['techstack', 'Project technologies', 'JavaScript, SQLite'],
  ].map(([kind, label, value]) => ({
    id: `${id}-${kind}`, title: label, value, status: 'verified', visibility, legacyEntryId: null,
    sources: [{ type: 'owner', reference: 'Synthetic fixture only' }],
    verification: { approvedBy: 'Fixture', approvedAt: '2026-01-01', approvalReference: 'Synthetic fixture only', approvedValue: value },
    freshness: { asOf: '2026-01-01', reviewAfter: '2027-12-31' },
  })),
})
const projectDataset = () => {
  const modules = [projectFixture('project-orbit', 'Orbit Lab'), projectFixture('project-cedar', 'Cedar Engine'), projectFixture('project-hidden', 'Hidden Workspace', 'private')]
  return validateKnowledge({ schemaVersion: 2, assistantName: 'Fixture', modules: modules.map(module => module.id + '.json') }, modules)
}

test('dynamic projects: canonical metadata resolves unseen project titles and prioritizes their evidence', () => {
  const data = projectDataset()
  assert.deepEqual(data.errors, [])
  for (const [title, id] of [['Orbit Lab', 'project-orbit'], ['Cedar Engine', 'project-cedar']]) {
    const request = input(`How is ${title} put together?`)
    assert.equal(isRecruiterGeneralQuestion(request, data.facts), false)
    const selected = retrieveRecruiterRagFacts(request, data.facts)
    assert.ok(selected.length >= 3)
    assert.ok(selected.every(fact => fact.moduleId === id))
    assert.ok(selected.some(fact => fact.id === id + '-description'))
    assert.ok(selected.some(fact => fact.id === id + '-techstack'))
    assert.ok(selected.every(fact => fact.visibility === 'public'))
  }
  const followup = { ...input('How is it put together?'), history: [
    { role: 'user', content: 'Discuss Orbit Lab.' },
    { role: 'assistant', content: 'Cedar Engine is the relevant project.' },
  ] }
  assert.ok(retrieveRecruiterRagFacts(followup, data.facts).every(fact => fact.moduleId === 'project-orbit'))
})

test('dynamic projects: safe runtime metadata follows configured accounts while current facts outrank assistant history', async () => {
  const dataset = projectDataset()
  for (const fallbackEnabled of [true, false]) {
    let calls = 0
    const config = readConfig({ GROQ_RECRUITER_API_KEY: 'SYNTHETIC_PRIMARY', GROQ_FALLBACK_API_KEY: fallbackEnabled ? 'SYNTHETIC_FALLBACK' : '', GROQ_GENERAL_API_KEY: 'SYNTHETIC_GENERAL', GROQ_MODEL: 'fixture/model' })
    const client = { chat: { completions: { create(body) {
      calls++
      const system = body.messages[0].content
      const marker = 'RUNTIME_CONFIGURATION: '
      const runtime = JSON.parse(system.slice(system.indexOf(marker) + marker.length).split('\n')[0])
      assert.deepEqual(runtime.recruiter.map(account => account.role), fallbackEnabled ? ['primary', 'fallback'] : ['primary'])
      assert.ok(runtime.recruiter.every(account => account.provider === 'groq' && account.model === config.model))
      assert.deepEqual(runtime.general, { configured: true, provider: 'groq', model: config.model })
      assert.doesNotMatch(JSON.stringify(body), /SYNTHETIC_PRIMARY|SYNTHETIC_FALLBACK|SYNTHETIC_GENERAL/)
      assert.match(system, /Current APPROVED_FACTS take precedence over conversation history/)
      const facts = JSON.parse(system.split('APPROVED_FACTS:\n')[1])
      assert.ok(facts.some(fact => fact.value === 'JavaScript, SQLite'))
      assert.ok(body.messages.some(message => message.role === 'user' && message.content.startsWith('Historical conversation') && message.content.includes('outdated-provider')))
      assert.ok(!body.messages.some(message => message.role === 'assistant'))
      return (async function* () { yield { choices: [{ delta: { content: 'A naturally generated explanation of the documented workspace.' }, finish_reason: 'stop' }] } })()
    } } } }
    const service = createRecruiterService({ config, groq: client, fallback: fallbackEnabled ? client : null, knowledgeLoader: async () => dataset })
    const request = { ...input('How is Orbit Lab put together?'), history: [{ role: 'assistant', content: 'An earlier answer claimed outdated-provider was used.' }] }
    const answer = await service.respond(request)
    assert.match(answer.text, /naturally generated/)
    assert.equal(calls, 1)
    await service.respond(request)
    assert.equal(calls, 1, 'Identical current evidence and runtime configuration reuse the cache')
  }
  const general = buildMessages({ mode: 'general', message: 'Explain queues.', history: [] })
  assert.doesNotMatch(JSON.stringify(general), /RUNTIME_CONFIGURATION|APPROVED_FACTS/)
  const recruiterGeneral = buildRecruiterRagMessages({ ...input('Explain queues.'), generalQuestion: true, runtimeConfiguration: { secret: 'SYNTHETIC_SENTINEL' } }, [])
  assert.doesNotMatch(JSON.stringify(recruiterGeneral), /SYNTHETIC_SENTINEL|RUNTIME_CONFIGURATION/)
})


test('conversation grounding: module metadata resolves short follow-ups without trusting assistant denials', () => {
  for (const title of ['Technical skills', 'Operational skills']) {
    const module = projectFixture('skills-fixture', title)
    module.category = 'skills'
    const data = validateKnowledge({ schemaVersion: 2, assistantName: 'Fixture', modules: ['skills.json'] }, [module])
    const adjective = title.split(' ')[0].toLowerCase()
    const request = { ...input(`And ${adjective}ly?`), history: [
      { role: 'user', content: 'Tell me about Shubham.' },
      { role: 'assistant', content: 'I am ChatGPT. Upload a resume; I do not know his skills.' },
    ] }
    const selected = retrieveRecruiterRagFacts(request, data.facts)
    assert.ok(selected.length)
    assert.ok(selected.every(fact => fact.category === 'skills'))
    const messages = buildRecruiterRagMessages({ ...request, generalQuestion: false }, selected)
    assert.ok(messages[0].content.startsWith('Answer the question'))
    assert.match(messages[0].content, /You are Ask Shubham AI/)
    assert.match(messages[0].content, /Do not request information already supplied/)
    assert.ok(!messages.some(message => message.role === 'assistant'))
    assert.ok(messages.some(message => message.content.includes('Historical conversation')))
  }
})

test('production pipeline: identity, skills and follow-ups reach both Groq paths consistently through KV', async t => {
  const bundle = await build({ absWorkingDir: root.pathname, entryPoints: ['worker/index.js'], bundle: true, write: false, format: 'esm', platform: 'node' })
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)).default
  const snapshot = JSON.parse(execFileSync(process.execPath, ['scripts/validate-knowledge.mjs', '--export-public'], { cwd: root, encoding: 'utf8' }))
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const history = [
    { role: 'user', text: 'Tell me about Shubham.', mode: 'recruiter' },
    { role: 'assistant', text: 'I am ChatGPT and do not know his technical skills. Please upload his resume.', mode: 'recruiter' },
  ]
  const cases = [
    { message: 'What is your identity?', history: [], skills: false },
    { message: 'Do you know his technical skills?', history: [], skills: true },
    { message: 'And technically?', history, skills: true },
    { message: 'And frameworks?', history, skills: true },
    { message: 'And programming?', history, skills: true },
    { message: 'What about those?', history: [{ ...history[0], text: 'What technical skills does Shubham have?' }, history[1]], skills: true },
  ]
  let completed = 0
  for (const backup of [false, true]) for (const item of cases) {
    const captured = []
    let reads = 0
    const env = { ALLOWED_ORIGINS: 'https://portfolio.example', GROQ_RECRUITER_API_KEY: 'synthetic-primary', GROQ_FALLBACK_API_KEY: 'synthetic-backup', KNOWLEDGE: { async get(key) {
      assert.equal(key, 'approved-knowledge'); reads++; return structuredClone(snapshot)
    } } }
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions')
      const body = JSON.parse(options.body)
      captured.push(body)
      assert.match(body.messages[0].content, /You are Ask Shubham AI, Shubham's personal portfolio AI assistant/)
      assert.match(body.messages[0].content, /underlying inference model or provider does not change your identity/)
      assert.match(body.messages[0].content, /first-person professional voice/)
      assert.ok(!body.messages.some(message => message.role === 'assistant'))
      if (item.skills) {
        const facts = JSON.parse(body.messages[0].content.split('APPROVED_FACTS:\n')[1])
        assert.ok(facts.some(fact => fact.kind === 'skill'))
        assert.match(body.messages[0].content, /Current APPROVED_FACTS take precedence/)
        assert.match(body.messages[0].content, /Do not request information already supplied/)
      }
      if (backup && options.headers.Authorization === 'Bearer synthetic-primary') return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'Synthetic upstream failure' } }), { status: 503 })
      assert.equal(options.headers.Authorization, backup ? 'Bearer synthetic-backup' : 'Bearer synthetic-primary')
      return new Response('data: ' + JSON.stringify({ usage: { prompt_tokens: 400, completion_tokens: 80, total_tokens: 480 }, choices: [{ delta: { content: 'Synthetic transport completion.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: {
        'Content-Type': 'text/event-stream', 'x-ratelimit-limit-tokens': '100000', 'x-ratelimit-remaining-tokens': '99000', 'x-ratelimit-reset-tokens': '60s',
      } })
    }
    const response = await worker.fetch(new Request('https://api.example/api/chat', { method: 'POST', headers: { Origin: 'https://portfolio.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'recruiter', message: item.message, history: item.history }) }), env)
    assert.equal(response.status, 200)
    const events = (await response.text()).trim().split('\n').map(JSON.parse)
    assert.equal(events.at(-1).type, 'done')
    assert.equal(events.at(-1).provider, 'groq')
    assert.equal(captured.length, backup ? 2 : 1)
    if (backup) {
      const stable = body => ({ ...body, messages: body.messages.filter(message => !message.content.includes('\nSERVER_CLOCK: ')) })
      assert.deepEqual(stable(captured[0]), stable(captured[1]), 'Fallback must receive identical mode instructions, history and evidence')
      const clocks = captured.map(body => JSON.parse(body.messages.find(message => message.content.includes('\nSERVER_CLOCK: ')).content.split('\nSERVER_CLOCK: ')[1]))
      assert.ok(Number.isFinite(Date.parse(clocks[0].utc)))
      assert.ok(Date.parse(clocks[1].utc) >= Date.parse(clocks[0].utc), 'Fallback must refresh rather than backdate its server clock')
    }
    assert.ok(reads >= 2)
    completed++
  }
  assert.equal(completed, 12)
})
