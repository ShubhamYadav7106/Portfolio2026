import { isEligibleFact } from '../../../knowledge/validation.js'
import { conciseSentences, hasInternalMetadata, joinList, responseStyle } from './responseStyle.js'
import { educationKind, eligibleEducationFacts, resolveEducationRequest } from './educationRetrieval.js'
import { normalizeRecruiterQuestion, isRecruiterFollowup, hasExplicitRecruiterEntity } from './recruiterQuery.js'

export const PERSONAL_FALLBACK = 'I don’t have that detail. You can ask Shubham directly.'
export const SCHOOLING_FALLBACK = 'I don’t have Shubham’s schooling details to share. You can ask him directly.'
const technologyAlias = value => value.toLowerCase().replace(/\breact(?:\.?js)\b/g, 'react').replace(/\bnodejs\b/g, 'node.js').replace(/\bexpressjs\b/g, 'express.js').replace(/\bvuejs\b/g, 'vue').replace(/tailwind css/g, 'tailwind').replace(/openai codex/g, 'codex')
const bare = value => String(value).replace(/[.!?]+$/, '').trim()
const sentence = value => bare(value) + '.'
const lowerVerb = value => bare(value).replace(/^(Built|Debugged|Integrated|Developed|Collaborated|Implemented|Worked|Created)\b/, word => word.toLowerCase())
const activity = value => bare(value).replace(/^Built and maintained\b/, 'building and maintaining').replace(/^(Built|Debugged|Integrated|Developed|Collaborated|Implemented|Worked|Created)\b/, word => ({ Built: 'building', Debugged: 'debugging', Integrated: 'integrating', Developed: 'developing', Collaborated: 'collaborating', Implemented: 'implementing', Worked: 'working', Created: 'creating' })[word]).replace(/\band fixed\b/g, 'and fixing')

export function factKind(fact) {
  const id = fact.id
  if (fact.category === 'skills') return 'skill'
  if (id === 'profile-name') return 'name'
  if (id.endsWith('professional-title')) return 'profession'
  if (fact.category === 'education') return educationKind(fact)
  if (fact.category === 'experience') return /-position$|-role$/.test(id) ? 'role' : /company-name$|-employer$/.test(id) ? 'employer' : /duration$|-period$/.test(id) ? 'role_dates' : /location$/.test(id) ? 'role_location' : /highlights|bulletpoints/.test(id) ? 'contribution' : /hashtags-/.test(id) ? 'role_technology' : /company-link$/.test(id) ? 'employer_link' : 'experience_detail'
  if (fact.category === 'project') return /projectname$|projects-\d+-name$/.test(id) ? 'project_name' : /description$/.test(id) ? 'project_description' : /techstack$|-technologies-\d+$/.test(id) ? 'project_technology' : /yearcompleted$/.test(id) ? 'project_year' : /repository$|links-0-url$/.test(id) ? 'project_repository' : /demo$|links-1-url$/.test(id) ? 'project_demo' : 'project_detail'
  if (fact.category === 'achievements') return /certifications-/.test(id) ? 'certification' : /^Class \d+:.*class ranks/i.test(String(fact.value)) ? 'school_rank' : 'award'
  if (fact.category === 'links') return id === 'resume' ? 'resume' : /email$/.test(id) ? 'email' : /github$/.test(id) ? 'github' : /linkedin$/.test(id) ? 'linkedin' : 'link'
  if (fact.category === 'availability') return id.replace('availability-', '')
  if (fact.category === 'career') return /profile-opportunities-/.test(id) ? 'opportunity' : /target-roles$/.test(id) ? 'target_role' : /career-goal$/.test(id) ? 'career_goal' : 'career'
  return 'profile'
}

