export const countWords = text => (text.trim().match(/\S+/g) || []).length

export function responseStyle(question) {
  const detailed = /\b(in detail|detailed|thorough|comprehensive|deep dive|explain fully|longer (?:answer|explanation)|expand|elaborate|step[- ]by[- ]step|walk me through|full list|all (?:skills|technologies|projects|certifications)|every (?:skill|project))\b/i.test(question)
  const simple = !detailed && (countWords(question) <= 8 && !/\b(explain|how|why|compare|difference|overview|summari[sz]e)\b/i.test(question) || /\b(?:more simply|simpler|briefly|short answer)\b/i.test(question))
  return {
    detailed, simple,
    maxWords: detailed ? 300 : 70,
    maxSentences: detailed ? 14 : simple ? 2 : 4,
    structured: /\b(bullet points|numbered list|table|step[- ]by[- ]step|headings)\b/i.test(question),
  }
}

export function hasInternalMetadata(text) {
  return /\b(?:from draft|approvalReference|approvedValue|approvedAt|legacyEntryId|factIds|reviewAfter)\b|\bdraft-[a-f0-9]{8,}-|\b(?:experience-\d+-(?:position|company|duration|content|hashtags)|profile-(?:name|biography)|skills-\d+)\b|(?:^|\n)\s*(?:Source|Verified|Pending)\s*:|\b(?:verified|pending) (?:facts|information|records|status)\b/i.test(text)
}

export function joinList(values) {
  const items = [...new Set(values.filter(Boolean))]
  if (items.length < 2) return items[0] || ''
  if (items.length === 2) return items.join(' and ')
  return items.slice(0, -1).join(', ') + ' and ' + items.at(-1)
}

// Whole sentences only: never slice an answer to a word/character quota.
export function conciseSentences(sentences, question) {
  const style = responseStyle(question)
  const selected = []
  let words = 0
  for (const sentence of [...new Set(sentences.filter(Boolean))]) {
    const length = countWords(sentence)
    if (selected.length && (words + length > style.maxWords || selected.length >= style.maxSentences)) break
    selected.push(sentence)
    words += length
  }
  return selected.join(' ')
}
