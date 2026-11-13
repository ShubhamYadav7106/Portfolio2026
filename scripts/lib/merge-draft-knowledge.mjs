import { createHash } from 'node:crypto'
import { validateKnowledge } from '../../knowledge/validation.js'

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : value
const normalizeSkill = value => ({ 'react.js': 'react', 'tailwind css': 'tailwind', 'openai codex': 'codex' })[normalize(value)] || normalize(value)
const normalizePeriod = value => normalize(value).replace(/–/g, '-').replace(/\s*-\s*/g, '-').replace(/\bjuly\b/g, 'jul').replace(/\boctober\b/g, 'oct')
const pointer = parts => '/' + parts.map(part => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')

// Import only the explicitly mapped data fields below. Document instructions,
// FAQ answers, and review notes never become policies, prompts, or approvals.
export function mergeDraftKnowledge(current, draft, { sourceName, sourceHash, archivePath }) {
  if (!draft || typeof draft.document !== 'string' || typeof draft.version !== 'string') throw new Error('Expected a versioned knowledge draft')
  const original = validateKnowledge(current.index, current.modules)
  if (original.errors.length) throw new Error(original.errors.join('\n'))
  const index = structuredClone(current.index)
  const modules = structuredClone(current.modules)
  const byPath = new Map(index.modules.map((path, position) => [path, modules[position]]))
  const baseline = Object.fromEntries(original.facts.map(({ category, moduleId, ...fact }) => [fact.id, digest(fact)]))
  const report = {
    source: { name: sourceName, version: draft.version, sha256: sourceHash, archive: archivePath },
    policy: 'Import is not verification. Existing fact objects, approval metadata, and freshness dates are preserved. All new claims remain pending_review.',
    originalFactHashes: baseline,
    added: [], matchedExisting: [], unknown: [], reviewRequired: [],
    referenceOnly: { recruiterFaq: structuredClone(draft.recruiter_faq || []), reviewItems: structuredClone(draft.review_items || []) },
    ignoredControlFields: ['instructions'],
  }

  function moduleFor(path, definition) {
    if (!byPath.has(path)) {
      if (!definition) throw new Error(`Unknown target module: ${path}`)
      const module = { schemaVersion: 2, ...definition, facts: [], presentation: [] }
      modules.push(module)
      index.modules.push(path)
      byPath.set(path, module)
    }
    return byPath.get(path)
  }

  function add(path, title, value, parts, { matchIds = [], skill = false, period = false, compareIds = [], review = null } = {}) {
    const sourcePointer = pointer(parts)
    if (value === null || value === undefined || value === '') {
      report.unknown.push({ source: sourcePointer, reason: 'Not supplied; no value inferred' })
      return
    }
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`Expected a scalar at ${sourcePointer}`)
    const module = moduleFor(path)
    const normalizeValue = skill ? normalizeSkill : period ? normalizePeriod : normalize
    const id = `draft-${sourceHash.slice(0, 12)}-${parts.join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
    // An owner-approved merge retains exact retired values and original source
    // pointers in existing provenance. Re-importing that same archive must not
    // recreate the retired record or overwrite the expanded canonical value.
    const originalPointer = `SHA-256 ${sourceHash}; ${archivePath}#${sourcePointer}.`
    const retiredValue = `Merged fact ${id}: ${JSON.stringify(value)}.`
    const consolidated = module.facts.find(fact => fact.sources.some(source => source.type === 'owner' && source.reference.includes(originalPointer)) && fact.sources.some(source => source.type === 'owner' && source.reference.startsWith('Owner-approved consolidation ') && source.reference.includes(retiredValue)))
    if (consolidated) {
      report.matchedExisting.push({ source: sourcePointer, module: path, factId: consolidated.id })
      return
    }
    const matched = module.facts.find(fact => (skill || matchIds.includes(fact.id)) && normalizeValue(fact.value) === normalizeValue(value))
    if (matched) {
      report.matchedExisting.push({ source: sourcePointer, module: path, factId: matched.id })
      return
    }
    const previous = module.facts.find(fact => fact.id === id)
    if (previous) {
      if (previous.value !== value) throw new Error(`Import ID collision: ${id}`)
      return
    }
    const fact = {
      id, title, value, status: 'pending_review', visibility: 'public', legacyEntryId: null,
      sources: [{ type: 'owner', reference: `User-provided draft attachment ${sourceName} v${draft.version}; SHA-256 ${sourceHash}; ${archivePath}#${sourcePointer}. Unverified draft provenance, not approval.` }],
      verification: { approvedBy: null, approvedAt: null, approvalReference: null, approvedValue: null },
      freshness: { asOf: null, reviewAfter: null },
    }
    module.facts.push(fact)
    report.added.push({ source: sourcePointer, module: path, factId: id })
    if (review || compareIds.length) report.reviewRequired.push({ factId: id, source: sourcePointer, existingFactIds: compareIds, note: review || 'Additional or differing draft wording; existing values remain authoritative only after separate approval.' })
  }

  const profile = draft.profile || {}
  add('profile.json', 'Name from draft', profile.name, ['profile', 'name'], { matchIds: ['profile-name'] })
  add('profile.json', 'Professional title from draft', profile.professional_title, ['profile', 'professional_title'])
  add('profile.json', 'Public location from draft', profile.location_public, ['profile', 'location_public'], { matchIds: ['profile-location'], compareIds: ['profile-location'], review: 'More specific than the existing country-only location; approve the desired public granularity.' })
  for (const field of ['coding_start', 'birth_year', 'birth_date']) add('profile.json', ({ coding_start: 'Coding start from draft', birth_year: 'Birth year from draft', birth_date: 'Birth date from draft' })[field], profile[field], ['profile', field])
  for (const [i, value] of (profile.hobbies || []).entries()) add('profile.json', `Hobby from draft ${i + 1}`, value, ['profile', 'hobbies', i])
  for (const [i, value] of (profile.career_targets || []).entries()) add('career-goals.json', `Target role from draft ${i + 1}`, value, ['profile', 'career_targets', i])
  for (const [i, value] of (profile.opportunities || []).entries()) add('career-goals.json', `Opportunity type from draft ${i + 1}`, value, ['profile', 'opportunities', i])
  add('availability.json', 'Joining availability from draft', profile.joining, ['profile', 'joining'], { review: 'Time-sensitive claim in a November 2026 draft. Confirm academic commitments, current availability, and a review deadline; no date is inferred.' })
  add('availability.json', 'Relocation preference from draft', profile.relocation, ['profile', 'relocation'])

  for (const [field, title] of Object.entries({ school: 'School', board: 'School board', class_10_percentage: 'Class 10 percentage', class_12_percentage: 'Class 12 percentage', class_12_stream: 'Class 12 stream', jee_main_rank: 'Reported JEE Main rank' })) {
    add('education.json', `${title} from draft`, draft.schooling?.[field], ['schooling', field], { review: field === 'jee_main_rank' ? 'Approximate user-reported rank; exam year and rank type are not supplied.' : null })
  }
  for (const [i, ranking] of (draft.schooling?.class_rankings || []).entries()) {
    add('achievements.json', `School ranking ${i + 1}: class`, ranking.class, ['schooling', 'class_rankings', i, 'class'])
    add('achievements.json', `School ranking ${i + 1}: position`, ranking.position, ['schooling', 'class_rankings', i, 'position'])
  }
  for (const [field, title] of Object.entries({ degree: 'Degree', university: 'University', period: 'Study period' })) add('education.json', `${title} from draft`, draft.education?.[field], ['education', field])

  const employers = new Map([
    ['Indux Technology', ['experience/indux-technology.json', 'experience-1']],
    ['The Entrepreneurship Network (TEN)', ['experience/entrepreneurship-network.json', 'experience-2']],
  ])
  for (const [i, role] of (draft.experience || []).entries()) {
    const target = employers.get(role.employer)
    if (!target) throw new Error(`Unmapped employer at /experience/${i}; review a target module before importing`)
    const [path, prefix] = target
    add(path, 'Employer name from draft', role.employer, ['experience', i, 'employer'], { matchIds: [`${prefix}-company-name`] })
    add(path, 'Role title from draft', role.role, ['experience', i, 'role'], { matchIds: [`${prefix}-position`], compareIds: [`${prefix}-position`], review: 'Draft title differs from the existing portfolio title. Confirm the official title and engagement type; neither title is overwritten.' })
    add(path, 'Role dates from draft', role.period, ['experience', i, 'period'], { matchIds: [`${prefix}-duration`], period: true })
    add(path, 'Role location from draft', role.location, ['experience', i, 'location'])
    for (const [j, highlight] of (role.highlights || []).entries()) add(path, `Contribution from draft ${j + 1}`, highlight, ['experience', i, 'highlights', j], { review: /%/.test(highlight) ? 'Résumé-based estimate in the attachment; the résumé was not independently reviewed. Confirm the metric, baseline, method, and attribution.' : null })
  }
  if (draft.experience_summary) {
    moduleFor('experience/summary.json', { id: 'experience-summary', category: 'experience', title: 'Combined experience summary' })
    add('experience/summary.json', 'Combined industry experience reported by draft', draft.experience_summary, ['experience_summary'], { review: 'Confirm exact dates and the six-month total; do not calculate or adopt a duration from approximate date ranges.' })
  }

  const skillGroups = ['languages', 'frontend', 'backend', 'databases', 'testing', 'ai_tools', 'tools']
  for (const group of skillGroups) for (const [i, skill] of (draft.skills?.[group] || []).entries()) add('skills.json', `${group.replace(/_/g, ' ')} skill from draft`, skill, ['skills', group, i], { skill: true })

  const projects = new Map([
    ['Customer Relationship Management (CRM) System', ['projects/crm.json', 'project-1']],
    ['Neuro TEN', ['projects/neuro-ten.json', 'project-2']],
    ['React.js & Firebase E-Commerce Platform', ['projects/ecommerce.json', 'project-3']],
    ['EventVerse', ['projects/eventverse.json', 'project-eventverse']],
    ['AI Chatbot (Violet)', ['projects/violet.json', 'project-violet']],
  ])
  for (const [i, project] of (draft.projects || []).entries()) {
    const target = projects.get(project.name)
    if (!target) throw new Error(`Unmapped project at /projects/${i}; review a target module before importing`)
    const [path, prefix] = target
    const module = moduleFor(path, { id: prefix, category: 'project', title: project.name })
    add(path, 'Project name from draft', project.name, ['projects', i, 'name'], { matchIds: [`${prefix}-projectname`] })
    add(path, 'Project description from draft', project.description, ['projects', i, 'description'], { matchIds: [`${prefix}-description`], review: prefix === 'project-2' ? 'Confirm whether Neuro TEN should remain public; attachment says it is absent from the latest résumé.' : prefix === 'project-violet' ? 'Violet is a separate portfolio project record. No configuration, code, service, credential, or history is shared with Ask Shubham AI.' : null })
    const stack = module.facts.find(fact => fact.id === `${prefix}-techstack`)
    const existingStack = new Set((typeof stack?.value === 'string' ? stack.value.split(',') : []).map(normalizeSkill))
    for (const [j, technology] of (project.technologies || []).entries()) {
      if (existingStack.has(normalizeSkill(technology))) report.matchedExisting.push({ source: pointer(['projects', i, 'technologies', j]), module: path, factId: stack.id })
      else add(path, 'Project technology from draft', technology, ['projects', i, 'technologies', j], { skill: true })
    }
  }
  for (const [i, value] of (draft.certifications || []).entries()) add('achievements.json', `Certification claim from draft ${i + 1}`, value, ['certifications', i])
  for (const [i, value] of (draft.achievements || []).entries()) add('achievements.json', `Achievement claim from draft ${i + 1}`, value, ['achievements', i])

  const suggestions = { career_goal: ['career-goals.json', 'Suggested career goal'], strengths: ['profile.json', 'Suggested strengths'], crm_challenge: ['projects/crm.json', 'Suggested CRM challenge wording'], coding_journey: ['profile.json', 'Suggested coding journey'] }
  for (const [field, [path, title]] of Object.entries(suggestions)) add(path, title, draft.suggested_wording_pending_approval?.[field], ['suggested_wording_pending_approval', field], { review: 'Suggested wording only; requires explicit approval and must not be treated as an established personal claim.' })

  const validated = validateKnowledge(index, modules)
  if (validated.errors.length) throw new Error(validated.errors.join('\n'))
  for (const module of current.modules) for (const fact of module.facts) {
    const after = validated.facts.find(item => item.id === fact.id)
    const { category, moduleId, ...preserved } = after
    if (digest(preserved) !== digest(fact)) throw new Error(`Existing fact changed: ${fact.id}`)
  }
  report.summary = { originalFacts: original.facts.length, addedFacts: report.added.length, matchedClaims: report.matchedExisting.length, modules: modules.length, totalFacts: validated.facts.length, statuses: Object.fromEntries(['pending_review', 'verified', 'outdated', 'archived'].map(status => [status, validated.facts.filter(fact => fact.status === status).length])) }
  return { index, modules, report }
}
