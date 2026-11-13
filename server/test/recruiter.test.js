import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadKnowledge } from '../../knowledge/load.js'
import { readConfig } from '../config.js'
import { createRecruiterService } from '../recruiter.js'
import { buildMessages, recruiterFacts, currentPublicFacts, isRecruiterGeneralQuestion, retrieveRecruiterRagFacts, recruiterConversation, recruiterProjectLinks } from '../policy.js'
import { quotaType, recruiterCooldown, rateHeaders, tokenUsage, createRecruiterTokenBudget } from '../groqMetrics.js'

const dataset = await loadKnowledge()
const config = readConfig({ GROQ_API_KEY: 'synthetic-only-test-key' })
const input = (message, history = []) => ({ mode: 'recruiter', message, history })
const nuanced = 'Compare his React and TypeScript skills.'
const output = async function* (ids) {
  yield { choices: [{ delta: { content: JSON.stringify({ factIds: ids }) } }] }
  yield { choices: [{ delta: {}, finish_reason: 'stop' }], x_groq: { usage: { prompt_tokens: 450, completion_tokens: 70, total_tokens: 520, completion_tokens_details: { reasoning_tokens: 32 } } } }
}
function fixture(options = {}) {
  let calls = 0
  const loader = options.knowledgeLoader || (async () => structuredClone(dataset))
  const metrics = []
  const groq = { chat: { completions: { create(request, transport) {
    calls++
    if (options.create) return options.create(request, transport)
    const context = JSON.parse(request.messages[0].content.split('APPROVED_FACTS:\n')[1])
    return Promise.resolve(output(context.map(fact => fact.id)))
  } } } }
  const service = createRecruiterService({ config, groq, knowledgeLoader: loader, onMetrics: metric => metrics.push(metric), ...options })
  return { ...service, metrics, calls: () => calls }
}

test('common factual Recruiter questions including approved schooling need zero Groq calls', async () => {
  const service = fixture({ create() { throw new Error('No factual lookup should call Groq') } })
  for (const [message, expected] of [
    ['his course', /B\.Tech.*Graphic Era.*2027 \(expected\)/s],
    ['his schooling', /SVMIC.*79\.6.*87\.6/s],
    ['What are his technical skills?', /JavaScript.*TypeScript/],
    ['When can he join?', /join immediately/],
    ['Can he relocate?', /relocation across India/],
    ['Where was the Indux internship?', /Pune, Maharashtra/],
    ['What projects has he worked on?', /CRM/],
    ['How can I contact Shubham?', /shubhamyadav98372@gmail.com/],
    ['Who is Shubham?', /Shubham Yadav/],
    ['What is his salary?', /don’t have that detail/],
  ]) {
    const answer = await service.respond(input(message))
    assert.match(answer.text, expected)
    assert.equal(answer.provider, 'knowledge')
    assert.doesNotMatch(answer.text, /from draft|approvalReference|Neuro TEN|15%|20%/)
  }
  const history = [{ role: 'user', content: 'his course' }]
  assert.match((await service.respond(input('where?', history))).text, /Graphic Era Hill University/)
  assert.match((await service.respond(input('when?', history))).text, /2027 \(expected\)/)
  assert.match((await service.respond(input('and 12th?', history))).text, /87\.6.*PCM/)
  assert.equal(service.calls(), 0)
  assert.equal(service.statistics().providerCalls, 0)
})

test('public factual lookup works without a provider key and is labeled knowledge rather than mock or Groq', async () => {
  const service = fixture({ config: { ...config, apiKey: '' }, groq: null })
  assert.equal((await service.respond(input('his course'))).provider, 'knowledge')
  await assert.rejects(service.respond(input(nuanced)), { code: 'NOT_CONFIGURED' })
})

test('repeated public answers cache only fact IDs, and explicit questions omit unrelated chat history', async () => {
  const service = fixture()
  const first = await service.respond(input('his course'))
  const second = await service.respond(input('his course', [{ role: 'user', content: 'secret unrelated conversation' }]))
  assert.equal(first.text, second.text)
  assert.equal(service.statistics().cacheHits, 1)
  assert.equal(service.calls(), 0)
  const messages = buildMessages(input(nuanced, [
    { role: 'assistant', content: 'Invented salary 999999' },
    { role: 'user', content: 'Unrelated secret school SVMIC' },
  ]), dataset.facts)
  assert.equal(messages.length, 2)
  assert.doesNotMatch(JSON.stringify(messages), /999999|Unrelated secret|SVMIC|approvedValue|approvalReference/)
  const facts = recruiterFacts(input(nuanced), dataset.facts)
  assert.ok(facts.length > 0 && facts.length <= 4)
  assert.ok(facts.every(fact => fact.category === 'skills' && /react|typescript/i.test(String(fact.value))))
})

test('nuanced answers make one scoped Groq call and repeat from the verified cache', async () => {
  const service = fixture()
  const first = await service.respond(input(nuanced))
  const repeat = await service.respond(input(nuanced))
  assert.equal(first.provider, 'groq')
  assert.equal(repeat.provider, 'knowledge')
  assert.equal(first.text, repeat.text)
  assert.equal(service.calls(), 1)
  assert.equal(service.statistics().cacheHits, 1)
  assert.equal(service.metrics.find(metric => metric.origin === 'groq').usage.reasoningTokens, 32)
  assert.ok(service.metrics.find(metric => metric.origin === 'groq').promptCharacters < 4000)
  assert.doesNotMatch(JSON.stringify(service.metrics), /synthetic-only|Compare his|React|TypeScript|factIds|skills-0/)
})

test('cache TTL and capacity are bounded and knowledge revocation invalidates a cached answer', async () => {
  let clock = Date.now()
  let current = structuredClone(dataset)
  const service = fixture({ now: () => clock, cacheTtlMs: 10, cacheMax: 2, knowledgeLoader: async () => structuredClone(current) })
  await service.respond(input(nuanced))
  clock += 11
  await service.respond(input(nuanced))
  assert.equal(service.calls(), 2)
  await service.respond(input('his course'))
  await service.respond(input('When can he join?'))
  assert.ok(service.statistics().cacheEntries <= 2)
  current.facts = current.facts.map(fact => /education-(degree|university|period)$/.test(fact.id) ? { ...fact, status: 'pending_review' } : fact)
  const answer = await service.respond(input('his course'))
  assert.deepEqual(answer.knowledgeIds, [])
  assert.doesNotMatch(answer.text, /B\.Tech|Graphic Era|2027/)
})