export function recruiterIntent(question) {
  question = normalizeRecruiterQuestion(question)
  if (/salary|compensation|notice period|work authorization|\bvisa\b|\bage\b|born|birth|\bjee\b|hometown|street address|\bhome\b|strongest|proficiency|\bexpert\b|\bsenior\b|years of experience|how many years|months of experience|total experience|improvement percentage|\bmetrics\b/i.test(question)) return 'unknown'
  if (/neuro/i.test(question)) return 'unknown'
  if (/where.*(?:based|live|located)|current location/i.test(question) && !/intern|role|indux|entrepreneurship|\bten\b/i.test(question)) return 'location'
  if (/available|availability|relocat|hire|hiring|join|start date|onsite|on-site|hybrid|remote|work(?:ing)? arrangements?/i.test(question)) return 'availability'
  if (/contact|email|reach|touch|résumé|resume|\bcv\b|github|linkedin/i.test(question)) return 'links'
  if (resolveEducationRequest(question)) return 'education'
  if (/achievement|award|certif|hackathon/i.test(question)) return 'achievements'
  if (/career goal|target role|roles.*target|opportunities|full.time/i.test(question)) return 'career'
  if (/project|\bcrm\b|chatbot|violet|eventverse|e.?commerce|work samples|portfolio work|what.*(?:built|build|created|developed)/i.test(question)) return 'project'
  if (/know|familiar with|work with|experience with/.test(question) && !hasExplicitRecruiterEntity(question)) return 'skills'
  if (/experience|intern|\btrain(?:ing|ee)?\b|\btimeline\b|employ|company|companies|roles|where.*work|indux|entrepreneurship|\bten\b/i.test(question)) return 'experience'
  if (/skill|tech|stack|react|typescript|javascript|frontend|backend|vue|work with|programming|languages|tools|framework|database|\b(?:html|css|scss|java|node|express|mongodb|postgresql|sql|git|firebase|tailwind|bootstrap|redux)\b/i.test(question)) return 'skills'
  if (/who|introduc|about|background|name|professional title|what.*(?:developer|do)/i.test(question)) return 'profile'
  return 'unknown'
}

