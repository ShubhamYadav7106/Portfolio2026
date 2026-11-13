import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import { streamChat } from '../services/assistant/streamResponder'
import { DEFAULT_MODE, MODES, isMode, parseModeCommand } from '../services/assistant/modes'

export const MAX_MESSAGE_LENGTH = 600
const emptySession = () => ({ messages: [], error: '', notice: '', retryPrompt: '', partialId: null, userMessageId: null })

export function useChat(responder = streamChat) {
  const activeMode = ref(DEFAULT_MODE)
  const sessions = ref({ recruiter: emptySession(), general: emptySession() })
  const session = computed(() => sessions.value[activeMode.value])
  const messages = computed(() => session.value.messages)
  const error = computed(() => session.value.error)
  const notice = computed(() => session.value.notice)
  const isLoading = ref(false)
  // A request can still be streaming after its first visible content arrives.
  const isWaitingForResponse = computed(() => isLoading.value && !session.value.messages.find(message => message.id === session.value.partialId)?.text.trim())
  const canRetry = computed(() => Boolean(session.value.retryPrompt) && !isLoading.value)
  const hasHistory = computed(() => Object.values(sessions.value).some(item => item.messages.length > 0))
  let controller
  let generation = 0
  let nextId = 0

  async function requestReply(prompt, retrying = false) {
    if (isLoading.value) return
    const currentGeneration = ++generation
    const mode = activeMode.value
    const target = session.value
    if (retrying && target.partialId !== null) target.messages = target.messages.filter(message => message.id !== target.partialId)
    target.partialId = null
    let partial
    controller = new AbortController()
    isLoading.value = true
    target.error = ''
    target.notice = ''
    target.retryPrompt = prompt
    try {
      const userIndex = target.messages.findIndex(message => message.id === target.userMessageId)
      const history = target.messages.slice(0, userIndex).filter(message => message.role === 'user' || message.status === 'complete').map(message => ({ role: message.role, text: message.text }))
      const reply = await responder(prompt, {
        signal: controller.signal, mode, history,
        onDelta(text) {
          if (currentGeneration !== generation || !text) return
          if (!partial) {
            target.messages.push({ id: ++nextId, role: 'assistant', mode, text: '', sources: [], provider: 'groq', status: 'streaming' })
            partial = target.messages.at(-1)
            target.partialId = partial.id
          }
          partial.text += text
        },
        onSources(sources) {
          if (currentGeneration === generation && partial) { partial.sources = sources; partial.verification = 'verified' }
        },
      })
      if (currentGeneration !== generation) return
      if (typeof reply?.text !== 'string') throw new Error('Invalid AI response')
      const completed = { role: 'assistant', mode, text: reply.text, sources: reply.sources || [], verification: reply.verification, provider: reply.provider, generalQuestion: mode === 'recruiter' && reply.generalQuestion === true, status: 'complete' }
      if (partial) Object.assign(partial, completed)
      else target.messages.push({ id: ++nextId, ...completed })
      target.partialId = null
      target.retryPrompt = ''
    } catch (reason) {
      if (currentGeneration !== generation) return
      if (partial) partial.status = 'interrupted'
      if (reason?.name !== 'AbortError') target.error = reason?.userMessage || 'That response couldn’t be completed. Please try again.'
    } finally {
      if (currentGeneration === generation) isLoading.value = false
    }
  }

  function stop() {
    if (!isLoading.value) return
    ++generation
    controller?.abort()
    const partial = session.value.messages.find(message => message.id === session.value.partialId)
    if (partial) partial.status = 'interrupted'
    isLoading.value = false
    session.value.notice = 'Response stopped. You can retry your last question.'
  }

  function setMode(mode) {
    if (!isMode(mode)) return false
    if (mode === activeMode.value) return true
    stop()
    activeMode.value = mode
    session.value.notice = `Switched to ${MODES[mode].label}. Each mode has its own conversation.`
    return true
  }

  function send(text) {
    if (typeof text !== 'string') return false
    const prompt = text.trim()
    if (!prompt || prompt.length > MAX_MESSAGE_LENGTH) return false
    const requestedMode = parseModeCommand(prompt)
    if (requestedMode) return setMode(requestedMode)
    if (isLoading.value) return false
    // Sending the unanswered prompt again is an explicit retry of that turn,
    // not another user message. Completed or different questions stay in history.
    if (session.value.retryPrompt === prompt) return retry()
    const id = ++nextId
    session.value.messages.push({ id, role: 'user', text: prompt, mode: activeMode.value })
    session.value.userMessageId = id
    void requestReply(prompt)
    return true
  }

  function retry() {
    if (!canRetry.value) return false
    void requestReply(session.value.retryPrompt, true)
    return true
  }

  function clear() {
    ++generation
    controller?.abort()
    isLoading.value = false
    sessions.value = { recruiter: emptySession(), general: emptySession() }
    activeMode.value = DEFAULT_MODE
    session.value.notice = 'Both conversations cleared. Recruiter Mode is active.'
  }

  if (getCurrentScope()) onScopeDispose(() => {
    ++generation
    controller?.abort()
  })

  return { activeMode, messages, isLoading, isWaitingForResponse, error, notice, canRetry, hasHistory, setMode, send, retry, stop, clear }
}