test('approval changes, private values, expired facts, and invalid knowledge cannot escape through local answers or cache', async () => {
  let current = structuredClone(dataset)
  const service = fixture({ knowledgeLoader: async () => structuredClone(current) })
  await service.respond(input('When can he join?'))
  current.facts = current.facts.map(fact => fact.id === 'availability-start-date' ? { ...fact, value: 'unapproved replacement' } : fact)
  assert.deepEqual((await service.respond(input('When can he join?'))).knowledgeIds, [])
  current.facts = current.facts.map(fact => fact.category === 'education' ? { ...fact, visibility: 'private' } : fact)
  assert.deepEqual((await service.respond(input('his course'))).knowledgeIds, [])
  current = structuredClone(dataset)
  current.facts = current.facts.map(fact => fact.category === 'education' ? { ...fact, freshness: { ...fact.freshness, reviewAfter: '2026-11-10' } } : fact)
  assert.deepEqual((await service.respond(input('his course'))).knowledgeIds, [])
  current.errors = ['Private knowledge validation path']
  await assert.rejects(service.respond(input('his course')), { code: 'KNOWLEDGE_UNAVAILABLE' })
})

test('identical concurrent provider requests share one call and one cancellation does not stop another subscriber', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let providerSignal
  const service = fixture({ async create(request, { signal }) {
    providerSignal = signal
    await gate
    return output(['skills-1'])
  } })
  const firstController = new AbortController()
  const first = service.respond(input(nuanced), { signal: firstController.signal })
  const firstRejected = assert.rejects(first, { name: 'AbortError' })
  const second = service.respond(input(nuanced))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.calls(), 1)
  firstController.abort()
  await firstRejected
  assert.equal(providerSignal.aborted, false)
  release()
  assert.match((await second).text, /TypeScript/)
  assert.equal(service.statistics().sharedRequests, 1)
})

test('canceling every subscriber aborts the provider and never caches a partial result', async () => {
  let aborted = false
  const service = fixture({ create(request, { signal }) {
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('stopped', 'AbortError')) }, { once: true }))
  } })
  const controller = new AbortController()
  const answer = service.respond(input(nuanced), { signal: controller.signal })
  const rejected = assert.rejects(answer, { name: 'AbortError' })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await rejected
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(aborted, true)
  assert.equal(service.statistics().cacheEntries, 0)
  assert.equal(service.statistics().inFlight, 0)
})

test('revoking a fact during provider work fails closed before any personal answer is returned', async () => {
  let current = structuredClone(dataset)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const service = fixture({ knowledgeLoader: async () => structuredClone(current), async create() { await gate; return output(['skills-1']) } })
  const answer = service.respond(input(nuanced))
  await new Promise(resolve => setImmediate(resolve))
  current.facts = current.facts.map(fact => fact.id === 'skills-1' ? { ...fact, visibility: 'private' } : fact)
  release()
  await assert.rejects(answer, { code: 'KNOWLEDGE_UNAVAILABLE' })
  assert.equal(service.statistics().cacheEntries, 0)
})

test('429 cooldown blocks all new provider calls but permits local and cached verified answers', async () => {
  let clock = Date.now()
  const service = fixture({ now: () => clock, create() {
    throw Object.assign(new Error('Tokens per minute (TPM) limit; private account identifier'), { status: 429, headers: new Headers({ 'retry-after': '37' }) })
  } })
  await service.respond(input('his course'))
  await assert.rejects(service.respond(input(nuanced)), error => error.limitType === 'TPM' && error.retryAfterSeconds === 37)
  clock += 10000
  for (const message of [nuanced, 'Explain why his JavaScript skills suit frontend work.']) await assert.rejects(service.respond(input(message)), error => error.limitType === 'TPM' && error.retryAfterSeconds === 27)
  assert.match((await service.respond(input('his course'))).text, /B\.Tech/)
  assert.match((await service.respond(input('Can he relocate?'))).text, /India/)
  assert.equal(service.calls(), 1)
  clock += 27001
  await assert.rejects(service.respond(input(nuanced)), { code: 'PROVIDER_RATE_LIMIT' })
  assert.equal(service.calls(), 2)
  assert.equal(service.statistics().cacheEntries, 2)
  assert.doesNotMatch(JSON.stringify(service.metrics), /account identifier|Tokens per minute/)
})

test('provider telemetry records numeric headers and actual token usage without logging secrets or prompts', async () => {
  const service = fixture({ create() {
    return { withResponse: async () => ({ data: output(['skills-1']), response: { headers: new Headers({
      'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '987',
      'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '7000',
      'x-ratelimit-reset-tokens': '7.66s', 'x-private-secret': 'secret-value',
    }) } }) }
  } })
  await service.respond(input(nuanced))
  const metric = service.metrics.find(item => item.origin === 'groq')
  assert.equal(metric.historyMessages, 0)
  assert.equal(metric.limits.tokensPerMinuteLimit, 8000)
  assert.equal(metric.limits.dailyRequestsRemaining, 987)
  assert.deepEqual(metric.usage, { promptTokens: 450, completionTokens: 70, totalTokens: 520, reasoningTokens: 32 })
  assert.doesNotMatch(JSON.stringify(metric), /secret-value|private-secret|React|TypeScript|synthetic-only/)
})