export function selectRecruiterSkills(question, facts) {
  const query = technologyAlias(normalizeRecruiterQuestion(question)).replace(/[?!.]+$/, '')
  const skills = facts.filter(fact => factKind(fact) === 'skill')
  const named = skills.filter(fact => {
    const value = technologyAlias(String(fact.value)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[^\\w+.#])${value}(?=$|[^\\w+.#])`, 'i').test(query)
  })
  if (named.length && !recruiterSkillRequest(question).complete) return named
  if (/\b(?:know|familiar with|experience with|work with)\b/.test(query) && !/what|which|skills|technologies|tools/.test(query)) return []
  const group = /programming|languages/.test(query) ? /^(javascript|typescript|java|c)$/i
    : /database/.test(query) ? /mongodb|postgresql|firebase/i
      : /backend/.test(query) ? /node\.js|express\.js|rest apis|jwt|otp|rbac|mongodb|postgresql/i
        : /frontend/.test(query) ? /javascript|typescript|react|html|css|scss|tailwind|material ui|bootstrap|redux|context api|framer motion/i : null
  return group ? skills.filter(fact => group.test(String(fact.value))) : skills
}

export function recruiterSkillRequest(question) {
  const query = normalizeRecruiterQuestion(question)
  const complete = /\b(?:all|every|full|complete|entire|comprehensive)\b|\b(?:tech(?:nical|nology)?\s*)?stack\b/.test(query)
    || /\blist\b/.test(query) && !/\b(?:main|core|key|primary|summary|overview)\b/.test(query)
  return { complete, summary: !complete }
}

// These are technical categories, not a second store of personal skills.
// Only eligible fact values supplied by the caller can appear in the answer.
const skillGroups = [
  ['Languages', /^(?:javascript|typescript|java|c|c\+\+|c#|python|go|rust|ruby|php|swift|kotlin|sql)$/i, 2],
  ['Frontend & styling', /react|vue|angular|html|css|scss|tailwind|material ui|bootstrap|redux|context api|framer motion/i, 2],
  ['Backend & APIs', /node\.?js|express\.?js|rest api|graphql|jwt|otp|rbac/i, 2],
  ['Databases & data services', /mongodb|postgresql|firebase|mysql|redis|sqlite/i, 1],
  ['Development tools & platforms', /^(?:git|github|npm|netlify|vercel|docker|linux|aws|github actions)$/i, 1],
  ['Testing & debugging', /postman|thunder client|test|debug|root cause analysis/i, 1],
  ['AI tools & practices', /codex|claude|copilot|generative ai|ai.assisted|prompt engineering|ai agents/i, 1],
  ['Other skills', /./, 1],
]

export function composeRecruiterSkills(question, facts) {
  const request = recruiterSkillRequest(question)
  const selected = selectRecruiterSkills(question, facts.filter(fact => isEligibleFact(fact)))
  const unique = new Map()
  for (const fact of selected) if (!unique.has(technologyAlias(String(fact.value)))) unique.set(technologyAlias(String(fact.value)), fact)
  const groups = skillGroups.map(([label, pattern, summarySize]) => ({ label, pattern, summarySize, facts: [] }))
  for (const fact of unique.values()) groups.find(group => group.pattern.test(String(fact.value))).facts.push(fact)
  const chosen = groups.map(group => ({ ...group, facts: request.complete ? group.facts : group.facts.slice(0, group.summarySize) })).filter(group => group.facts.length)
  if (!chosen.length) return { text: 'I don’t have those skills listed to share.', knowledgeIds: [] }
  return {
    text: request.complete
      ? chosen.map(group => `${group.label}: ${joinList(group.facts.map(fact => String(fact.value)))}.`).join('\n')
      : `Shubham’s skills include ${joinList(chosen.flatMap(group => group.facts.map(fact => String(fact.value))))}.`,
    knowledgeIds: chosen.flatMap(group => group.facts.map(fact => fact.id)),
  }
}

export function resolveRecruiterContext(question, history = []) {
  let message = normalizeRecruiterQuestion(question)
  const users = history.filter(item => item.role === 'user' && (!item.mode || item.mode === 'recruiter')).slice(-16)
  const previous = users.at(-1)
  const prior = previous ? resolveRecruiterContext(previous.content ?? previous.text ?? '', users.slice(0, -1)) : null
  let education = resolveEducationRequest(message, users)
  let intent = recruiterIntent(message)
  // Explicit current-topic intent wins over an inherited education reference.
  if (education && !resolveEducationRequest(message) && !['unknown', 'profile', 'education'].includes(intent)) education = null
  let query = message
  let contextHistory = []
  const technicalFollowup = /^(?:(?:and|what|which|his)\s+)*(?:tech(?:nologies)?|stack|tools)[?!.\s]*$/.test(message) || /\b(?:tech(?:nologies)?|stack|tools|built with|used there)\b/.test(message) && /\b(?:there|that|it|used|use|built with)\b/.test(message)
  const projectLink = /^(?:repo(?:sitory)?|demo|link|github)[?!.\s]*$/.test(message) || /\b(?:repo(?:sitory)?|demo|link|github|live)\b/.test(message) && /\b(?:it|its|that|this|project|there)\b/.test(message) && !/\b(?:profile|contact|resume|cv|linkedin)\b/.test(message)
  const genericAbout = intent === 'profile' && /^what about\s+/.test(message) && !/\b(name|background|shubham|him|he)\b/.test(message)
  const contextualWork = /\b(?:there|that role|that internship|that project|those projects|these projects)\b/.test(message) && ['unknown', 'profile', 'experience', 'project'].includes(intent)
  const continues = prior && !hasExplicitRecruiterEntity(message) && (isRecruiterFollowup(message) && (intent === 'unknown' || genericAbout || contextualWork) || technicalFollowup && ['experience', 'project'].includes(prior.intent) || projectLink && prior.intent === 'project')
  if (continues) {
    intent = prior.intent
    query = `${prior.query} ${message}`.slice(-1800)
    contextHistory = [{ role: 'user', content: prior.query.slice(-600) }]
    if (intent === 'skills') {
      const target = /^(?:and|what about)\s+(.+?)[?!.]*$/.exec(message)
      if (target && !/skills|backend|frontend|languages|tools|database/.test(target[1])) message = `does he know ${target[1]}?`
      query = message
    }
    if (intent === 'education') education = resolveEducationRequest(message, users)
    if (/^(?:where|when)[?!.\s]*$/.test(message) && !['education', 'experience', 'project', 'availability'].includes(intent)) { intent = 'unknown'; query = message; contextHistory = [] }
  }
  // Sensitive/unsupported questions never inherit a nearby approved topic.
  if (/salary|compensation|notice period|work authorization|\bvisa\b|\bage\b|born|birth|\bjee\b|hometown|\bprivate\b|\bpending\b|street address|\bhome\b|\bexpert\b|strongest|proficiency|\bsenior\b|total experience|years of experience|months of experience|how many years|improvement percentage|\bmetrics\b/.test(message)) { intent = 'unknown'; education = null; query = message; contextHistory = [] }
  if (education && !['unknown', 'location'].includes(intent)) intent = 'education'
  if (education && intent === 'unknown' && isRecruiterFollowup(message)) intent = 'education'
  return { message, intent, query, education, history: education ? [] : contextHistory }
}

export const isRecruiterExperienceTimeline = question => /\b(?:timeline|chronolog\w*|dates?|duration|period|tenure|when|how long)\b|\bstart\b.*\bend\b/i.test(normalizeRecruiterQuestion(question))

function approvedMonthRange(value) {
  const match = /^([a-z]+)\s+(\d{4})\s*[-–—]\s*([a-z]+)\s+(\d{4})$/i.exec(String(value).trim())
  if (!match) return null
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const monthNames = [...months, 'sept', 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  if (![match[1], match[3]].every(month => monthNames.includes(month.toLowerCase()))) return null
  const startMonth = months.indexOf(match[1].slice(0, 3).toLowerCase())
  const endMonth = months.indexOf(match[3].slice(0, 3).toLowerCase())
  if (startMonth < 0 || endMonth < 0) return null
  const start = Number(match[2]) * 12 + startMonth
  const end = Number(match[4]) * 12 + endMonth
  if (end < start) return null
  return { start, startLabel: `${match[1]} ${match[2]}`, endLabel: `${match[3]} ${match[4]}`, months: end - start + 1 }
}

export function composeRecruiterTimeline(question, facts) {
  const eligible = facts.filter(fact => fact.category === 'experience' && isEligibleFact(fact))
  const rows = []
  for (const group of new Set(eligible.map(fact => fact.moduleId))) {
    const members = eligible.filter(fact => fact.moduleId === group)
    const get = kind => members.find(fact => factKind(fact) === kind)
    const role = get('role'), employer = get('employer'), dates = get('role_dates')
    if (!role || !employer) continue
    const range = dates ? approvedMonthRange(dates.value) : null
    const type = /trainee|training/i.test(String(role.value)) ? 'Training' : /intern/i.test(String(role.value)) ? 'Internship' : 'Professional experience'
    rows.push({ range, text: `- **${type}: ${role.value} at ${employer.value}** — ${range ? `${range.startLabel} to ${range.endLabel} (${range.months} calendar months covered)` : dates ? dates.value : 'Dates are not available to share'}.`, facts: [role, employer, ...(dates ? [dates] : [])] })
  }
  rows.sort((a, b) => (a.range?.start ?? Infinity) - (b.range?.start ?? Infinity))
  return {
    text: rows.length ? rows.map(row => row.text).join('\n') + (rows.some(row => row.range) ? '\n\nCalendar spans include both listed months; exact elapsed durations require exact start and end dates.' : '') : PERSONAL_FALLBACK,
    knowledgeIds: rows.flatMap(row => row.facts.map(fact => fact.id)),
  }
}

export function composeRecruiterAnswer(question, { facts = [], selectedIds, history = [], today } = {}) {
  const context = resolveRecruiterContext(question, history)
  question = context.message
  if (/^(hi|hello|hey)[!.?\s]*$/i.test(question.trim())) return { text: 'Hi! What would you like to know about Shubham’s work?', knowledgeIds: [] }
  if (/^(thanks|thank you)[!.?\s]*$/i.test(question.trim())) return { text: 'You’re welcome.', knowledgeIds: [] }
  if (/^(who are you|what can you do)[?.!\s]*$/i.test(question.trim())) return { text: 'I’m Ask Shubham AI. I can help with questions about Shubham’s professional background.', knowledgeIds: [] }
  const eligible = facts.filter(fact => isEligibleFact(fact, { today }))
  const { education, query, intent } = context
  const fallback = education?.scope === 'school' ? SCHOOLING_FALLBACK : PERSONAL_FALLBACK
  const byId = new Map(eligible.map(fact => [fact.id, fact]))
  const selected = (selectedIds || eligible.map(fact => fact.id)).map(id => byId.get(id)).filter(Boolean)
  if (!selected.length) return { text: fallback, knowledgeIds: [] }
  const used = new Set()
  const use = fact => { if (fact) used.add(fact.id); return fact?.value }
  const get = id => byId.get(id)
  const kind = (items, name) => items.find(fact => factKind(fact) === name)
  const choose = (items, name) => items.filter(fact => factKind(fact) === name)
  const nameFact = get('profile-name')
  const subject = () => nameFact ? String(use(nameFact)).split(' ')[0] : 'The developer'
  const style = responseStyle(question)
  const sameCategory = selected.filter(fact => fact.category === intent)
  const sentences = []

  if (intent === 'experience' && isRecruiterExperienceTimeline(query)) return composeRecruiterTimeline(query, sameCategory)

  if (intent === 'availability') {
    const requested = []
    if (/relocat/i.test(question)) requested.push('availability-relocation')
    if (/onsite|on-site|hybrid|remote|arrangement/i.test(question)) requested.push('availability-arrangement')
    if (/join|availability|start|hir/i.test(question) || /available/i.test(question) && !/onsite|on-site|hybrid|remote|relocat/i.test(question)) requested.push('availability-start-date')
    if (/full.time|internship|hiring|opportunities/i.test(question)) requested.push('availability-hiring')
    const ids = new Set(selected.map(fact => fact.id))
    if (requested.includes('availability-start-date') && ids.has('availability-start-date')) {
      const start = String(use(get('availability-start-date')))
      const hiring = requested.includes('availability-hiring') && ids.has('availability-hiring') ? use(get('availability-hiring')) : null
      const scope = hiring ? ' for ' + String(hiring).replace(/^Available for\s+/i, '') : ''
      sentences.push(/\bimmediate(?:ly)?\b/i.test(start) ? `${subject()} is available to join immediately${scope}.` : `${subject()}'s stated start availability is ${bare(start)}.`)
    } else if (ids.has('availability-hiring') && requested.includes('availability-hiring')) sentences.push(`${subject()} is ${String(use(get('availability-hiring'))).replace(/^Available/, 'available')}.`)
    if (requested.includes('availability-arrangement') && ids.has('availability-arrangement')) {
      const arrangement = String(use(get('availability-arrangement'))).toLowerCase()
      const modes = ['onsite', 'hybrid', 'remote'].filter(mode => new RegExp(mode === 'onsite' ? 'on.?site' : mode, 'i').test(question) && arrangement.includes(mode))
      sentences.push(`${subject()} is open to ${modes.length ? joinList(modes) : arrangement} opportunities.`)
    }
    if (requested.includes('availability-relocation') && ids.has('availability-relocation')) sentences.push(`${subject()} is ${String(use(get('availability-relocation'))).replace(/^Open/, 'open')}.`)
  } else if (intent === 'skills') {
    return composeRecruiterSkills(question, sameCategory)
  } else if (intent === 'education') {
    const educationFacts = eligibleEducationFacts(sameCategory, education || resolveEducationRequest(query), { today })
    const degree = kind(educationFacts, 'degree')
    const university = kind(educationFacts, 'university')
    const period = kind(educationFacts, 'study_period')
    if (degree && university) sentences.push(`${subject()}'s ${use(degree)} programme is at ${use(university)}.`)
    else if (degree) sentences.push(`${subject()}'s degree is listed as ${use(degree)}.`)
    else if (university) sentences.push(`${subject()}'s university is ${use(university)}.`)
    if (period) sentences.push(`The study period is ${use(period)}.`)
    const school = kind(educationFacts, 'school_name')
    const board = kind(educationFacts, 'school_board')
    const class10 = kind(educationFacts, 'school_class_10_score')
    const class12 = kind(educationFacts, 'school_class_12_score')
    const stream = kind(educationFacts, 'school_class_12_stream')
    if (school) sentences.push(`${subject()} attended ${use(school)}${board ? ' under the ' + use(board) : ''}.`)
    else if (board) sentences.push(`The school board was ${use(board)}.`)
    if (class10 && class12) sentences.push(`The scores were ${use(class10)}% in Class 10 and ${use(class12)}% in Class 12${stream ? ' (' + use(stream) + ')' : ''}.`)
    else if (class10) sentences.push(`The Class 10 score was ${use(class10)}%.`)
    else if (class12) sentences.push(`The Class 12 score was ${use(class12)}%${stream ? ' (' + use(stream) + ')' : ''}.`)
    else if (stream) sentences.push(`The Class 12 stream was ${use(stream)}.`)
  } else if (intent === 'experience') {
    const groups = [...new Set(sameCategory.map(fact => fact.moduleId))]
    const filtered = groups.filter(group => /indux/i.test(query) ? group === 'experience-1' : /entrepreneurship|\bten\b/i.test(query) ? group === 'experience-2' : true)
    for (const group of filtered) {
      const selectedGroup = sameCategory.filter(fact => fact.moduleId === group)
      const fullGroup = eligible.filter(fact => fact.moduleId === group)
      const employer = kind(fullGroup, 'employer')
      const role = kind(fullGroup, 'role')
      const dates = kind(selectedGroup, 'role_dates')
      const location = kind(selectedGroup, 'role_location')
      const locationOnly = /where|location/i.test(question)
      if (locationOnly) {
        if (employer && location) sentences.push(`The role at ${use(employer)} was in ${use(location)}.`)
        continue
      }
      if (/tech|stack|tools/.test(question)) {
        const technologies = choose(selectedGroup, 'role_technology').slice(0, style.detailed ? 16 : 8)
        if (technologies.length && employer) sentences.push(`At ${use(employer)}, ${subject()} used ${joinList(technologies.map(use))}.`)
        continue
      }
      if (role && employer) {
        const period = dates ? ' from ' + String(use(dates)).replace(/\s*[-–]\s*/, ' to ') : ''
        sentences.push(sentences.length ? `The experience also includes a ${use(role)} role at ${use(employer)}${period}.` : `${subject()} worked as a ${use(role)} at ${use(employer)}${period}.`)
      }
      const contributions = /\bwhen\b|dates|period|how long/i.test(question) ? [] : choose(selectedGroup, 'contribution').slice(0, style.detailed ? 4 : filtered.length > 1 ? 0 : 1)
      for (const contribution of contributions) {
        const value = String(use(contribution))
        sentences.push(sentence(sentences.length ? `The work involved ${activity(value)}` : `${subject()} ${lowerVerb(value)}`))
      }
    }
  } else if (intent === 'project') {
    const target = /\bcrm\b/i.test(query) ? 'project-1' : /eventverse/i.test(query) ? 'project-eventverse' : /e.?commerce|firebase/i.test(query) ? 'project-3' : /chatbot|violet/i.test(query) ? 'project-violet' : null
    const groups = [...new Set(sameCategory.map(fact => fact.moduleId))].filter(group => !target || group === target)
    const items = []
    for (const group of groups) {
      const selectedGroup = sameCategory.filter(fact => fact.moduleId === group)
      const fullGroup = eligible.filter(fact => fact.moduleId === group)
      const projectName = kind(fullGroup, 'project_name')
      const description = kind(selectedGroup, 'project_description')
      if (/violet/i.test(query) && !projectName) continue
      if (/when|year|completed/.test(question)) {
        const year = kind(selectedGroup, 'project_year')
        if (year) sentences.push(`${projectName ? use(projectName) : 'The project'} was completed in ${use(year)}.`)
        continue
      }
      if (/repo|github|demo|live|link/.test(question)) {
        const links = selectedGroup.filter(fact => /repo|github/.test(question) ? factKind(fact) === 'project_repository' : /demo|live/.test(question) ? factKind(fact) === 'project_demo' : ['project_repository', 'project_demo'].includes(factKind(fact)))
        for (const link of links) sentences.push(`The ${factKind(link) === 'project_repository' ? 'repository' : 'demo'} is ${use(link)}.`)
        continue
      }
      if (!target && !style.detailed) {
        if (projectName) items.push(use(projectName))
        else if (description && /chatbot/i.test(String(description.value))) { const value = String(use(description)); items.push(/Gemini/i.test(value) ? 'a Gemini-powered chatbot' : 'a chatbot') }
        continue
      }
      const technologiesOnly = /tech|stack|built with|what.*use/i.test(question) && !/features|describe|detail/i.test(question)
      if (description && !technologiesOnly) {
        const value = String(use(description))
        if (group === 'project-1') sentences.push(sentence(`The CRM project is a ${value[0].toLowerCase() + bare(value).slice(1)}`.replace(/\bWork is related to\b/g, 'The work relates to the')))
        else if (group === 'project-3' && projectName) sentences.push(sentence(`The ${use(projectName)} includes ${value[0].toLowerCase() + bare(value).slice(1)}`))
        else if (group === 'project-eventverse' && projectName) sentences.push(sentence(`${use(projectName)} is an ${value[0].toLowerCase() + bare(value).slice(1)}`))
        else sentences.push(sentence(`The work involves a ${value[0].toLowerCase() + bare(value).slice(1)}`))
      } else if (projectName && !technologiesOnly) sentences.push(`${subject()} has worked on ${use(projectName)}.`)
      if (/tech|stack|built with|use|detail/i.test(question)) {
        const technologies = choose(selectedGroup, 'project_technology').slice(0, style.detailed ? 12 : 6)
        if (technologies.length) sentences.push(`The technologies include ${joinList(technologies.map(use))}.`)
      }
    }
    if (items.length) sentences.push(`${subject()} has worked on ${joinList(items)}.`)
  } else if (intent === 'achievements') {
    const certificationQuestion = /certif/i.test(question)
    const items = sameCategory.filter(fact => factKind(fact) === (certificationQuestion ? 'certification' : 'award')).slice(0, style.detailed ? 12 : 4)
    if (items.length) sentences.push(certificationQuestion ? `${subject()}'s certifications include ${joinList(items.map(use))}.` : `${subject()} received ${joinList(items.map(use))}.`)
    if (!certificationQuestion && !/award|hackathon/.test(question)) {
      const ranks = kind(sameCategory, 'school_rank')
      if (ranks) sentences.push(`The school rankings were ${use(ranks)}.`)
    }
  } else if (intent === 'links') {
    const email = kind(sameCategory, 'email')
    const github = kind(sameCategory, 'github')
    const linkedin = kind(sameCategory, 'linkedin')
    const resume = kind(sameCategory, 'resume')
    const onlyProfile = /github|linkedin/i.test(question)
    if (email && !onlyProfile && !/résumé|resume|\bcv\b/i.test(question)) sentences.push(`You can email ${subject()} at ${use(email)}.`)
    if (/résumé|resume|\bcv\b/i.test(question)) sentences.push(resume ? `You can view ${subject()}'s résumé at ${use(resume)}.` : 'I don’t have a current résumé link to share.')
    if (github && /github/i.test(question)) sentences.push(`The GitHub profile is ${use(github)}.`)
    if (linkedin && /linkedin/i.test(question)) sentences.push(`The LinkedIn profile is ${use(linkedin)}.`)
  } else if (intent === 'career') {
    const requested = /target role|roles.*target/.test(question) ? 'target_role' : /career goal/.test(question) ? 'career_goal' : 'opportunity'
    const items = sameCategory.filter(fact => factKind(fact) === requested)
    if (requested === 'career_goal') for (const fact of items) sentences.push(sentence(use(fact)))
    else if (items.length) sentences.push(`${subject()} is ${requested === 'target_role' ? 'targeting' : 'open to'} ${joinList(items.map(fact => bare(String(use(fact))).toLowerCase()))}.`)
  } else if (intent === 'location') {
    const location = selected.find(fact => fact.id === 'profile-location')
    if (location) sentences.push(`${subject()} is based in ${use(location)}.`)
  } else if (intent === 'profile') {
    const fullName = kind(selected, 'name')
    const profession = kind(selected, 'profession')
    if (profession) sentences.push(`${fullName ? use(fullName) : subject()} is a ${String(use(profession)).toLowerCase()}.`)
    else if (fullName) sentences.push(`The name is ${use(fullName)}.`)
  }
  const text = conciseSentences(sentences, question)
  if (!text || hasInternalMetadata(text)) return { text: fallback, knowledgeIds: [] }
  return { text, knowledgeIds: [...used] }
}

export function createRecruiterAnswer(question, options = {}) {
  const answer = composeRecruiterAnswer(question, options)
  return { ...answer, sources: [], mode: 'recruiter', provider: 'mock', verification: answer.knowledgeIds.length ? 'verified' : 'not_available' }
}
