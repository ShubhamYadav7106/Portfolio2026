import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { loadKnowledge, knowledgeRoot } from '../knowledge/load.js'
import { FACT_STATUSES, isEligibleFact, validateFact, validateKnowledge } from '../knowledge/validation.js'
import { createRecruiterAnswer } from '../src/services/assistant/recruiterResponder.js'
import { splitMessageContent } from '../src/services/assistant/messageContent.js'

const data = await loadKnowledge()
const snapshot = JSON.parse(await readFile(new URL('personal-knowledge.json', knowledgeRoot())))
const today = '2026-11-11'

// Synthetic fixtures only. These approvals never touch personal knowledge files.
function approvedFact(overrides = {}) {
  return {
    id: 'synthetic-skill', title: 'Synthetic skill', value: 'EXAMPLE_LANGUAGE',
    category: 'skills', moduleId: 'skills', legacyEntryId: null,
    status: 'verified', visibility: 'public',
    sources: [{ type: 'owner', reference: 'Synthetic test fixture' }],
    verification: { approvedBy: 'Test fixture', approvedAt: '2026-11-01', approvalReference: 'Synthetic test only', approvedValue: 'EXAMPLE_LANGUAGE' },
    freshness: { asOf: '2026-11-01', reviewAfter: '2026-12-01' },
    ...overrides,
  }
}

test('the approved subset validates while pending, private, and unknown facts stay ineligible', () => {
  assert.deepEqual(data.errors, [])
  assert.equal(data.modules.length, 15)
  assert.equal(data.facts.length, 185)
  assert.equal(data.facts.filter(fact => fact.status === 'verified').length, 152)
  assert.equal(data.facts.filter(fact => fact.status === 'pending_review').length, 33)
  assert.equal(data.facts.filter(fact => isEligibleFact(fact, { today })).length, 148)
  assert.equal(data.facts.filter(fact => fact.value === null || fact.value === '').length, 29)
  for (const fact of data.facts) {
    if (fact.status === 'pending_review') {
      assert.ok(Object.values(fact.verification).every(value => value === null))
      assert.equal(isEligibleFact(fact, { today }), false)
    } else {
      assert.equal(fact.verification.approvedBy, 'Shubham Yadav')
      assert.match(fact.verification.approvalReference, /Conversation approval 2026-11-11/)
      assert.equal(fact.verification.approvedValue, fact.value)
      assert.equal(isEligibleFact(fact, { today }), fact.visibility === 'public')
    }
  }
})

test('migration preserves every original leaf, including presentation metadata', () => {
  const presentation = data.modules.flatMap(module => module.presentation)
  for (const entry of snapshot.entries) {
    function visit(value, suffix = '') {
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) visit(child, suffix + (/^\d+$/.test(key) ? `[${key}]` : `.${key}`))
        return
      }
      const field = entry.source.field + suffix
      const migrated = data.facts.find(fact => fact.legacyEntryId === entry.id && fact.sources.some(source => source.field === field))
        || presentation.find(item => item.legacyEntryId === entry.id && item.source.field === field)
      assert.ok(migrated, `Missing ${entry.id}: ${field}`)
      const officialTitles = { 'experience-1-position': 'Full Stack Developer Intern', 'experience-2-position': 'Frontend Developer Trainee' }
      if (Object.hasOwn(officialTitles, migrated.id)) {
        assert.equal(migrated.value, officialTitles[migrated.id])
        assert.equal(migrated.status, 'verified')
        assert.match(migrated.verification.approvalReference, /decisions 1–9/)
        assert.ok(migrated.sources.some(source => source.reference?.includes('Shubham_FullStack_Developer.pdf')))
      } else if (!Object.is(migrated.value, value)) {
        assert.ok(migrated.sources.some(source => source.reference?.includes(`: ${JSON.stringify(value)}.`)), `Original value missing from merged provenance: ${field}`)
        assert.equal(migrated.verification.approvedValue, migrated.value)
      } else assert.deepEqual(migrated.value, value, field)
    }
    visit(entry.content)
  }
})

test('eligibility requires public visibility, matching approval, and a current review window', () => {
  const fact = approvedFact()
  assert.equal(isEligibleFact(fact, { today }), true)
  assert.equal(isEligibleFact({ ...fact, visibility: 'private' }, { today }), false)
  assert.equal(isEligibleFact({ ...fact, value: 'UNAPPROVED_EDIT' }, { today }), false)
  assert.equal(isEligibleFact({ ...fact, status: 'outdated' }, { today }), false)
  assert.equal(isEligibleFact({ ...fact, status: 'archived' }, { today }), false)
  assert.equal(isEligibleFact({ ...fact, verification: { ...fact.verification, approvalReference: null } }, { today }), false)
  assert.equal(isEligibleFact({ ...fact, freshness: { ...fact.freshness, reviewAfter: '2026-11-10' } }, { today }), false)
  assert.equal(isEligibleFact({ ...fact, freshness: { ...fact.freshness, reviewAfter: today } }, { today }), true)
  assert.equal(isEligibleFact({ ...fact, freshness: { asOf: '2026-11-12', reviewAfter: '2026-12-01' } }, { today }), false)
})

