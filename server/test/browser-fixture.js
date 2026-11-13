// Test-only Groq transport. Never imported by the server entry point. This lets
// browser checks exercise the real Express/streaming path without a key or cost.
import { createGeneralAnswer } from '../../src/services/assistant/generalResponder.js'

export const browserFixtureGroq = {
  chat: { completions: { async create(options, { signal }) {
    const question = options.messages.at(-1).content
    let answer
    if (options.response_format) {
      const facts = JSON.parse(options.messages[0].content.split('APPROVED_FACTS:\n')[1])
      const category = /skill|tech/i.test(question) ? 'skills' : /available|join|relocat/i.test(question) ? 'availability' : /project/i.test(question) ? 'project' : /contact|email/i.test(question) ? 'links' : null
      const selected = facts.filter(fact => fact.category === category).slice(0, category === 'availability' ? 4 : 2)
      answer = JSON.stringify({ factIds: selected.map(fact => fact.id) })
    } else {
      answer = createGeneralAnswer(question, { history: options.messages.slice(1, -1).map(message => ({ role: message.role, text: message.content })) }).text
        .replace(/\n\nMock technical response · No AI service is connected\.$/, '')
    }
    return (async function* () {
      const wait = ms => new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return }
        const abort = () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
        signal.addEventListener('abort', abort, { once: true })
      })
      await wait(300)
      for (let offset = 0; offset < answer.length; offset += 48) {
        await wait(35)
        yield { choices: [{ delta: { content: answer.slice(offset, offset + 48) } }] }
      }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
    })()
  } } },
}
