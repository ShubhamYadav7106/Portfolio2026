import { countWords, hasInternalMetadata, responseStyle } from '../src/services/assistant/responseStyle.js'
import { PublicError } from './errors.js'

const qualityError = () => new PublicError(502, 'INVALID_AI_RESPONSE', 'The response could not be completed cleanly. Please retry.')

function boundary(text) {
  for (const match of text.matchAll(/[.!?](?=\s)/g)) {
    const before = text.slice(0, match.index + 1)
    if (/\b(?:e\.g|i\.e|mr|mrs|dr|vs|etc)\.$/i.test(before) || /\b(?:[A-Za-z]\.){2,}$/.test(before) || /^\s*\d+\.$/.test(before)) continue
    return match.index + 1
  }
  return -1
}

// Hold incomplete sentences and code fences instead of exposing clipped tails.
// The provider can be stopped once a complete, useful short answer is delivered.
export class ConversationStream {
  constructor(question) {
    this.style = responseStyle(question)
    this.buffer = ''
    this.words = 0
    this.sentences = 0
    this.done = false
    this.started = false
    this.lastWasCode = false
  }

  accept(raw, code = false) {
    if (hasInternalMetadata(raw)) throw qualityError()
    let text = raw.trim()
    if (!code && !this.style.structured) text = text.replace(/^#{1,6}\s+[^\n]+\n+/gm, '').replace(/^(?:[-*]|\d+[.)])\s+/gm, '').trim()
    if (!text) return []
    const words = code ? 0 : countWords(text)
    if (code && text.length > (this.style.detailed ? 10000 : 1800)) throw qualityError()
    if (!code && (this.words + words > this.style.maxWords || this.sentences >= this.style.maxSentences)) {
      if (!this.started) throw qualityError()
      this.done = true
      return []
    }
    const prefix = !this.started ? '' : code || this.lastWasCode || this.style.structured ? '\n\n' : ' '
    this.started = true
    this.lastWasCode = code
    this.words += words
    if (!code) this.sentences++
    // Wait for the next complete unit before deciding whether it fits. This
    // leaves room for a requested code example after a short explanation.
    return [prefix + text]
  }

  push(delta, final = false) {
    if (this.done) return []
    this.buffer += delta
    const output = []
    while (this.buffer.trim() && !this.done) {
      this.buffer = this.buffer.trimStart()
      if (this.buffer.startsWith('```')) {
        const close = this.buffer.indexOf('```', 3)
        if (close === -1) { if (final) throw qualityError(); break }
        output.push(...this.accept(this.buffer.slice(0, close + 3), true))
        this.buffer = this.buffer.slice(close + 3)
        continue
      }
      const fence = this.buffer.indexOf('```')
      const plain = fence === -1 ? this.buffer : this.buffer.slice(0, fence)
      const end = boundary(plain)
      if (end !== -1) {
        output.push(...this.accept(plain.slice(0, end)))
        this.buffer = this.buffer.slice(end)
      } else if (fence !== -1 || final) {
        const tail = plain.trim()
        if (tail) output.push(...this.accept(/[.!?:]$/.test(tail) ? tail : tail + '.'))
        this.buffer = this.buffer.slice(plain.length)
      } else break
    }
    return output
  }
}

export function completionBudget(mode, question, maximum) {
  const requested = responseStyle(question).detailed ? maximum : mode === 'recruiter' ? 1536 : 1024
  return Math.min(maximum, requested)
}