test('invalid approvals, impossible dates, unknown values, and source types fail validation', () => {
  const fact = approvedFact()
  assert.ok(validateFact({ ...fact, verification: {} }, { today }).length)
  assert.ok(validateFact({ ...fact, sources: [] }, { today }).length)
  assert.ok(validateFact({ ...fact, value: null, verification: { ...fact.verification, approvedValue: null } }, { today }).length)
  assert.ok(validateFact({ ...fact, freshness: { asOf: '2026-02-30', reviewAfter: '2026-12-01' } }, { today }).length)
  assert.ok(validateFact({ ...fact, sources: [{ type: 'browser-input', reference: 'untrusted' }] }, { today }).length)
})

test('duplicate IDs, invalid paths, missing modules, and malformed facts are reported', () => {
  const copy = structuredClone(data.modules)
  copy[1].facts[0].id = copy[0].facts[0].id
  assert.ok(validateKnowledge(data.index, copy).errors.some(error => /Duplicate fact ID/.test(error)))
  assert.ok(validateKnowledge({ ...data.index, modules: ['../outside.json'] }, []).errors.some(error => /Invalid module path/.test(error)))
  assert.ok(validateKnowledge(data.index, []).errors.length)
  copy[1].facts[0] = null
  assert.ok(validateKnowledge(data.index, copy).errors.some(error => /Fact must be an object/.test(error)))
})

test('recruiter answer can use a synthetic eligible fact but never neighboring excluded facts', () => {
  const accepted = approvedFact()
  const pending = { ...approvedFact(), id: 'pending-skill', value: 'PENDING_SECRET', status: 'pending_review' }
  const privateFact = { ...approvedFact(), id: 'private-skill', value: 'PRIVATE_SECRET', visibility: 'private' }
  const expired = { ...approvedFact(), id: 'expired-skill', freshness: { asOf: '2026-11-01', reviewAfter: '2026-11-10' } }
  const reply = createRecruiterAnswer('What technical skills are approved?', { facts: [accepted, pending, privateFact, expired], today })
  assert.deepEqual(reply.knowledgeIds, ['synthetic-skill'])
  assert.match(reply.text, /EXAMPLE_LANGUAGE/)
  assert.doesNotMatch(reply.text, /PENDING_SECRET|PRIVATE_SECRET/)
  assert.equal(reply.verification, 'verified')
  assert.equal(createRecruiterAnswer('What technical skills are approved?', { facts: [accepted], today: '2026-12-02' }).verification, 'not_available')
})

test('expired verified facts warn and are excluded without breaking the entire knowledge set', () => {
  const module = { schemaVersion: 2, id: 'sample', title: 'Synthetic sample', category: 'skills', facts: [approvedFact()], presentation: [] }
  const result = validateKnowledge({ schemaVersion: 2, assistantName: 'Test', modules: ['sample.json'] }, [module], { today: '2026-12-02' })
  assert.deepEqual(result.errors, [])
  assert.equal(result.warnings.length, 1)
  assert.equal(isEligibleFact(result.facts[0], { today: '2026-12-02' }), false)
})

test('editor schema and runtime statuses stay aligned', async () => {
  const schema = JSON.parse(await readFile(new URL('../knowledge/schema.json', import.meta.url)))
  assert.deepEqual(schema.$defs.fact.properties.status.enum, FACT_STATUSES)
})

test('code fences remain literal content, and incomplete fences stay plain text', () => {
  const blocks = splitMessageContent('Example:\n```html\n<img src=x onerror=alert(1)>\n```\nEnd.')
  assert.equal(blocks[1].type, 'code')
  assert.equal(blocks[1].text, '<img src=x onerror=alert(1)>')
  assert.equal(blocks[1].language, 'html')
  assert.equal(splitMessageContent('```js\nunfinished')[0].type, 'text')
})

