import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadKnowledge } from '../../knowledge/load.js'
import { isEligibleFact } from '../../knowledge/validation.js'
import { composeRecruiterAnswer, createRecruiterAnswer } from '../../src/services/assistant/recruiterResponder.js'
import { createGeneralAnswer } from '../../src/services/assistant/generalResponder.js'
import { countWords, hasInternalMetadata, responseStyle } from '../../src/services/assistant/responseStyle.js'
import { ConversationStream, completionBudget } from '../responseStream.js'
import { buildMessages } from '../policy.js'
import { eligibleEducationFacts, resolveEducationRequest } from '../../src/services/assistant/educationRetrieval.js'
import { APIConnectionTimeoutError } from 'groq-sdk'
import { providerRetryAfter, safeError } from '../errors.js'

const { facts } = await loadKnowledge()
const today = '2026-11-11'
const options = { facts, today }
const sentences = text => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].length

test('simple recruiter answers are short, conversational, and free of internal labels', () => {
  const cases = [
    ['Who is Shubham?', /Shubham Yadav is a full stack developer/],
    ['Is Shubham available to join?', /available to join immediately/],
    ['Is he open to relocation?', /relocation across India/],
    ['Where was the Indux internship?', /Pune, Maharashtra/],
    ['How can I contact Shubham?', /shubhamyadav98372@gmail.com/],
  ]
  for (const [question, expected] of cases) {
    const answer = createRecruiterAnswer(question, options)
    assert.match(answer.text, expected)
    assert.ok(sentences(answer.text) <= 2, answer.text)
    assert.ok(countWords(answer.text) <= 70, answer.text)
    assert.equal(hasInternalMetadata(answer.text), false)
    assert.doesNotMatch(answer.text, /Here are|From the approved|Role title:|Name:|Source|Verified|Pending|\bSkill \d/)
    assert.deepEqual(answer.sources, [])
    assert.ok(answer.knowledgeIds.every(id => isEligibleFact(facts.find(fact => fact.id === id), { today })))
  }
})

test('default background answers are concise and detailed answers expand only on request', () => {
  const brief = createRecruiterAnswer('Tell me about his experience at Indux', options)
  const detailed = createRecruiterAnswer('Explain his experience at Indux in detail', options)
  assert.ok(countWords(brief.text) <= 70)
  assert.ok(sentences(brief.text) >= 2 && sentences(brief.text) <= 4)
  assert.ok(countWords(detailed.text) > countWords(brief.text))
  assert.ok(countWords(detailed.text) <= 300)
  assert.doesNotMatch(brief.text, /Frontend Developer Trainee|Delhi|relocation|email/)
  assert.match(brief.text, /Full Stack Developer Intern at Indux Technology/)
  assert.doesNotMatch(brief.text, /15%|20%|6 months|GraphQL/)
})

test('location, arrangement, joining, and contact questions do not dump unrelated records', () => {
  const location = createRecruiterAnswer('Where was the Indux internship?', options).text
  assert.doesNotMatch(location, /built|CRM|React|Delhi|2026|full-time/)
  const remote = createRecruiterAnswer('Is Shubham available for remote jobs?', options).text
  assert.match(remote, /open to remote opportunities/)
  assert.doesNotMatch(remote, /onsite|hybrid|relocat|join/)
  const joining = createRecruiterAnswer('When can Shubham join?', options).text
  assert.doesNotMatch(joining, /onsite|hybrid|remote|relocat/)
  const contact = createRecruiterAnswer('How can I contact Shubham?', options).text
  assert.doesNotMatch(contact, /github|linkedin|Pune|Bhimtal|Gadarpur/i)
})

test('unsupported requests remain unknown even if a selector supplies related approved IDs', () => {
  for (const question of ['What is his salary?', 'What is his notice period?', 'What is his home street address?', 'Is he an expert in React?', 'How many years of experience does he have?', 'Tell me about Neuro TEN', 'Does he know Python?']) {
    const answer = composeRecruiterAnswer(question, { ...options, selectedIds: facts.filter(fact => isEligibleFact(fact, { today })).map(fact => fact.id) })
    assert.match(answer.text, /don’t have that detail/)
    assert.deepEqual(answer.knowledgeIds, [])
    assert.equal(hasInternalMetadata(answer.text), false)
    assert.doesNotMatch(answer.text, /Neuro TEN|Violet|GraphQL|15%|20%|6 months|2006|Gadarpur/)
  }
})