test('quota classification distinguishes minute limits, daily exhaustion, and unknown limits conservatively', () => {
  for (const [message, type] of [['requests per minute RPM', 'RPM'], ['Tokens per minute TPM', 'TPM'], ['tokens per day TPD', 'TPD'], ['requests per day RPD', 'RPD']]) assert.equal(quotaType({ message }), type)
  assert.equal(quotaType({ headers: new Headers({ 'x-ratelimit-remaining-requests': '0' }) }), 'RPD')
  assert.equal(quotaType({ headers: new Headers({ 'x-ratelimit-remaining-tokens': '0' }) }), 'TPM')
  assert.equal(quotaType({ headers: new Headers({ 'x-ratelimit-remaining-requests': '500' }) }), 'UNKNOWN')
  assert.equal(recruiterCooldown({ status: 429, message: 'daily token quota' }).seconds, 86400)
  assert.equal(recruiterCooldown({ status: 429, headers: new Headers({ 'retry-after': '123456' }) }).seconds, 123456)
  assert.deepEqual(rateHeaders(new Headers({ 'x-ratelimit-limit-tokens': 'secret', 'x-private-secret': 'private' })), {})
  assert.equal(tokenUsage({ usage: { prompt_tokens: 'secret' } }).promptTokens, null)
})

test('typos, synonyms and Hinglish cover recruiter topics without making provider calls', async () => {
  const service = fixture({ create() { throw new Error('Factual language variants must stay local') } })
  for (const [message, expected] of [
    ['his shcooling', /SVMIC.*79\.6.*87\.6/s],
    ['uski eduction batao', /B\.Tech.*Graphic Era.*2027/s],
    ['uska cource kya hai', /B\.Tech/],
    ['kaunsi univercity me hai', /Graphic Era Hill University/],
    ['10th aur 12th marks', /79\.6.*87\.6/],
    ['uske projets batao', /CRM.*EventVerse/s],
    ['internship kaha ki hai', /Indux.*Pune.*Entrepreneurship.*Delhi/s],
    ['Indux me kya kaam kiya', /Full Stack Developer Intern.*Indux/s],
    ['uski skils kya hai', /JavaScript.*TypeScript/],
    ['What programming languages does he know?', /JavaScript, TypeScript, Java and C/],
    ['his backend skills', /Node.js.*Express.js.*PostgreSQL/],
    ['uske school ka naam', /attended SVMIC, Gadarpur/],
    ['achievments kya hain', /Best Frontend Developer/],
    ['uske certificates', /Naukri.*PostgreSQL/],
    ['kab join kar sakta hai', /join immediately/],
    ['remote job ke liye avilable hai', /open to remote opportunities/],
    ['relocaton ke liye available hai', /relocation across India/],
    ['What opportunities is he open to?', /open to full-time roles and internships/],
    ['What target roles is he considering?', /software engineer, full stack developer, frontend developer/i],
    ['resume link?', /https:\/\/drive.google.com/],
    ['Where is he based?', /Gadarpur, Uttarakhand, India/],
  ]) {
    const answer = await service.respond(input(message))
    assert.match(answer.text, expected, message)
    assert.doesNotMatch(answer.text, /from draft|approvalReference|approvedValue|Neuro TEN|15%|20%|6 months/)
    assert.equal(answer.provider, 'knowledge')
  }
  assert.equal(service.calls(), 0)
  for (const question of ['Does he know Python?', 'Does he know C++?']) assert.deepEqual((await service.respond(input(question))).knowledgeIds, [])
})

test('natural follow-ups stay with the right employer/project and reset on a new explicit topic', async () => {
  const service = fixture()
  const history = [{ role: 'user', content: 'Tell me about the Indux internship' }]
  assert.match((await service.respond(input('where?', history))).text, /Pune, Maharashtra/)
  const dates = await service.respond(input('when?', [...history, { role: 'user', content: 'where?' }]))
  assert.match(dates.text, /Jan 2026 to Apr 2026/)
  assert.doesNotMatch(dates.text, /2027|Delhi/)
  const ten = await service.respond(input('and TEN?', history))
  assert.match(ten.text, /Frontend Developer Trainee.*Entrepreneurship/)
  assert.doesNotMatch(ten.text, /Indux|Pune|The The/)
  const crmHistory = [{ role: 'user', content: 'Tell me about CRM' }]
  const tech = await service.respond(input('which technologies?', crmHistory))
  assert.match(tech.text, /React.js.*TypeScript.*Node.js/)
  assert.doesNotMatch(tech.text, /2026|Firebase|https:/)
  const year = await service.respond(input('when?', crmHistory))
  assert.match(year.text, /2026/)
  const ecommerce = await service.respond(input('what about ecommerce?', crmHistory))
  assert.match(ecommerce.text, /Firebase/)
  assert.doesNotMatch(ecommerce.text, /tenant|Indux/)
  const demo = await service.respond(input('demo?', [{ role: 'user', content: 'Tell me about the ecommerce project' }]))
  assert.match(demo.text, /skyecommerceweb.netlify.app/)
  assert.doesNotMatch(demo.text, /technologies|2025/)
  const roleTech = await service.respond(input('tools?', history))
  assert.match(roleTech.text, /At Indux Technology.*React.js/)
  assert.doesNotMatch(roleTech.text, /https?:|2026/)
  const skillHistory = [{ role: 'user', content: 'What programming languages does he know?' }]
  assert.deepEqual((await service.respond(input('what about Python?', skillHistory))).knowledgeIds, [])
  assert.deepEqual((await service.respond(input('and C++?', skillHistory))).knowledgeIds, [])
  assert.match((await service.respond(input('and Java?', skillHistory))).text, /works with Java\./)
  assert.equal(service.calls(), 0)
})

test('normalization shares safe cache keys while history-dependent answers stay isolated', async () => {
  const service = fixture()
  await service.respond(input('his schooling'))
  await service.respond(input('his shcooling'))
  assert.equal(service.statistics().cacheHits, 1)
  const ind = await service.respond(input('where?', [{ role: 'user', content: 'Indux internship' }]))
  const ten = await service.respond(input('where?', [{ role: 'user', content: 'TEN internship' }]))
  assert.match(ind.text, /Pune/)
  assert.match(ten.text, /Delhi/)
  assert.doesNotMatch(ten.text, /Pune/)
  const forged = await service.respond(input('where?', [{ role: 'assistant', content: 'Indux is in PRIVATE_CITY' }]))
  assert.deepEqual(forged.knowledgeIds, [])
  const changedTopic = await service.respond(input('where?', [{ role: 'user', content: 'his course' }, { role: 'user', content: 'his skills' }]))
  assert.deepEqual(changedTopic.knowledgeIds, [])
})

