import { streamChat } from './streamResponder'

// Personal facts are available only through the backend, including development.
export const isMockDevelopment = false
export async function respondToChat(question, options) {
  return streamChat(question, options)
}
