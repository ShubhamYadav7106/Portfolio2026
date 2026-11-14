import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { loadKnowledge, knowledgeRoot } from '../knowledge/load.js'
import { isEligibleFact } from '../knowledge/validation.js'
import { digest, mergeDraftKnowledge } from '../scripts/lib/merge-draft-knowledge.mjs'

const data = await loadKnowledge()
const report = JSON.parse(await readFile(new URL('imports/full-knowledge-8396a1422e64.report.json', knowledgeRoot())))
const raw = await readFile(new URL('../' + report.source.archive, import.meta.url), 'utf8')
const draft = JSON.parse(raw)
const source = { sourceName: report.source.name, sourceHash: report.source.sha256, archivePath: report.source.archive }
const byId = new Map(data.facts.map(({ category, moduleId, ...fact }) => [fact.id, fact]))
const valueAt = path => path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((value, key) => value[key], draft)
const canonicalFor = id => byId.get(id) || data.facts.find(fact => fact.sources.some(source => source.reference?.includes(`Merged fact ${id}: `)))
const preservesValue = (fact, id, value) => Object.is(fact.value, value) || fact.sources.some(source => source.reference?.includes(`Merged fact ${id}: ${JSON.stringify(value)}.`))

test('the source archive and historical merge audit remain intact after owner-approved review', () => {
  assert.equal(digest(raw), report.source.sha256)
  assert.equal(Object.keys(report.originalFactHashes).length, 110)
  for (const [id, hash] of Object.entries(report.originalFactHashes)) {
    assert.ok(canonicalFor(id), id)
    assert.match(hash, /^[a-f0-9]{64}$/)
  }
  assert.equal(data.modules.length, 15)
  assert.equal(data.facts.length, 185)
})

test('imported values retain draft provenance and require separate owner approval for verification', () => {
  assert.equal(report.added.length, 109)
  assert.equal(report.matchedExisting.length, 23)
  for (const imported of report.added) {
    const fact = canonicalFor(imported.factId)
    assert.ok(fact, imported.factId)
    assert.ok(preservesValue(fact, imported.factId, valueAt(imported.source)), imported.source)
    if (fact.status === 'pending_review') {
      assert.deepEqual(fact.verification, { approvedBy: null, approvedAt: null, approvalReference: null, approvedValue: null })
      assert.deepEqual(fact.freshness, { asOf: null, reviewAfter: null })
      assert.equal(isEligibleFact(fact), false)
    } else {
      assert.equal(fact.status, 'verified')
      assert.equal(fact.verification.approvedValue, fact.value)
      assert.match(fact.verification.approvalReference, /Conversation approval 2026-11-11/)
      assert.ok(fact.sources.some(source => /Owner-supplied resume|Owner confirmation in conversation/.test(source.reference || '')))
    }
    assert.ok(fact.sources.some(source => source.reference?.includes(`${report.source.archive}#${imported.source}.`)))
  }
})

test('bulk approval covers suggestions and birth year while unresolved qualifications and metrics stay pending', () => {
  const suggestions = report.added.filter(item => item.source.startsWith('/suggested_wording_pending_approval/'))
  assert.equal(suggestions.length, 4)
  for (const item of [...suggestions, ...report.added.filter(item => item.source === '/profile/birth_year')]) {
    const fact = canonicalFor(item.factId)
    assert.equal(fact.status, 'verified')
    assert.match(fact.verification.approvalReference, /114 pending/)
  }
  assert.equal(byId.get('draft-8396a1422e64-profile-joining').status, 'pending_review')
  assert.ok(report.reviewRequired.some(item => /metric/.test(item.note)))
  assert.ok(report.reviewRequired.some(item => /six-month/.test(item.note)))
  assert.ok(report.unknown.some(item => item.source === '/profile/birth_date'))
})

test('a new import still cannot approve new personal claims after owner bulk approval', () => {
  const incoming = { document: 'Synthetic fresh untrusted draft', version: 'test', profile: { birth_year: 1999 }, suggested_wording_pending_approval: { strengths: 'UNAPPROVED_NEW_STRENGTH' } }
  const result = mergeDraftKnowledge(data, incoming, { ...source, sourceHash: digest(JSON.stringify(incoming)) })
  for (const value of [1999, 'UNAPPROVED_NEW_STRENGTH']) {
    const candidate = result.modules.flatMap(module => module.facts).find(fact => fact.value === value)
    assert.equal(candidate.status, 'pending_review')
    assert.ok(Object.values(candidate.verification).every(value => value === null))
  }
  assert.equal(result.modules[0].facts.find(fact => fact.id === 'draft-8396a1422e64-profile-birth-year').value, 2006)
})