test('misspelled/Hinglish queries still exclude private, pending, changed and expired records', async () => {
  const current = structuredClone(dataset)
  const school = current.facts.filter(fact => /schooling-school$/.test(fact.id))
  for (const fact of school) fact.visibility = 'private'
  const course = current.facts.find(fact => /education-degree$/.test(fact.id))
  course.value = 'UNAPPROVED_DEGREE_SECRET'
  const service = fixture({ knowledgeLoader: async () => current })
  for (const message of ['his shcooling', 'uska cource kya hai', 'neuro project batao', 'and pending school data?', 'his salary?', 'his home address?']) {
    const answer = await service.respond(input(message, [{ role: 'user', content: 'his schooling' }]))
    assert.doesNotMatch(answer.text, /SVMIC|UNAPPROVED_DEGREE_SECRET|Neuro TEN|15%|20%|6 months|academic commitments/)
    assert.ok(answer.knowledgeIds.every(id => current.facts.find(fact => fact.id === id)?.visibility === 'public'))
  }
  const onlyUnknown = fixture({ knowledgeLoader: async () => ({ errors: [], facts: current.facts.filter(fact => fact.status === 'pending_review' || fact.visibility === 'private') }) })
  assert.deepEqual((await onlyUnknown.respond(input('uski padhai batao'))).knowledgeIds, [])
})

// Targeted regressions for the single-call conversational path (no live Groq).
test('conversational RAG retrieves owner identity, semantic variants and chained context', async () => {
  const { retrieveRecruiterRagFacts, recruiterConversation } = await import('../policy.js')
  for (const question of ['u know shubham', 'his surname', 'what does he do']) {
    const facts = retrieveRecruiterRagFacts(input(question), dataset.facts)
    assert.ok(facts.some(fact => fact.id === 'profile-name'), question)
    assert.ok(facts.every(fact => fact.status === 'verified' && fact.visibility === 'public'))
  }
  for (const question of ['uske prjoects batao', 'what about his projects?']) {
    assert.ok(retrieveRecruiterRagFacts(input(question), dataset.facts).some(fact => fact.category === 'project'), question)
  }
  const history = [
    { role: 'user', content: 'Tell me about the Indux internship' },
    { role: 'assistant', content: 'The role was at Indux Technology.' },
    { role: 'user', content: 'where?' }, { role: 'assistant', content: 'Pune, Maharashtra.' },
    { role: 'user', content: 'what did he do there?' }, { role: 'assistant', content: 'He worked on web applications.' },
  ]
  assert.match(JSON.stringify(recruiterConversation(input('when?', history))), /Indux/)
  const facts = retrieveRecruiterRagFacts(input('when?', history), dataset.facts)
  assert.ok(facts.some(fact => fact.moduleId === 'experience-1' && /duration|period/.test(fact.id)))
  assert.ok(retrieveRecruiterRagFacts(input('what about his projects?', history), dataset.facts).some(fact => fact.category === 'project'))
})

test('conversational RAG validates short references, identity, caching and unsupported facts', async () => {
  const { isEligibleFact } = await import('../../knowledge/validation.js')
  const records = []
  const metrics = []
  const modeConfig = readConfig({ GROQ_RECRUITER_API_KEY: 'test-only-recruiter', GROQ_GENERAL_API_KEY: 'test-only-general' })
  let invalid = false
  const groq = { chat: { completions: { create: async request => {
    records.push(request)
    const facts = JSON.parse(request.messages[0].content.split('APPROVED_FACTS:\n')[1])
    const name = facts.find(fact => fact.kind === 'name')
    const text = /who are you/.test(request.messages.at(-1).content)
      ? { factIds: [], answer: 'I’m Ask Shubham AI, Shubham’s personal portfolio AI assistant.' }
      : { factIds: [invalid ? 'f999' : name.id], answer: 'His surname is Yadav.' }
    return (async function* () {
      const json = JSON.stringify(text)
      yield { choices: [{ delta: { content: json.slice(0, 19) } }] }
      yield { choices: [{ delta: { content: json.slice(19) }, finish_reason: 'stop' }] }
    })()
  } } } }
  const service = createRecruiterService({ config: modeConfig, groq, onMetrics: value => metrics.push(value) })
  assert.match((await service.respond(input('his surname'))).text, /Yadav/)
  assert.deepEqual((await service.respond(input('his surname'))).knowledgeIds, ['profile-name'])
  assert.equal(records.length, 1)
  assert.match((await service.respond(input('who are you?'))).text, /personal portfolio AI assistant/)
  const sent = JSON.parse(records[0].messages[0].content.split('APPROVED_FACTS:\n')[1])
  const eligibleValues = new Set(dataset.facts.filter(fact => isEligibleFact(fact)).map(fact => fact.value))
  assert.ok(sent.every(fact => /^f\d+$/.test(fact.id) && eligibleValues.has(fact.value)))
  assert.doesNotMatch(JSON.stringify(records), /Neuro TEN|approvalReference|test-only-recruiter|test-only-general/)
  invalid = true
  await assert.rejects(service.respond(input('his full name')), { code: 'UNAPPROVED_AI_REFERENCE' })
  assert.equal(metrics.at(-1).code, 'UNAPPROVED_AI_REFERENCE')
})

