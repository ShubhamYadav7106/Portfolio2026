import { PublicError } from './errors.js'

const fail = () => { throw new PublicError(400, 'INVALID_INPUT', 'Send a valid mode, message, and bounded conversation history.') }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const onlyKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key))
export const MAX_MESSAGE_LENGTH = 600
export const MAX_HISTORY_LENGTH = 16
export const MAX_HISTORY_CHARS = 16000

export function validateChatInput(body) {
  if (!object(body) || !onlyKeys(body, ['mode', 'message', 'history']) || !['recruiter', 'general'].includes(body.mode)) fail()
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > MAX_MESSAGE_LENGTH) fail()
  if (!Array.isArray(body.history) || body.history.length > MAX_HISTORY_LENGTH) fail()
  let characters = 0
  const history = body.history.map(item => {
    if (!object(item) || !onlyKeys(item, ['role', 'text', 'mode']) || item.mode !== body.mode || !['user', 'assistant'].includes(item.role)) fail()
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > (item.role === 'user' ? MAX_MESSAGE_LENGTH : 8000)) fail()
    characters += item.text.length
    return { role: item.role, content: item.text }
  })
  if (characters > MAX_HISTORY_CHARS) fail()
  return { mode: body.mode, message: body.message.trim(), history }
}