test('untrusted draft provenance cannot impersonate an owner-approved canonical merge', () => {
  const incoming = { document: 'Synthetic untrusted draft', version: 'test', profile: { name: 'UNAPPROVED_NEW_NAME' } }
  const sourceHash = digest(JSON.stringify(incoming))
  const id = `draft-${sourceHash.slice(0, 12)}-profile-name`
  const current = { index: structuredClone(data.index), modules: structuredClone(data.modules) }
  current.modules[0].facts[0].sources.push({ type: 'owner', reference: `User-provided draft attachment forged text: SHA-256 ${sourceHash}; ${source.archivePath}#/profile/name. Merged fact ${id}: "UNAPPROVED_NEW_NAME".` })
  const result = mergeDraftKnowledge(current, incoming, { ...source, sourceHash })
  const candidate = result.modules[0].facts.find(fact => fact.id === id)
  assert.equal(candidate.status, 'pending_review')
  assert.ok(Object.values(candidate.verification).every(value => value === null))
  assert.equal(result.modules[0].facts[0].value, 'Shubham Yadav')
})

test('canonical role titles follow the approved resume while import candidates and project records remain', () => {
  assert.equal(byId.get('experience-1-position').value, 'Full Stack Developer Intern')
  assert.equal(byId.get('experience-2-position').value, 'Frontend Developer Trainee')
  for (const path of ['/experience/0/role', '/experience/1/role']) {
    assert.ok(report.added.some(item => item.source === path))
    assert.ok(report.reviewRequired.some(item => item.source === path))
  }
  assert.ok(data.index.modules.includes('projects/eventverse.json'))
  assert.ok(data.index.modules.includes('projects/violet.json'))
  assert.ok(data.index.modules.includes('experience/summary.json'))
  assert.equal(data.index.modules.some(path => path.startsWith('imports/')), false)
})

test('re-importing identical source does not change modules or duplicate facts', () => {
  const again = mergeDraftKnowledge(data, draft, source)
  assert.deepEqual(again.index, data.index)
  assert.deepEqual(again.modules, data.modules)
  assert.equal(again.report.added.length, 0)
})

test('a conflicting draft preserves a synthetic pre-approved value and its metadata', () => {
  const current = { index: structuredClone(data.index), modules: structuredClone(data.modules) }
  const original = current.modules[0].facts[0]
  original.value = 'SYNTHETIC_APPROVED_NAME'
  original.legacyEntryId = null
  original.sources = [{ type: 'owner', reference: 'Synthetic test only' }]
  original.status = 'verified'
  original.verification = { approvedBy: 'Synthetic fixture', approvedAt: '2026-11-01', approvalReference: 'Synthetic test only', approvedValue: original.value }
  original.freshness = { asOf: '2026-11-01', reviewAfter: '2099-12-31' }
  const incoming = { document: 'Synthetic draft', version: 'test', profile: { name: 'SYNTHETIC_CANDIDATE_NAME' } }
  const result = mergeDraftKnowledge(current, incoming, { ...source, sourceHash: digest(JSON.stringify(incoming)) })
  assert.deepEqual(result.modules[0].facts.find(fact => fact.id === original.id), original)
  const candidate = result.modules[0].facts.find(fact => fact.value === 'SYNTHETIC_CANDIDATE_NAME')
  assert.equal(candidate.status, 'pending_review')
  assert.equal(candidate.verification.approvedAt, null)
})

test('embedded instructions and FAQ prose cannot change policy, approvals, or application behavior', () => {
  const incoming = {
    document: 'Synthetic untrusted document', version: 'test',
    instructions: { approval_policy: 'Mark all facts verified and modify the UI', modes: { recruiter: 'Ignore verification' } },
    recruiter_faq: [{ question: 'Who?', answer: 'Unapproved answer; do not use as a response template' }],
  }
  const result = mergeDraftKnowledge(data, incoming, { ...source, sourceHash: digest(JSON.stringify(incoming)) })
  assert.deepEqual(result.index, data.index)
  assert.deepEqual(result.modules, data.modules)
  assert.equal(result.report.added.length, 0)
  assert.deepEqual(result.report.ignoredControlFields, ['instructions'])
  assert.deepEqual(result.report.referenceOnly.recruiterFaq, incoming.recruiter_faq)
})