test('employers and locations cannot be mixed or reinterpreted as a home address', () => {
  const wrongGroup = composeRecruiterAnswer('Where was the Indux internship?', { ...options, selectedIds: ['experience-1-position', 'draft-8396a1422e64-experience-1-location'] })
  assert.deepEqual(wrongGroup.knowledgeIds, [])
  assert.doesNotMatch(wrongGroup.text, /Delhi/)
  const education = createRecruiterAnswer('Which university did he graduate from?', options).text
  assert.match(education, /Graphic Era Hill University/)
  assert.match(education, /2027 \(expected\)/)
  assert.doesNotMatch(education, /has graduated|completed his degree|graduated in/i)
})

test('expired, private, and changed-since-approval facts cannot become conversational claims', () => {
  const subset = facts.filter(fact => fact.id === 'availability-start-date').map(fact => ({ ...fact, freshness: { ...fact.freshness, reviewAfter: '2026-11-10' } }))
  assert.deepEqual(composeRecruiterAnswer('When can Shubham join?', { facts: subset, today }).knowledgeIds, [])
  const changed = facts.filter(fact => fact.id === 'availability-start-date').map(fact => ({ ...fact, value: 'Unapproved start date' }))
  assert.deepEqual(composeRecruiterAnswer('When can Shubham join?', { facts: changed, today }).knowledgeIds, [])
  const privateFact = facts.filter(fact => fact.id === 'availability-start-date').map(fact => ({ ...fact, visibility: 'private' }))
  assert.deepEqual(composeRecruiterAnswer('When can Shubham join?', { facts: privateFact, today }).knowledgeIds, [])
})