test('conversational RAG distinguishes provider truncation, malformed JSON and cooldowns', async () => {
  const config = readConfig({ GROQ_RECRUITER_API_KEY: 'test-only-recruiter' })
  let ending = 'length'
  let calls = 0
  const metrics = []
  const groq = { chat: { completions: { create: async () => {
    calls++
    if (ending === '429') throw Object.assign(new Error('TPM'), { status: 429, headers: new Headers({ 'retry-after': '30' }) })
    return (async function* () { yield { choices: [{ delta: { content: '{"answer":' }, finish_reason: ending }] } })()
  } } } }
  const service = createRecruiterService({ config, groq, onMetrics: value => metrics.push(value) })
  await assert.rejects(service.respond(input('his surname')), { code: 'RESPONSE_TOKEN_LIMIT' })
  assert.equal(metrics.at(-1).finishReason, 'length')
  ending = 'stop'
  await assert.rejects(service.respond(input('his surname')), { code: 'INVALID_AI_RESPONSE' })
  ending = '429'
  await assert.rejects(service.respond(input('his surname')), { code: 'PROVIDER_RATE_LIMIT', limitType: 'TPM' })
  await assert.rejects(service.respond(input('his work')), { code: 'PROVIDER_RATE_LIMIT' })
  assert.equal(calls, 3)
  assert.match((await service.respond(input('ok bye bro'))).text, /Bye/)
  assert.match((await service.respond(input('im just telling you by'))).text, /Bye/)
  assert.equal(calls, 3)
})

