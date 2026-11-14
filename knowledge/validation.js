export const FACT_STATUSES = Object.freeze(['pending_review', 'verified', 'outdated', 'archived'])
export const CATEGORIES = Object.freeze(['profile', 'education', 'skills', 'experience', 'project', 'achievements', 'career', 'availability', 'links'])
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasText = value => typeof value === 'string' && value.trim().length > 0
const isId = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
export const todayUTC = () => new Date().toISOString().slice(0, 10)
export const hasValue = value => value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '')
export function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}

export function validateFact(fact, { today = todayUTC() } = {}) {
  const errors = []
  if (!isObject(fact)) return ['Fact must be an object']
  for (const field of ['id', 'title', 'value', 'status', 'visibility', 'legacyEntryId', 'sources', 'verification', 'freshness']) if (!Object.hasOwn(fact, field)) errors.push(`Missing ${field}`)
  if (!isId(fact.id)) errors.push('Invalid fact ID')
  if (!hasText(fact.title)) errors.push('Missing title')
  if (!(fact.value === null || ['string', 'boolean'].includes(typeof fact.value) || (typeof fact.value === 'number' && Number.isFinite(fact.value)))) errors.push('Value must be a scalar or null')
  if (!FACT_STATUSES.includes(fact.status)) errors.push('Invalid status')
  if (!['public', 'private'].includes(fact.visibility)) errors.push('Invalid visibility')
  if (!(fact.legacyEntryId === null || isId(fact.legacyEntryId))) errors.push('Invalid legacy entry reference')
  if (!Array.isArray(fact.sources)) errors.push('Sources must be an array')
  else for (const source of fact.sources) {
    if (!isObject(source)) { errors.push('Invalid source'); continue }
    if (source.type === 'portfolio') {
      if (source.file !== 'src/portfolio.js' || !hasText(source.field) || !/^#[a-z][a-z0-9-]*$/.test(source.section)) errors.push('Invalid portfolio source')
    } else if (source.type === 'owner') {
      if (!hasText(source.reference)) errors.push('Owner source requires a reference')
    } else errors.push('Unknown source type')
  }
  const approval = fact.verification
  const freshness = fact.freshness
  if (!isObject(approval)) errors.push('Missing verification metadata')
  if (!isObject(freshness)) errors.push('Missing freshness metadata')
  if (isObject(approval)) for (const field of ['approvedBy', 'approvedAt', 'approvalReference', 'approvedValue']) if (!Object.hasOwn(approval, field)) errors.push(`Missing approval ${field}`)
  if (isObject(freshness)) {
    for (const field of ['asOf', 'reviewAfter']) if (freshness[field] !== null && !isDate(freshness[field])) errors.push(`Invalid ${field} date`)
    if (isDate(freshness.asOf) && freshness.asOf > today) errors.push('As-of date is in the future')
    if (isDate(freshness.asOf) && isDate(freshness.reviewAfter) && freshness.reviewAfter < freshness.asOf) errors.push('Review date precedes as-of date')
  }
  if (fact.status === 'pending_review' && isObject(approval) && Object.values(approval).some(value => value !== null)) errors.push('Pending facts must have cleared approval metadata')
  if (fact.status === 'verified') {
    if (!hasValue(fact.value)) errors.push('An unknown value cannot be verified')
    if (!fact.sources?.length) errors.push('Verified fact requires a source')
    if (!hasText(approval?.approvedBy) || !hasText(approval?.approvalReference) || !isDate(approval?.approvedAt)) errors.push('Explicit approval metadata is required')
    if (isDate(approval?.approvedAt) && approval.approvedAt > today) errors.push('Approval date is in the future')
    if (!Object.is(approval?.approvedValue, fact.value)) errors.push('Value changed since approval; return it to pending review')
    if (!isDate(freshness?.asOf) || !isDate(freshness?.reviewAfter)) errors.push('Verified facts require an as-of date and review deadline')
    if (isDate(approval?.approvedAt) && isDate(freshness?.reviewAfter) && approval.approvedAt > freshness.reviewAfter) errors.push('Review deadline precedes approval')
  }
  return errors
}

export function isEligibleFact(fact, { today = todayUTC() } = {}) {
  return validateFact(fact, { today }).length === 0 && fact.status === 'verified' && fact.visibility === 'public' && hasValue(fact.value) && fact.freshness.asOf <= today && fact.freshness.reviewAfter >= today
}

export function validateKnowledge(index, modules, { today = todayUTC() } = {}) {
  const errors = []
  const warnings = []
  const facts = []
  if (!isObject(index) || index.schemaVersion !== 2 || !hasText(index.assistantName) || !Array.isArray(index.modules) || !index.modules.length) {
    return { errors: ['Invalid knowledge index'], warnings, facts }
  }
  if (!Array.isArray(modules)) return { errors: ['Modules must be an array'], warnings, facts }
  if (new Set(index.modules).size !== index.modules.length) errors.push('Duplicate module paths')
  if (modules.length !== index.modules.length) errors.push('Module count does not match the index')
  const moduleIds = new Set()
  const factIds = new Set()
  for (const path of index.modules) if (typeof path !== 'string' || !/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.json$/.test(path)) errors.push(`Invalid module path: ${path}`)
  modules.forEach((module, indexOfModule) => {
    const path = index.modules[indexOfModule]
    if (!isObject(module) || module.schemaVersion !== 2 || !isId(module.id) || !hasText(module.title) || !CATEGORIES.includes(module.category) || !Array.isArray(module.facts) || !Array.isArray(module.presentation)) {
      errors.push(`${path}: Invalid module structure`)
      return
    }
    if (moduleIds.has(module.id)) errors.push(`${path}: Duplicate module ID ${module.id}`)
    moduleIds.add(module.id)
    for (const fact of module.facts) {
      errors.push(...validateFact(fact, { today }).map(error => `${path} / ${fact?.id || '?'}: ${error}`))
      if (factIds.has(fact?.id)) errors.push(`${path}: Duplicate fact ID ${fact.id}`)
      factIds.add(fact?.id)
      facts.push({ ...fact, category: module.category, moduleId: module.id, moduleTitle: module.title })
      if (fact?.status === 'verified' && isDate(fact.freshness?.reviewAfter) && fact.freshness.reviewAfter < today) warnings.push(`${fact.id}: Review deadline passed; excluded from recruiter answers`)
    }
    for (const item of module.presentation) {
      if (!isObject(item) || !isId(item.legacyEntryId) || item.source?.file !== 'src/portfolio.js' || !hasText(item.source?.field)) errors.push(`${path}: Invalid presentation provenance`)
    }
  })
  return { errors, warnings, facts }
}