test('Neuro TEN is excluded from both general project lists and specific recruiter answers', () => {
  const neuro = data.facts.filter(fact => fact.moduleId === 'project-2')
  assert.equal(neuro.length, 8)
  for (const fact of neuro) {
    assert.equal(fact.visibility, 'private')
    assert.equal(fact.status, fact.value === null ? 'pending_review' : 'verified')
    assert.equal(isEligibleFact(fact, { today }), false)
  }
  for (const question of ['What projects has Shubham worked on?', 'Tell me about Neuro TEN']) {
    const reply = createRecruiterAnswer(question, { facts: data.facts, today })
    assert.doesNotMatch(reply.text, /Neuro TEN/)
    assert.ok(reply.knowledgeIds.every(id => !neuro.some(fact => fact.id === id)))
  }
})

test('explicit joining, opportunity types, working arrangements, and relocation are current approved facts', () => {
  const byId = new Map(data.facts.map(fact => [fact.id, fact]))
  const expected = {
    'availability-hiring': 'Available for full-time jobs and internships',
    'availability-start-date': 'Immediate joiner',
    'availability-arrangement': 'Onsite, hybrid, and remote',
    'availability-relocation': 'Open to relocation across India',
  }
  for (const [id, value] of Object.entries(expected)) {
    const fact = byId.get(id)
    assert.equal(fact.value, value)
    assert.equal(fact.status, 'verified')
    assert.equal(fact.freshness.asOf, today)
    assert.equal(fact.freshness.reviewAfter, '2026-12-11')
    assert.equal(isEligibleFact(fact, { today: '2026-12-12' }), false)
  }
  const reply = createRecruiterAnswer('Is Shubham available for full-time jobs?', { facts: data.facts, today })
  assert.match(reply.text, /join immediately/)
  assert.doesNotMatch(reply.text, /onsite|hybrid|remote|relocation/i)
  assert.match(createRecruiterAnswer('What work arrangements does Shubham accept?', { facts: data.facts, today }).text, /onsite, hybrid, and remote/i)
  assert.match(createRecruiterAnswer('Is Shubham open to relocation?', { facts: data.facts, today }).text, /relocation across India/)
})

test('unresolved metrics stay pending while explicitly approved personal details and work claims become eligible', () => {
  const held = data.facts.filter(fact => /15%|20%|6 months/.test(String(fact.value)))
  assert.equal(held.length, 3)
  for (const fact of held) assert.equal(fact.status, 'pending_review', fact.id)
  for (const fact of data.facts.filter(fact => /schooling|profile-birth-year|profile-coding-start|profile-hobbies|suggested-wording/.test(fact.id))) assert.equal(fact.status, 'verified', fact.id)
  assert.equal(data.facts.find(fact => fact.id === 'experience-1-hashtags-6').status, 'verified')
  assert.equal(data.facts.find(fact => fact.id === 'draft-8396a1422e64-profile-joining').status, 'pending_review')
  assert.equal(data.facts.filter(fact => /^undefined\b/.test(fact.title)).length, 0)
  const biography = data.facts.find(fact => fact.id === 'profile-biography-0')
  assert.equal(biography.title, 'Biography paragraph 1')
  assert.equal(biography.value, snapshot.entries.find(entry => entry.id === 'profile-biography').content[0])
  const oldSkills = snapshot.entries.find(entry => entry.id === 'skills').content
  for (let index = 0; index < oldSkills.length; index++) {
    const fact = data.facts.find(fact => fact.id === `skills-${index}`)
    assert.equal(fact.title, `Skill ${index + 1}`)
    assert.equal(fact.value, oldSkills[index])
  }
})

test('semantic duplicate records resolve to one canonical ID while contextual technology relationships remain', () => {
  const normalize = value => String(value).toLowerCase().replace('openai codex', 'codex').replace('react.js', 'react').replace('tailwind css', 'tailwind')
  const skills = data.facts.filter(fact => fact.category === 'skills' && fact.value !== null)
  assert.equal(new Set(skills.map(fact => normalize(fact.value))).size, skills.length)
  assert.equal(data.facts.filter(fact => fact.category === 'project' && /description$/.test(fact.id)).length, 5)
  assert.equal(data.facts.filter(fact => /schooling-class-rankings-/.test(fact.id)).length, 0)
  assert.match(data.facts.find(fact => fact.id === 'draft-8396a1422e64-achievements-1').value, /Class 7: 3rd.*Class 8: 1st.*Class 9: 1st.*Class 11: 3rd/)
  assert.ok(data.facts.some(fact => fact.id === 'skills-2' && fact.value === 'React'))
  assert.ok(data.facts.some(fact => fact.id === 'experience-1-hashtags-0' && fact.value === 'React.js'))
  assert.ok(data.facts.some(fact => fact.id === 'experience-2-hashtags-0' && fact.value === 'React.js'))
  assert.ok(data.index.reviewQuestions.some(question => question.includes('draft-8396a1422e64-profile-joining')))
})
