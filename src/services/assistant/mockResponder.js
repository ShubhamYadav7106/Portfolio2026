import { DEFAULT_MODE, isMode } from './modes'
import { createRecruiterAnswer } from './recruiterResponder'
import { createGeneralAnswer } from './generalResponder'

export function createMockAnswer(question, { mode = DEFAULT_MODE, facts = [], history = [], today } = {}) {
  if (!isMode(mode)) throw new Error('Unknown assistant mode')
  return mode === 'recruiter'
    ? createRecruiterAnswer(question, { facts, today, history })
    : createGeneralAnswer(question, { history })
}

export function respondWithMock(question, { signal, delay = 850, ...options } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Response stopped', 'AbortError'))
      return
    }
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('Response stopped', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      try { resolve(createMockAnswer(question, options)) } catch (error) { reject(error) }
    }, delay)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export const createMockResponder = facts => (question, options) => respondWithMock(question, { ...options, facts })
