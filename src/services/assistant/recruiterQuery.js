// Correct intent vocabulary only. Never fuzzy-match personal names, values,
// record IDs or approval/status metadata into facts.
const aliases = {
  shcooling: 'schooling', scholing: 'schooling', schoolling: 'schooling',
  eduction: 'education', educatoin: 'education', educaton: 'education',
  collage: 'college', colledge: 'college', collge: 'college',
  univercity: 'university', univeristy: 'university', cource: 'course', corse: 'course',
  projet: 'project', projets: 'projects', projetcs: 'projects', projcts: 'projects',
  intership: 'internship', internsip: 'internship', internshp: 'internship',
  interships: 'internship', intersnhip: 'internship', interenship: 'internship',
  experiance: 'experience', experince: 'experience', skils: 'skills', skilss: 'skills',
  achievments: 'achievements', acheivements: 'achievements', achivements: 'achievements',
  certfications: 'certifications', certificates: 'certifications', certifcates: 'certifications',
  availablity: 'availability', avilable: 'available', availble: 'available',
  relocaton: 'relocation', reloaction: 'relocation', qualfication: 'qualification',
  skil: 'skill', tehnologies: 'technologies', tecnologies: 'technologies',
  technolgies: 'technologies', experinces: 'experience', internships: 'internship',
  acheivement: 'achievement', achivement: 'achievement', acomplishments: 'achievements',
  schol: 'school', scholl: 'school', graduaton: 'graduation', curriculam: 'course',
  parhai: 'education', padhaai: 'education', clg: 'college', uni: 'university',
  banaya: 'built', banaye: 'built', bnaya: 'built', banata: 'build',
  aata: 'know', ata: 'know', aati: 'know', aate: 'know',
  seekha: 'skills', sikha: 'skills', jeeta: 'awards', jeete: 'awards',
  uplabdhi: 'achievements', uplabdhiyan: 'achievements',
  uska: 'his', uski: 'his', uske: 'his', unka: 'his', unki: 'his', unke: 'his',
  padhai: 'education', padai: 'education', kaunsa: 'which', kaunsi: 'which',
  konsa: 'which', konsi: 'which', kahan: 'where', kaha: 'where', kahaan: 'where', kidhar: 'where',
  kab: 'when', kitne: 'how many', kitna: 'how much', kitni: 'how many',
  batao: 'tell me', btao: 'tell me', bataiye: 'tell me', batana: 'tell me',
  kya: 'what', hai: 'is', hain: 'is', tha: 'was', thi: 'was', naam: 'name',
  aur: 'and', kyun: 'why', kyu: 'why', naukri: 'job',
  dasvi: 'class 10', dasvin: 'class 10', '10vi': 'class 10',
  barahvi: 'class 12', '12vi': 'class 12',
}

export function normalizeRecruiterQuestion(question) {
  return question.normalize('NFKC').toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\b(?:kaun|kon)\s+s[ai]\b/g, 'which')
    .replace(/\b(?:technical abilities|technical expertise|competencies|skill set|skillset)\b/g, 'skills')
    .replace(/\b(?:previous roles|past roles|professional experience|work history|employment history)\b/g, 'experience')
    .replace(/\b(?:school|college|university|internship|project|course|degree|skill|experience)s?\s+(?:ke\s+baare\s+(?:me|mein)|ki\s+details?)\b/g, match => match.split(' ')[0])
    .replace(/\b(?:kab\s+(?:se\s+)?join|join\s+kab)\b/g, 'when can he join')
    .replace(/\b(?:shift|relocate)\s+(?:ho\s+)?sakt[aei]\b/g, 'relocation')
    .replace(/\b(?:kya\s+)?(?:kaam|kam)\s+(?:karta|karte)\b/g, 'professional title')
    .replace(/\bkya\s+(?:kaam|kam)\s+kiya(?:\s+tha)?\b/g, 'work responsibilities')
    .replace(/\b(?:kaam|kam)\s+kiya\b/g, 'work responsibilities')
    .replace(/\b(?:pursuing|enrolled in|majoring in)\b/g, 'studying')
    .replace(/\b(?:educational background|academic background)\b/g, 'education')
    .replace(/\b(?:accomplishments|honou?rs|recognition)\b/g, 'achievements')
    .replace(/\b(?:get hold of|connect with|reach out to)\b/g, 'contact')
    .replace(/\b(?:ready to work|open to work|looking for work|job opportunities)\b/g, 'hiring availability')
    .replace(/\b(?:move cities|move to another city|willing to move)\b/g, 'relocation')
    .replace(/\b(?:career aspirations?|professional goals?|future plans?|aims?)\b/g, 'career goal')
    .replace(/\b(?:tenth|10th|10th standard)\b/g, 'class 10')
    .replace(/\b(?:twelfth|12th|12th standard)\b/g, 'class 12')
    .replace(/\b(?:detail\s+(?:me|mein)|vistaar\s+se)\b/g, 'in detail')
    .replace(/\b(?:techstack|teck\s+stack)\b/g, 'tech stack')
    .replace(/\bfull\s*time\b/g, 'full-time')
    .replace(/\b[a-z0-9]+(?:'[a-z]+)?\b/g, word => Object.hasOwn(aliases, word) ? aliases[word] : word)
    .replace(/\s+/g, ' ').trim()
}

export const isRecruiterFollowup = text => /^(?:(?:and|what about)\b.*|(?:where|when)(?:\s+(?:is|was|did|does|can|will)\s+(?:he|it|that|his))?|(?:which|what)\s+(?:one|year|tech(?:nologies)?|stack|tools)|(?:his\s+)?(?:tech(?:nologies)?|stack|tools)|stream|marks|percentage|repo(?:sitory)?|demo|link|github|tell me more|more(?: details)?|details|why)[?!.\s]*$/i.test(text)
  || /^(?:(?:can|could|would) you\s+)?(?:tell me more|explain|elaborate|expand)(?:\s+(?:about|on))?(?:\s+(?:it|that|this|them|those|his work))?[?!.\s]*$/i.test(text)
  || /^more about (?:it|that|this|them)[?!.\s]*$/i.test(text)
  || /\b(?:there|that (?:role|project|internship)|those projects|these projects)\b/i.test(text)

export const hasExplicitRecruiterEntity = text => /\bindux\b|\bten\b|entrepreneurship|\bcrm\b|\beventverse\b|e.?commerce|firebase|violet|chatbot|neuro/i.test(text)
