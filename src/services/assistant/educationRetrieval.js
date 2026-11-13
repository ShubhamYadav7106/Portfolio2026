import { isEligibleFact } from '../../../knowledge/validation.js'
import { normalizeRecruiterQuestion } from './recruiterQuery.js'

export function educationKind(fact) {
  const id = fact.id
  if (/schooling-school$/.test(id)) return 'school_name'
  if (/schooling-board$/.test(id)) return 'school_board'
  if (/schooling-class-10-percentage$/.test(id)) return 'school_class_10_score'
  if (/schooling-class-12-percentage$/.test(id)) return 'school_class_12_score'
  if (/schooling-class-12-stream$/.test(id)) return 'school_class_12_stream'
  return /university|institution/.test(id) ? 'university' : /period/.test(id) ? 'study_period' : /degree/.test(id) ? 'degree' : 'education'
}

const schoolQuestion = /\bschool(?:ing)?\b|\bboard\b|\b(?:10th|12th)\b|\bclass\s*(?:10|12|x|xii)\b/i
const courseQuestion = /\beducation\b|\bcourse\b|\bb\.?\s*tech\b|\bcollege\b|\buniversity\b|\bdegree\b|\bgraduat\w*|\bstudent\b|\bstud(?:y|ies|ying)\b|\bqualification\w*|\bacademic\b/i
const followup = /^(?:and\s+)?(?:where|when|which one|which year|what year|what stream|stream|marks|percentage|percentages|more|tell me more|details|what about it)(?:\s+(?:is|was|will|does|did)\s+(?:he|it))?[?!.]*$/i
// Open-ended "where ..." questions may introduce a new topic (e.g. a résumé).
// Only the bounded followup grammar above may inherit location/time context.
const educationFollowup = /\b(?:marks?|percentages?|scores?|stream|subjects|board|cgpa|gpa)\b|\b(?:finish|complete|graduate)\b/i
const otherTopic = /\b(?:project\w*|intern\w*|work\w*|role\w*|employ\w*|compan\w*|skill\w*|technolog\w*|stack|tools|contact|email|github|join\w*|available|availability|relocat\w*|remote|onsite|hybrid|career|award\w*|certif\w*)\b/i

// History resolves a topic only. It never supplies values or approvals.
export function resolveEducationRequest(question, history = []) {
  const text = normalizeRecruiterQuestion(question)
  let scope = schoolQuestion.test(text) ? 'school' : courseQuestion.test(text) ? 'course' : null
  if (!scope && !otherTopic.test(text) && (followup.test(text) || educationFollowup.test(text))) {
    const users = history.filter(message => message.role === 'user' && (!message.mode || message.mode === 'recruiter'))
    const previous = users.at(-1)
    if (previous) scope = resolveEducationRequest(previous.content ?? previous.text ?? '', users.slice(0, -1))?.scope
  }
  if (!scope) return null
  let aspect = 'summary'
  if (scope === 'school') {
    if (/\b(?:class\s*(?:10|x)|10th)\b/i.test(text) && /\b(?:class\s*(?:12|xii)|12th)\b/i.test(text)) aspect = 'scores'
    else if (/\b(?:class\s*(?:10|x)|10th)\b/i.test(text)) aspect = 'class10'
    else if (/\b(?:class\s*(?:12|xii)|12th)\b/i.test(text)) aspect = 'class12'
    else if (/\bboard\b/i.test(text)) aspect = 'board'
    else if (/stream|subjects|\bpcm\b/i.test(text)) aspect = 'stream'
    else if (/marks|percentage|score|results/i.test(text)) aspect = 'scores'
    else if (/when|year|rank|jee|complet|finish|cgpa|gpa/i.test(text)) aspect = 'unsupported'
    else if (/where|which school|school (?:ka )?name/i.test(text)) aspect = 'institution'
  } else {
    if (/graduat/i.test(text) && /university|college/i.test(text)) aspect = 'summary'
    else if (/when|year|graduat|expected|finish|complet/i.test(text)) aspect = 'period'
    else if (/\bwhere\b/.test(text) || /university|college/i.test(text) && !/course|education|degree|qualification/i.test(text)) aspect = 'institution'
    else if (/marks|percentage|score|stream|cgpa|gpa|subjects/i.test(text)) aspect = 'unsupported'
  }
  return { scope, aspect }
}

export function eligibleEducationFacts(facts, request, { today } = {}) {
  if (!request) return []
  const kinds = request.scope === 'course'
    ? { summary: ['degree', 'university', 'study_period'], period: ['study_period'], institution: ['university'] }
    : { summary: ['school_name', 'school_board', 'school_class_10_score', 'school_class_12_score', 'school_class_12_stream'], institution: ['school_name'], board: ['school_board'], class10: ['school_class_10_score'], class12: ['school_class_12_score', 'school_class_12_stream'], stream: ['school_class_12_stream'], scores: ['school_class_10_score', 'school_class_12_score'] }
  const allowed = kinds[request.aspect] || []
  return facts.filter(fact => fact.category === 'education' && isEligibleFact(fact, { today }) && allowed.includes(educationKind(fact)))
}
