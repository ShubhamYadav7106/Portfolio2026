import { streamChat } from './streamResponder'

// This branch is removed from production builds, including the personal JSON.
export const isMockDevelopment = import.meta.env.DEV && import.meta.env.VITE_CHAT_MOCK === 'true'
let developmentResponder
export async function respondToChat(question, options) {
  if (isMockDevelopment) {
    developmentResponder ||= Promise.all([import('./mockResponder'), import('./knowledgeStore')])
      .then(([mock, knowledge]) => mock.createMockResponder(knowledge.knowledgeFacts))
    return (await developmentResponder)(question, options)
  }
  return streamChat(question, options)
}