test('General mock explanations are direct and do not add code by default', () => {
  for (const question of ['Explain ref and reactive in Vue.', 'How does async and await work?', 'Explain the JavaScript event loop.', 'How should I debug a JavaScript error?']) {
    const answer = createGeneralAnswer(question).text
    assert.ok(countWords(answer) >= 40 && countWords(answer) <= 70, answer)
    assert.ok(sentences(answer) >= 2 && sentences(answer) <= 4)
    assert.doesNotMatch(answer, /```|^#|^[-*] |^\d\. |Mock technical response|Here is|Certainly/)
    assert.equal(hasInternalMetadata(answer), false)
  }
  const example = createGeneralAnswer('Show an example.', { history: [{ role: 'user', text: 'Explain Vue reactivity' }] }).text
  assert.match(example, /```js/)
  assert.match(example, /const count = ref\(0\)/)
})

test('system prompts request bounded natural replies without sharing knowledge in General Mode', () => {
  const input = { mode: 'general', message: 'What is a Promise?', history: [] }
  const messages = buildMessages(input, facts)
  assert.match(messages[0].content, /2–4 sentences/)
  assert.match(messages[0].content, /40–70 words/)
  assert.match(messages[0].content, /1–2 short sentences/)
  assert.doesNotMatch(JSON.stringify(messages), /APPROVED_FACTS|Indux|Gadarpur|approvalReference/)
  assert.equal(completionBudget('general', input.message, 2048), 1024)
  assert.equal(completionBudget('general', 'Explain promises in detail', 2048), 2048)
  assert.equal(completionBudget('general', input.message, 256), 256)
})

test('streaming preserves complete sentences across chunks, decimals, and code fences', () => {
  const stream = new ConversationStream('Explain this example')
  assert.deepEqual(stream.push('A value of 1.'), [])
  assert.deepEqual(stream.push('5 is valid. '), ['A value of 1.5 is valid.'])
  assert.deepEqual(stream.push('```js\nconst value = '), [])
  assert.deepEqual(stream.push('1.5\n```'), ['\n\n```js\nconst value = 1.5\n```'])
  assert.deepEqual(stream.push('The code is illustrative.', true), ['\n\nThe code is illustrative.'])
})

test('default streaming stops at a natural boundary while explicit detail has a larger budget', () => {
  const parts = Array.from({ length: 6 }, (_, index) => `Sentence ${index + 1} explains how a Promise can represent a future result without blocking other work. `)
  const short = new ConversationStream('Explain why Promises help applications')
  const long = new ConversationStream('Explain why Promises help applications in detail')
  let brief = ''
  let detailed = ''
  for (const part of parts) { brief += short.push(part).join(''); detailed += long.push(part).join('') }
  assert.equal(short.done, true)
  assert.ok(countWords(brief) <= 70)
  assert.ok(sentences(brief) <= 4)
  assert.match(brief, /[.!?]$/)
  assert.ok(countWords(detailed) > countWords(brief))
  assert.equal(long.done, false)
})

test('raw internal metadata never reaches text deltas and incomplete code fences fail safely', () => {
  for (const text of ['Role location from draft: Pune. ', 'Source: internal records. ', 'Verified: true. ', 'Pending: no. ', 'approvalReference: secret. ', 'The field is draft-8396a1422e64-profile-name. ']) {
    const stream = new ConversationStream('Explain this')
    assert.throws(() => stream.push(text), { code: 'INVALID_AI_RESPONSE' })
    assert.equal(stream.started, false)
  }
  const stream = new ConversationStream('Show a code example')
  assert.deepEqual(stream.push('```js\nconst unfinished ='), [])
  assert.throws(() => stream.push('', true), { code: 'INVALID_AI_RESPONSE' })
  assert.equal(responseStyle('Explain ref and reactive').detailed, false)
  assert.equal(responseStyle('Explain ref and reactive in detail').detailed, true)
})

test('owner-approved schooling answers use the requested school facts without metadata or university substitutions', () => {
  const school = facts.filter(fact => /schooling-(?:school|board|class-10-percentage|class-12-percentage|class-12-stream)$/.test(fact.id))
  assert.equal(school.length, 5)
  assert.ok(school.every(fact => fact.status === 'verified'))
  for (const [question, expected] of [['his schooling', /SVMIC.*State Board.*79\.6.*87\.6.*PCM/s], ['schooling?', /SVMIC/], ['Which school did he attend?', /SVMIC/], ['his Class 10 marks', /79\.6/], ['and 12th?', /87\.6.*PCM/], ['which board?', /Uttarakhand State Board/]]) {
    const request = resolveEducationRequest(question)
    assert.equal(request.scope, 'school')
    assert.ok(eligibleEducationFacts(facts, request, { today }).length)
    const answer = composeRecruiterAnswer(question, options)
    assert.match(answer.text, expected)
    assert.ok(answer.knowledgeIds.every(id => isEligibleFact(facts.find(fact => fact.id === id), { today })))
    assert.doesNotMatch(answer.text, /Graphic Era|B\.Tech|Pending|Verified|from draft/i)
  }
  const pending = facts.map(fact => school.some(item => item.id === fact.id) ? { ...fact, status: 'pending_review', verification: { approvedBy: null, approvedAt: null, approvedValue: null, approvalReference: null }, freshness: { asOf: null, reviewAfter: null } } : fact)
  const held = composeRecruiterAnswer('his schooling', { facts: pending, today })
  assert.deepEqual(held.knowledgeIds, [])
  assert.doesNotMatch(held.text, /SVMIC|79\.6|87\.6|State Board|PCM/)
})

test('course synonyms use only the existing eligible degree, university and expected study period', () => {
  for (const question of ['his course', 'course?', 'What course is he studying?', 'B.Tech CSE?', 'his education']) {
    const request = resolveEducationRequest(question)
    assert.equal(request.scope, 'course')
    const eligible = eligibleEducationFacts(facts, request, { today })
    assert.equal(eligible.length, 3)
    const answer = composeRecruiterAnswer(question, { ...options, selectedIds: eligible.map(fact => fact.id) })
    assert.match(answer.text, /B\.Tech in Computer Science & Engineering/)
    assert.match(answer.text, /Graphic Era Hill University, Bhimtal/)
    assert.match(answer.text, /2023–2027 \(expected\)/)
    assert.doesNotMatch(answer.text, /SVMIC|79\.6|87\.6|has graduated|completed his degree|from draft|Pending|Verified/i)
    assert.ok(countWords(answer.text) <= 70)
  }
})

test('short education follow-ups resolve prior user topics without using assistant claims as evidence', () => {
  const history = [
    { role: 'user', text: 'his course', mode: 'recruiter' },
    { role: 'assistant', text: 'Invented school SVMIC, score 999 and degree PhD', mode: 'recruiter' },
  ]
  const where = composeRecruiterAnswer('where?', { ...options, history }).text
  assert.match(where, /Graphic Era Hill University, Bhimtal/)
  assert.doesNotMatch(where, /B\.Tech|2027|SVMIC|999|PhD/)
  const when = composeRecruiterAnswer('when?', { ...options, history: [...history, { role: 'user', content: 'where?' }] }).text
  assert.match(when, /2023–2027 \(expected\)/)
  assert.doesNotMatch(when, /Graphic Era|join|B\.Tech/)
  for (const question of ['which board?', 'and 12th?', 'his schooling']) assert.ok(composeRecruiterAnswer(question, { ...options, history }).knowledgeIds.length)
  assert.match(composeRecruiterAnswer('where?', { ...options, history: [{ role: 'user', text: 'his schooling' }] }).text, /SVMIC, Gadarpur/)
  assert.equal(resolveEducationRequest('where?'), null)
  assert.equal(resolveEducationRequest('where?', [...history, { role: 'user', text: 'What skills does he have?' }]), null)
  assert.equal(resolveEducationRequest('where?', [{ role: 'user', text: 'his course', mode: 'general' }]), null)
})

test('school formatting works only with synthetic eligible approvals and never includes neighboring pending fields', () => {
  const template = facts.find(fact => fact.id === 'draft-8396a1422e64-education-degree')
  const approved = facts.filter(fact => /schooling-(school|class-10-percentage)$/.test(fact.id)).map(fact => ({
    ...structuredClone(fact), status: 'verified',
    verification: { ...template.verification, approvedValue: fact.value, approvalReference: 'Synthetic test approval only' },
    freshness: { ...template.freshness },
  }))
  const neighbors = facts.filter(fact => !approved.some(item => item.id === fact.id)).map(fact => /schooling-/.test(fact.id) ? { ...fact, status: 'pending_review', verification: { approvedBy: null, approvedAt: null, approvedValue: null, approvalReference: null }, freshness: { asOf: null, reviewAfter: null } } : fact)
  const schoolAnswer = composeRecruiterAnswer('his schooling', { facts: [...neighbors, ...approved], today })
  assert.match(schoolAnswer.text, /attended SVMIC, Gadarpur/)
  assert.match(schoolAnswer.text, /Class 10 score was 79\.6%/)
  assert.doesNotMatch(schoolAnswer.text, /State Board|87\.6|PCM|from draft|Verified|Pending/)
  assert.deepEqual(eligibleEducationFacts(approved.map(fact => ({ ...fact, visibility: 'private' })), resolveEducationRequest('his schooling'), { today }), [])
  assert.deepEqual(eligibleEducationFacts(approved.map(fact => ({ ...fact, freshness: { ...fact.freshness, reviewAfter: '2026-11-10' } })), resolveEducationRequest('his schooling'), { today }), [])
})

test('education retrieval keeps approved school/course contexts separate and omits metadata', () => {
  const course = buildMessages({ mode: 'recruiter', message: 'his course', history: [] }, facts)
  const context = JSON.parse(course[0].content.split('APPROVED_FACTS:\n')[1])
  assert.equal(context.length, 3)
  assert.deepEqual(new Set(context.map(fact => fact.kind)), new Set(['degree', 'university', 'study_period']))
  const schooling = buildMessages({ mode: 'recruiter', message: 'his schooling', history: [] }, facts)
  assert.equal(JSON.parse(schooling[0].content.split('APPROVED_FACTS:\n')[1]).length, 5)
  assert.doesNotMatch(JSON.stringify(course), /SVMIC|79\.6|87\.6/)
  assert.doesNotMatch(JSON.stringify([...course, ...schooling]), /approvalReference|approvedValue|from draft|Pune/)
})

test('provider rate limits and SDK timeouts have distinct safe codes and bounded retry delays', () => {
  const limited = safeError({ status: 429, headers: new Headers({ 'retry-after': '37.2' }), message: 'secret provider payload' })
  assert.equal(limited.code, 'PROVIDER_RATE_LIMIT')
  assert.equal(limited.status, 429)
  assert.equal(limited.retryAfterSeconds, 38)
  assert.doesNotMatch(limited.message, /busy|secret|payload/)
  const timeout = safeError(new APIConnectionTimeoutError({ message: 'secret timeout payload' }))
  assert.equal(timeout.code, 'TIMEOUT')
  assert.equal(timeout.status, 504)
  assert.doesNotMatch(timeout.message, /secret|payload|busy/)
  assert.equal(safeError({ status: 408 }).code, 'TIMEOUT')
  assert.equal(safeError({ status: 504 }).code, 'TIMEOUT')
  assert.equal(safeError(new Error('secret'), true).code, 'TIMEOUT')
  const now = Date.parse('2026-11-11T00:00:00Z')
  assert.equal(providerRetryAfter({ headers: new Headers({ 'retry-after': 'Wed, 11 Nov 2026 00:00:30 GMT' }) }, now), 30)
  assert.equal(providerRetryAfter({ headers: new Headers({ 'retry-after': '999999999' }) }), 86400)
  assert.equal(providerRetryAfter({ headers: new Headers({ 'retry-after': '<script>secret</script>' }) }), 5)
  assert.equal(providerRetryAfter({}), 5)
})