test('conversational RAG transport preserves validated text and distinguishes timeout and cancellation', async t => {
  const { createApp } = await import('../app.js')
  const { streamChat, ChatServiceError } = await import('../../src/services/assistant/streamResponder.js')
  const { ConversationStream } = await import('../responseStream.js')
  const config = { ...readConfig({ GROQ_RECRUITER_API_KEY: 'test-only-recruiter', GROQ_GENERAL_API_KEY: 'test-only-general' }), timeoutMs: 300 }
  let stall = false
  let providerSignal
  let onProviderStart = () => {}
  let generalCalls = 0
  const longText = 'Shubham works with ' + Array(75).fill('JavaScript').join(' ') + '.'
  // Reproduce the former second-pass formatter failure with complete text.
  assert.throws(() => new ConversationStream('his skills').push(longText, true), { code: 'INVALID_AI_RESPONSE' })
  const groqRecruiter = { chat: { completions: { create: async (request, { signal }) => {
    providerSignal = signal
    onProviderStart()
    if (stall) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }))
    const facts = JSON.parse(request.messages[0].content.split('APPROVED_FACTS:\n')[1])
    const skill = facts.find(fact => fact.value === 'JavaScript')
    return (async function* () { yield { choices: [{ delta: { content: JSON.stringify({ factIds: [skill.id], answer: longText }) }, finish_reason: 'stop' }] } })()
  } } } }
  const app = createApp({ config, groqRecruiter, groqGeneral: { chat: { completions: { create() { generalCalls++; throw new Error('Wrong mode') } } } } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const fetchImpl = (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options)
  const answer = await streamChat('his JavaScript skills', { fetchImpl })
  assert.equal(answer.text, longText)
  assert.equal(generalCalls, 0)
  stall = true
  await assert.rejects(streamChat('his surname', { fetchImpl }), { code: 'TIMEOUT' })
  assert.equal(providerSignal.aborted, true)
  const controller = new AbortController()
  const providerStarted = new Promise(resolve => { onProviderStart = resolve })
  const pending = streamChat('his work', { fetchImpl, signal: controller.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await providerStarted
  assert.equal(providerSignal.aborted, false)
  controller.abort()
  await rejected
  for (let attempt = 0; attempt < 20 && !providerSignal.aborted; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(providerSignal.aborted, true)
  assert.equal(new ChatServiceError('RESPONSE_TOKEN_LIMIT', undefined, undefined, 'recruiter').userMessage.includes('response limit'), true)
  assert.equal(new ChatServiceError('RESPONSE_TOKEN_LIMIT').userMessage.includes('couldn’t be completed'), true)
})

test('resume collections retain every approved item and prioritize resume provenance', async () => {
  const { retrieveRecruiterRagFacts, recruiterCollectionCounts, isResumeFact, buildRecruiterRagMessages } = await import('../policy.js')
  const { isEligibleFact } = await import('../../knowledge/validation.js')
  const eligible = dataset.facts.filter(fact => isEligibleFact(fact))
  const skills = retrieveRecruiterRagFacts(input('list all his technical skills'), dataset.facts)
  assert.deepEqual(new Set(skills.filter(fact => fact.category === 'skills').map(fact => fact.id)), new Set(eligible.filter(fact => fact.category === 'skills').map(fact => fact.id)))
  const projects = retrieveRecruiterRagFacts(input('how many projects has he built?'), dataset.facts)
  assert.equal(recruiterCollectionCounts(projects).projects, 4)
  const roles = retrieveRecruiterRagFacts(input('list all his internships'), dataset.facts)
  assert.equal(recruiterCollectionCounts(roles).experienceEntries, 2)
  const certs = retrieveRecruiterRagFacts(input('list all certificates'), dataset.facts)
  assert.equal(recruiterCollectionCounts(certs).certifications, 4)
  const followup = retrieveRecruiterRagFacts(input('aur kitne?', [{ role: 'user', content: 'his projects' }]), dataset.facts)
  assert.equal(recruiterCollectionCounts(followup).projects, 4)
  const combined = retrieveRecruiterRagFacts(input('list all skills and projects'), dataset.facts)
  assert.ok(combined.length > 48)
  assert.equal(recruiterCollectionCounts(combined).skills, recruiterCollectionCounts(eligible).skills)
  assert.equal(recruiterCollectionCounts(combined).projects, 4)
  const firstAdditional = combined.findIndex(fact => !isResumeFact(fact))
  assert.ok(firstAdditional < 0 || combined.slice(firstAdditional).every(fact => !isResumeFact(fact)))
  const messages = buildRecruiterRagMessages(input('all skills and projects'), combined)
  assert.match(messages[0].content, /Completeness overrides/)
  assert.doesNotMatch(messages[0].content, /approvalReference|Neuro TEN|15%|20%|6 months/)
})

test('resume collection generation accepts grounded counts and more than 48 references in one call', async () => {
  let calls = 0
  let omitItem = false
  const config = readConfig({ GROQ_RECRUITER_API_KEY: 'test-only-recruiter' })
  const groq = { chat: { completions: { create: async request => {
    calls++
    const facts = JSON.parse(request.messages[0].content.split('APPROVED_FACTS:\n')[1])
    assert.ok(facts.length > 48)
    const answer = { factIds: facts.filter(fact => !omitItem || fact.value !== 'JavaScript').map(fact => fact.id), answer: 'The approved information covers 40 skills and 4 projects.' }
    return (async function* () { yield { choices: [{ delta: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] } })()
  } } } }
  const service = createRecruiterService({ config, groq })
  assert.match((await service.respond(input('list all skills and projects'))).text, /40 skills and 4 projects/)
  assert.equal(calls, 1)
  omitItem = true
  await assert.rejects(service.respond(input('list every skill and project')), { code: 'INCOMPLETE_COLLECTION' })
})

test('recruiter general questions return a separate hint flag without personal context or switching modes', async t => {
  const { createApp } = await import('../app.js')
  const { streamChat } = await import('../../src/services/assistant/streamResponder.js')
  const config = readConfig({ GROQ_RECRUITER_API_KEY: 'test-only-recruiter', GROQ_GENERAL_API_KEY: 'test-only-general' })
  let calls = 0
  const groqRecruiter = { chat: { completions: { create: async request => {
    calls++
    const personal = request.messages.at(-1).content.includes('his')
    if (!personal) assert.doesNotMatch(JSON.stringify(request.messages), /APPROVED_FACTS|Graphic Era|PRIVATE_HISTORY|profile-name/)
    const facts = personal ? JSON.parse(request.messages[0].content.split('APPROVED_FACTS:\n')[1]) : []
    const answer = personal
      ? { factIds: [facts.find(fact => fact.value === 'JavaScript').id], answer: 'He works with JavaScript.' }
      : { factIds: [], answer: request.messages.at(-1).content.includes('React') ? 'React is a JavaScript library for building user interfaces.' : 'JavaScript is a programming language used for interactive websites and other applications.' }
    return (async function* () { yield { choices: [{ delta: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] } })()
  } } } }
  const app = createApp({ config, groqRecruiter, groqGeneral: null })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const fetchImpl = (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options)
  for (const question of ['What is React?', 'What is JavaScript?']) {
    const reply = await streamChat(question, { fetchImpl, mode: 'recruiter', history: [{ role: 'user', mode: 'recruiter', text: 'his PRIVATE_HISTORY' }] })
    assert.equal(reply.generalQuestion, true)
    assert.equal(reply.mode, 'recruiter')
    assert.doesNotMatch(reply.text, /switch to General/)
    assert.equal((await streamChat(question, { fetchImpl, mode: 'recruiter', history: [{ role: 'user', mode: 'recruiter', text: 'his PRIVATE_HISTORY' }] })).generalQuestion, true)
  }
  const personal = await streamChat('What are his JavaScript skills?', { fetchImpl, mode: 'recruiter' })
  assert.equal(personal.generalQuestion, false)
  assert.match(personal.text, /JavaScript/)
  assert.equal(calls, 3)
})

test('Drive resume mapping preserves provenance and company/project boundaries', async () => {
  const { isResumeFact, isRecruiterGeneralQuestion, retrieveRecruiterRagFacts, buildRecruiterRagMessages } = await import('../policy.js')
  const { isEligibleFact } = await import('../../knowledge/validation.js')
  const { factKind } = await import('../../src/services/assistant/recruiterResponder.js')
  const facts = dataset.facts.filter(fact => isEligibleFact(fact))
  const owner = facts.find(fact => fact.id === 'profile-name')
  assert.ok(isResumeFact(owner))
  assert.match(JSON.stringify(owner.sources), /1ARvhNkEP-9RbeJEtJw5ZeZV5SM4qkt03/)
  const mixed = facts.find(fact => fact.id === 'draft-8396a1422e64-projects-0-description')
  assert.equal(isResumeFact(mixed), false)
  assert.equal(mixed.status, 'verified')
  assert.equal(mixed.verification.approvedValue, mixed.value)
  for (const [question, group] of [['Tell me about Indux', 'experience-1'], ['Tell me about TEN', 'experience-2']]) {
    assert.equal(isRecruiterGeneralQuestion(input(question), facts), false)
    const retrieved = retrieveRecruiterRagFacts(input(question), facts)
    assert.ok(retrieved.some(fact => fact.moduleId === group && factKind(fact) === 'role'))
    assert.ok(retrieved.filter(fact => fact.category === 'experience').every(fact => fact.moduleId === group))
  }
  assert.equal(isRecruiterGeneralQuestion(input('What is React?', []), facts), true)
  const overview = retrieveRecruiterRagFacts(input('his experience'), facts)
  for (const group of ['experience-1', 'experience-2']) {
    for (const kind of ['employer', 'role', 'role_dates', 'role_location', 'contribution']) assert.ok(overview.some(fact => fact.moduleId === group && factKind(fact) === kind), `${group} ${kind}`)
  }
  const projects = retrieveRecruiterRagFacts(input('his projects'), facts)
  assert.equal(new Set(projects.filter(fact => fact.category === 'project').map(fact => fact.moduleId)).size, 4)
  const messages = buildRecruiterRagMessages(input('his projects'), projects)
  assert.match(messages[0].content, /Keep Experience and Projects as separate/)
  const context = JSON.parse(messages[0].content.split('APPROVED_FACTS:\n')[1])
  assert.ok(context.filter(fact => /project_/.test(fact.kind)).every(fact => fact.section === 'project'))
  assert.doesNotMatch(JSON.stringify(context), /approvalReference|Neuro TEN|15%|20%|6 months/)
  const resumeLink = facts.find(fact => fact.id === 'resume')
  assert.equal(resumeLink.value, 'https://drive.google.com/file/d/1ARvhNkEP-9RbeJEtJw5ZeZV5SM4qkt03/view?usp=sharing')
  assert.ok(dataset.facts.filter(fact => ['draft-8396a1422e64-experience-summary', 'draft-8396a1422e64-experience-0-highlights-3', 'draft-8396a1422e64-experience-1-highlights-2'].includes(fact.id)).every(fact => fact.status === 'pending_review'))
})

// Focused regression checks for the live RAG path (run with --test-name-pattern).
const reliabilityConfig = readConfig({ GROQ_RECRUITER_API_KEY: 'test-recruiter', GEMINI_RECRUITER_API_KEY: 'test-backup', GEMINI_RECRUITER_MODEL: 'test-model' })
const reliabilityProvider = create => ({ chat: { completions: { create } } })
const reliabilityStream = answer => (async function* () {
  yield { choices: [{ delta: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] }
})()

test('reliability: local fields are consistent, scoped, and respect approval changes', async () => {
  let current = structuredClone(dataset)
  const service = createRecruiterService({ config: reliabilityConfig, knowledgeLoader: async () => current,
    groq: reliabilityProvider(() => { throw new Error('Local fields must not call a provider') }) })
  for (const [questions, expected] of [
    [['name', 'full name', 'hus bame', 'his naam', 'What is his full name?'], /Shubham Yadav/],
    [['How can I contact Shubham?', 'his email', 'contact details'], /shubhamyadav98372@gmail.com/],
    [['his domain', 'his profession'], /Full Stack Developer/],
    [['college', 'which college', 'his collage', 'college name'], /Graphic Era Hill University, Bhimtal/],
    [['his course'], /B.Tech.*2027 \(expected\)/],
  ]) for (const question of questions) {
    const result = await service.respond(input(question, [{ role: 'assistant', content: 'Wrong old answer.' }]))
    assert.match(result.text, expected)
    assert.equal(result.provider, 'knowledge')
    assert.doesNotMatch(result.text, /Wrong|approvalReference|pending|Neuro TEN/)
  }
  assert.equal(service.statistics().providerCalls, 0)
  current.facts = current.facts.map(f => f.id === 'profile-name' ? { ...f, visibility: 'private' } : f)
  const { recruiterFactualAnswer } = await import('../policy.js')
  assert.equal(recruiterFactualAnswer(input('name'), await currentPublicFacts(async () => current)), null)
})

test('reliability: project completeness, company boundaries, and contextual retrieval', async () => {
  const facts = await currentPublicFacts()
  for (const message of ['What projects has Shubham worked on?', 'his projects', 'list all his projects', 'uske projcts batao']) {
    const selected = retrieveRecruiterRagFacts(input(message), facts)
    assert.deepEqual(new Set(selected.filter(f => f.category === 'project').map(f => f.moduleId)), new Set(['project-1', 'project-3', 'project-eventverse', 'project-violet']))
    assert.ok(recruiterProjectLinks(selected).some(link => link.project === 'project-1' && link.employer.value === 'Indux Technology'))
    assert.doesNotMatch(JSON.stringify(selected), /Neuro TEN/)
  }
  const personal = retrieveRecruiterRagFacts(input('list all personal projects'), facts)
  assert.ok(personal.filter(f => f.category === 'project').every(f => f.moduleId !== 'project-1'))
  assert.ok(retrieveRecruiterRagFacts(input('his personal projects'), facts).filter(f => f.category === 'project').every(f => f.moduleId !== 'project-1'))
  assert.ok(retrieveRecruiterRagFacts(input('Tell me about InduxCRM'), facts).filter(f => f.category === 'project').every(f => f.moduleId === 'project-1'))
  const history = [{ role: 'user', content: 'Tell me about his Indux internship.' }, { role: 'assistant', content: 'He worked at Indux Technology in Pune.' }, { role: 'user', content: 'where?' }, { role: 'assistant', content: 'Pune, Maharashtra.' }]
  for (const message of ['when?', 'what did he do there?']) {
    const selected = retrieveRecruiterRagFacts(input(message, history), facts)
    assert.ok(selected.some(f => f.moduleId === 'experience-1'))
    assert.ok(selected.filter(f => f.category === 'experience').every(f => f.moduleId === 'experience-1'))
    if (message.includes('do there')) {
      const { factKind } = await import('../../src/services/assistant/recruiterResponder.js')
      assert.ok(selected.some(f => factKind(f) === 'contribution' && /CRM features/.test(f.value)))
      assert.ok(selected.every(f => factKind(f) !== 'role_technology'))
    }
  }
  assert.deepEqual(recruiterConversation(input('What projects has Shubham worked on?', history)), [])
  const collegeName = input('name', [{ role: 'user', content: 'which college' }, { role: 'assistant', content: 'Graphic Era Hill University, Bhimtal.' }])
  const { recruiterFactualAnswer } = await import('../policy.js')
  const clarification = recruiterFactualAnswer(collegeName, facts)
  assert.match(clarification.text, /^Do you mean.*Shubham.*college.*\?$/)
  assert.deepEqual(clarification.knowledgeIds, [])
})

test('reliability: technical intent, empty knowledge, and follow-ups stay separate', async () => {
  const facts = await currentPublicFacts()
  for (const message of ['what is mongodb', 'react', 'mongodb']) assert.equal(isRecruiterGeneralQuestion(input(message), facts), true)
  for (const message of ['his domain', 'hus bame', 'which college', 'does he know React']) assert.equal(isRecruiterGeneralQuestion(input(message), facts), false)
  assert.equal(isRecruiterGeneralQuestion(input('react', [{ role: 'user', content: 'What are his skills?' }]), facts), false)
  assert.equal(isRecruiterGeneralQuestion(input('what about his projects?', [{ role: 'user', content: 'What is MongoDB?' }]), facts), false)
  let captured
  const provider = reliabilityProvider(request => { captured = request; return reliabilityStream({ factIds: [], answer: 'MongoDB is a document-oriented database.' }) })
  const empty = createRecruiterService({ config: reliabilityConfig, groq: provider, knowledgeLoader: async () => ({ facts: [], errors: [] }) })
  assert.equal((await empty.respond(input('What is MongoDB?'))).generalQuestion, true)
  assert.doesNotMatch(JSON.stringify(captured.messages), /APPROVED_FACTS|Indux|Graphic Era/)
  const service = createRecruiterService({ config: reliabilityConfig, groq: provider })
  await service.respond(input('explain it simply', [{ role: 'user', content: 'react' }, { role: 'assistant', content: 'PRIVATE_HISTORY' }]))
  assert.ok(captured.messages.some(m => m.role === 'user' && m.content === 'react'))
  assert.doesNotMatch(JSON.stringify(captured.messages), /PRIVATE_HISTORY|APPROVED_FACTS/)
})

test('reliability: one fallback on rejection, safe diagnostics, and no retry loops', async () => {
  for (const status of [400, 404, 503]) {
    let primary = 0, backup = 0
    const metrics = []
    const service = createRecruiterService({ config: reliabilityConfig, onMetrics: m => metrics.push(m),
      groq: reliabilityProvider(() => { primary++; throw Object.assign(new Error('Sensitive provider body'), { status, error: { code: status === 400 ? 'json_validate_failed' : 'model_not_found', failed_generation: 'SECRET' } }) }),
      gemini: reliabilityProvider(() => { backup++; return reliabilityStream({ factIds: [], answer: 'React is a JavaScript library for user interfaces.' }) }),
    })
    assert.equal((await service.respond(input('What is React?'))).provider, 'gemini')
    assert.equal(primary, 1); assert.equal(backup, 1)
    assert.equal(service.statistics().rateLimits, 0)
    assert.doesNotMatch(JSON.stringify(metrics), /Sensitive|SECRET|test-recruiter|test-backup/)
  }
  let calls = 0
  const failing = reliabilityProvider(() => { calls++; throw Object.assign(new Error('Upstream'), { status: 503 }) })
  const service = createRecruiterService({ config: reliabilityConfig, groq: failing, gemini: failing })
  await assert.rejects(service.respond(input('What is React?')), { code: 'AI_UNAVAILABLE' })
  assert.equal(calls, 2)
})

test('reliability: complete answers, citations, context-safe cache and clarification', async () => {
  let calls = 0
  const groq = reliabilityProvider(request => {
    calls++
    const context = JSON.parse(request.messages[0].content.split('APPROVED_FACTS:\n')[1])
    const ids = context.filter(f => f.kind === 'project_name').map(f => f.id)
    return reliabilityStream({ factIds: [...ids, ids[0]], answer: 'Shubham worked on CRM as internship work at Indux Technology. Other portfolio projects include EventVerse, AI Chatbot (Violet), and the React.js & Firebase E-Commerce Platform.' })
  })
  const service = createRecruiterService({ config: reliabilityConfig, groq })
  const first = await service.respond(input('What projects has Shubham worked on?'))
  const second = await service.respond(input('What projects has Shubham worked on?', [{ role: 'user', content: 'name' }, { role: 'assistant', content: 'Wrong old answer.' }]))
  assert.equal(first.text, second.text); assert.equal(calls, 1)
  const clarify = createRecruiterService({ config: reliabilityConfig, groq: reliabilityProvider(() => reliabilityStream({ factIds: [], answer: 'Which project are you asking about?' })) })
  assert.equal((await clarify.respond(input('when?', [{ role: 'user', content: 'his projects' }]))).text, 'Which project are you asking about?')
  const bad = createRecruiterService({ config: reliabilityConfig, groq: reliabilityProvider(request => {
    const f = JSON.parse(request.messages[0].content.split('APPROVED_FACTS:\n')[1]).find(f => f.kind === 'name')
    return reliabilityStream({ factIds: [f.id], answer: 'His salary is 999999.' })
  }) })
  await assert.rejects(bad.respond(input('What is his salary?')), { code: 'UNAPPROVED_AI_REFERENCE' })
})

test('reliability: quota threshold, reset recovery, daily holds and stale headers', () => {
  let time = 100000
  const meter = createRecruiterTokenBudget({ now: () => time })
  const first = meter.reserve(100, 10)
  meter.observe(first.ticket, new Headers({ 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '1300', 'x-ratelimit-reset-tokens': '10s' }))
  meter.finish(first.ticket, { totalTokens: 100, completionTokens: 10 })
  assert.equal(meter.reserve(100, 10).provider, 'gemini')
  time += 10001
  const next = meter.reserve(100, 10)
  assert.equal(next.provider, 'groq')
  meter.observe(next.ticket, new Headers({ 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '7900', 'x-ratelimit-reset-tokens': '1s', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1h' }))
  meter.finish(next.ticket, { totalTokens: 100, completionTokens: 10 })
  time += 1001
  assert.equal(meter.reserve(100, 10).reason, 'daily_quota_exhausted')
  time += 3600000
  assert.equal(meter.reserve(100, 10).provider, 'groq')
  assert.equal(meter.reserve(100, 10).reason, 'quota_unknown_or_stale')
})

test('recovery: bounded retry, fallback, deadlines and cancellation', async () => {
  const { recoverRecruiterRequest } = await import('../recruiter.js')
  const controller = new AbortController()
  let calls = 0
  const waits = []
  const options = { signal: controller.signal, timeoutMs: 15000, clock: () => 0, wait: async ms => waits.push(ms) }
  assert.equal(await recoverRecruiterRequest(async () => { if (++calls === 1) throw { recoverable: true, retryAfterSeconds: 4 }; return 'ok' }, options), 'ok')
  assert.equal(calls, 2); assert.deepEqual(waits, [4000])
  const routes = []
  await assert.rejects(recoverRecruiterRequest(async provider => { routes.push(provider); throw Object.assign(new Error('temporary'), { recoverable: true, canUseGemini: !provider }) }, options))
  assert.deepEqual(routes, [undefined, 'gemini', 'gemini'])
  calls = 0
  await assert.rejects(recoverRecruiterRequest(async () => { calls++; throw { recoverable: true, retryAfterSeconds: 60 } }, options))
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(recoverRecruiterRequest(async () => { calls++; throw new Error('configuration') }, options))
  assert.equal(calls, 1)
  const stopped = new AbortController()
  const pending = recoverRecruiterRequest(async () => { throw { recoverable: true } }, { signal: stopped.signal, timeoutMs: 15000 })
  setImmediate(() => stopped.abort())
  await assert.rejects(pending, { name: 'AbortError' })
})
