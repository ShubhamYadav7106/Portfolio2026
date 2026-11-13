<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowPathIcon, ArrowUpIcon, ChevronRightIcon, StopIcon, TrashIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { MAX_MESSAGE_LENGTH, useChat } from '../../composables/useChat'
import { respondToChat, isMockDevelopment } from '../../services/assistant/chatProvider'
import { MODES } from '../../services/assistant/modes'
import AssistantMark from './AssistantMark.vue'
import ChatMessage from './ChatMessage.vue'
import ModeSelector from './ModeSelector.vue'

const { activeMode, messages, isLoading, isWaitingForResponse, error, notice, canRetry, hasHistory, setMode, send, retry, stop, clear } = useChat(respondToChat)
const mode = computed(() => MODES[activeMode.value])
const isOpen = ref(false)
const isMobile = ref(false)
const drafts = ref({ recruiter: '', general: '' })
const draft = computed({ get: () => drafts.value[activeMode.value], set: value => { drafts.value[activeMode.value] = value } })
const launcher = ref(null)
const panel = ref(null)
const composer = ref(null)
const transcript = ref(null)
const viewport = ref({})
const unread = ref(false)
const hasConversation = computed(() => messages.value.length > 0)
const canSend = computed(() => draft.value.trim().length > 0 && draft.value.length <= MAX_MESSAGE_LENGTH && !isLoading.value)
const selectedSuggestions = ref({ recruiter: [], general: [] })
// FAQ and quick actions use this same catalog and selectedSuggestions state.
const recruiterSuggestions = [
  { topic: 'skills', quick: 'Skills', label: 'What does Shubham work with?', detail: 'Core languages & technologies', question: 'What are Shubham’s main technical skills?', match: /skill|tech|stack|react|javascript/i, related: ['projects', 'experience'] },
  { topic: 'experience', quick: 'Internships', label: 'Tell me about his experience', detail: 'Roles & contributions', question: 'What experience does Shubham have?', match: /intern|experience|company|role|indux/i, related: ['projects', 'skills'] },
  { topic: 'skills', quick: 'Full Tech Stack', label: 'Full Tech Stack', detail: 'All skills, organized by category', question: 'What is Shubham’s full tech stack?', match: /skill|tech|stack/i, related: ['projects', 'experience'] },
  { topic: 'projects', quick: 'Featured Projects', label: 'Which projects should I explore?', detail: 'Portfolio projects & company work', question: 'What projects has Shubham worked on?', match: /project|built|crm|eventverse/i, related: ['experience', 'skills', 'github'] },
  { topic: 'projects', quick: 'Real-World Project', label: 'What real-world project has Shubham worked on?', detail: 'Practical internship & company work', question: 'What real-world project has Shubham worked on?', match: /real.world|crm/i, related: ['experience', 'skills'] },
  { topic: 'contact', quick: 'Contact', label: 'How can I get in touch?', detail: 'Email & LinkedIn', question: 'How can I contact Shubham?', match: /contact|email|reach/i, related: ['resume', 'availability', 'linkedin'] },
  { topic: 'education', quick: 'Education', label: 'Where is he studying?', detail: 'Degree & university', question: 'What is Shubham studying, and at which university?', match: /educat|college|degree|course|university/i, related: ['achievements', 'skills'] },
  { topic: 'achievements', quick: 'Achievements', label: 'What has he achieved?', detail: 'Awards & recognition', question: 'What awards has Shubham received?', match: /award|achiev|certif|hackathon/i, related: ['projects', 'education'] },
  { topic: 'resume', quick: 'Resume', label: 'Where can I view his résumé?', detail: 'View his professional background', question: 'Where can I view Shubham’s résumé?', match: /resume|résumé|\bcv\b/i, related: ['experience', 'contact'] },
  { topic: 'availability', quick: 'Availability', label: 'When can he join?', detail: 'Joining & opportunities', question: 'When can Shubham join a job or internship?', match: /availab|join|hiring|relocat/i, related: ['contact', 'resume'] },
  { topic: 'experience', quick: 'Training', label: 'Explore his training experience', question: 'What training experience does Shubham have?', match: /train(?:ing|ee)/i, related: ['skills', 'projects'] },
  { topic: 'experience', quick: 'Internship Timeline', label: 'Explore his internship and training timeline', question: 'Show Shubham’s internship and training timeline with roles, companies, dates and durations.', match: /timeline|chronolog|dates|duration/i, related: ['resume', 'skills', 'projects'] },
  { topic: 'github', quick: 'GitHub', label: 'Explore his GitHub profile', detail: 'His public developer profile', question: 'What is Shubham’s GitHub profile link?', match: /github|repositori/i, related: ['projects', 'skills', 'linkedin'] },
  { topic: 'linkedin', quick: 'LinkedIn', label: 'Connect with him on LinkedIn', detail: 'His professional profile', question: 'What is Shubham’s LinkedIn profile link?', match: /linkedin|linkdin/i, related: ['resume', 'experience', 'contact'] },
]
const suggestionKey = question => question.trim().toLowerCase().replace(/[?.!]+$/, '')
const suggestionPool = computed(() => {
  const options = activeMode.value === 'recruiter' ? recruiterSuggestions : [...mode.value.suggestions, ...mode.value.followups]
  return [...new Map(options.map(item => [suggestionKey(item.question), item])).values()]
})
const unusedSuggestions = computed(() => suggestionPool.value.filter(item => !selectedSuggestions.value[activeMode.value].includes(suggestionKey(item.question))))
const starterSuggestions = computed(() => unusedSuggestions.value.filter(item => item.detail))
const quickActions = computed(() => {
  if (activeMode.value !== 'recruiter') return unusedSuggestions.value.filter(item => !item.detail).slice(0, 2)
  const questions = messages.value.filter(item => item.role === 'user').map(item => item.text)
  const latest = questions.at(-1) || ''
  const currentTopics = recruiterSuggestions.filter(item => item.match.test(latest))
  const related = new Set(currentTopics.flatMap(item => item.related))
  const score = item => (related.has(item.topic) ? 2 : 0) - (questions.some(question => item.match.test(question)) ? 3 : 0)
  return [...unusedSuggestions.value].sort((a, b) => score(b) - score(a)).slice(0, isMobile.value ? 2 : 4)
})

function chooseSuggestion(item) {
  if (!submit(item.question)) return
  void nextTick(() => (isMobile.value ? panel.value : composer.value)?.focus())
}
let mobileQuery
let releaseMobileLock

function updateViewport() {
  const visible = window.visualViewport
  viewport.value = {
    '--ask-viewport-height': `${visible?.height ?? window.innerHeight}px`,
    '--ask-viewport-top': `${visible?.offsetTop ?? 0}px`,
  }
}

function updateMobile() {
  isMobile.value = mobileQuery.matches
  updateViewport()
}

function syncMobileLock() {
  releaseMobileLock?.()
  releaseMobileLock = undefined
  if (!isOpen.value || !isMobile.value) return
  const app = document.getElementById('app')
  const originalInert = app?.inert
  const originalOverflow = document.body.style.overflow
  if (app) app.inert = true
  document.body.style.overflow = 'hidden'
  releaseMobileLock = () => {
    if (app) app.inert = originalInert
    document.body.style.overflow = originalOverflow
  }
}

async function open() {
  isOpen.value = true
  unread.value = false
  await nextTick()
  // Keep the phone keyboard closed until the visitor chooses to type.
  if (isMobile.value) panel.value?.focus({ preventScroll: true })
  else composer.value?.focus({ preventScroll: true })
  scrollToLatest()
}

async function close() {
  isOpen.value = false
  await nextTick()
  launcher.value?.focus({ preventScroll: true })
}

function resizeComposer() {
  if (!composer.value) return
  composer.value.style.height = 'auto'
  composer.value.style.height = `${Math.min(composer.value.scrollHeight, 112)}px`
}

function submit(question = draft.value) {
  const submittedMode = activeMode.value
  if (!send(question)) return false
  const key = suggestionKey(question)
  if (suggestionPool.value.some(item => suggestionKey(item.question) === key) && !selectedSuggestions.value[submittedMode].includes(key)) selectedSuggestions.value[submittedMode].push(key)
  drafts.value[submittedMode] = ''
  unread.value = false
  void nextTick(resizeComposer)
  return true
}

function onComposerKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  }
}

function scrollToLatest(force = true) {
  const element = transcript.value
  if (!element) return
  if (force) element.scrollTop = hasConversation.value ? element.scrollHeight : 0
}

watch(() => [messages.value.length, messages.value.at(-1)?.text.length, isLoading.value, error.value, notice.value], async (current, previous) => {
  const element = transcript.value
  const nearBottom = !element || element.scrollHeight - element.scrollTop - element.clientHeight < 100
  const userSent = messages.value.at(-1)?.role === 'user'
  await nextTick()
  if (nearBottom || userSent || !hasConversation.value) scrollToLatest()
  else if (current[0] !== previous?.[0] || current[1] !== previous?.[1]) unread.value = true
})

watch([isOpen, isMobile], syncMobileLock)
watch(activeMode, async () => {
  unread.value = false
  await nextTick()
  resizeComposer()
  scrollToLatest()
})

function onDocumentKeydown(event) {
  if (!isOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    void close()
    return
  }
  if (event.key !== 'Tab' || !isMobile.value) return
  const controls = [...panel.value.querySelectorAll('button:not([disabled]), input[type="radio"]:checked, a[href], textarea:not([disabled]), [tabindex="0"]')]
    .filter(element => element.getClientRects().length > 0)
  const first = controls[0]
  const last = controls.at(-1)
  const active = document.activeElement
  if (event.shiftKey && (active === first || active === panel.value)) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && (active === last || active === panel.value)) {
    event.preventDefault()
    first?.focus()
  }
}

function clearChat() {
  clear()
  selectedSuggestions.value = { recruiter: [], general: [] }
  drafts.value = { recruiter: '', general: '' }
  unread.value = false
  void nextTick(() => {
    resizeComposer()
    if (!isMobile.value) composer.value?.focus({ preventScroll: true })
  })
}

function followSource() {
  // Release mobile scroll and focus locks before navigating a portfolio anchor.
  void close()
}

onMounted(() => {
  mobileQuery = window.matchMedia('(max-width: 639px)')
  updateMobile()
  mobileQuery.addEventListener('change', updateMobile)
  document.addEventListener('keydown', onDocumentKeydown)
  window.visualViewport?.addEventListener('resize', updateViewport)
  window.visualViewport?.addEventListener('scroll', updateViewport)
  window.addEventListener('resize', updateViewport)
})

onBeforeUnmount(() => {
  releaseMobileLock?.()
  mobileQuery?.removeEventListener('change', updateMobile)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.visualViewport?.removeEventListener('resize', updateViewport)
  window.visualViewport?.removeEventListener('scroll', updateViewport)
  window.removeEventListener('resize', updateViewport)
})
</script>

<template>
  <Teleport to="body">
    <div class="ask-shubham" :style="viewport">
      <Transition name="ask-backdrop">
        <div v-if="isOpen && isMobile" class="chat-backdrop" aria-hidden="true" @click="close" />
      </Transition>

      <Transition name="ask-panel">
        <section
          v-if="isOpen"
          id="ask-shubham-panel"
          ref="panel"
          class="chat-panel"
          role="dialog"
          :aria-modal="isMobile ? 'true' : undefined"
          aria-labelledby="ask-shubham-title"
          :aria-describedby="isMockDevelopment ? 'ask-preview-description' : undefined"
          tabindex="-1"
        >
          <header class="chat-header">
            <div class="header-identity">
              <div class="header-avatar"><AssistantMark /></div>
              <div>
                <h2 id="ask-shubham-title">Ask Shubham AI</h2>
                <p>Shubham’s work, in conversation</p>
              </div>
            </div>
            <div class="header-actions">
              <button class="icon-button" :disabled="!hasHistory" aria-label="Clear chat" title="Clear both conversations" @click="clearChat"><TrashIcon /></button>
              <button class="icon-button close-chat" aria-label="Close chat" title="Close chat (Escape)" @click="close"><XMarkIcon /></button>
            </div>
            <ModeSelector :model-value="activeMode" @update:model-value="setMode" />
          </header>

          <div v-if="isMockDevelopment" id="ask-preview-description" class="preview-bar">
            <span class="preview-badge">Mock</span>
            <span>Local preview. No messages are sent.</span>
          </div>

          <div ref="transcript" class="chat-transcript" role="log" :aria-label="`${mode.label} conversation with Ask Shubham AI`" aria-live="polite" aria-relevant="additions text" :aria-busy="isLoading">
            <div v-if="!hasConversation" class="chat-welcome">
              <p class="welcome-eyebrow">{{ mode.eyebrow }}</p>
              <h3>{{ mode.heading[0] }}<br />{{ mode.heading[1] }}</h3>
              <p class="welcome-description">{{ mode.description }}</p>

              <div v-if="starterSuggestions.length" class="suggested-questions" :class="{ 'scrollable-suggestions': activeMode === 'recruiter' }" :aria-label="`Suggested ${mode.label} questions`">
                <button v-for="(suggestion, index) in starterSuggestions" :key="suggestion.question" class="suggestion" :disabled="isLoading" @click="chooseSuggestion(suggestion)">
                  <span class="suggestion-index">{{ String(index + 1).padStart(2, '0') }}</span>
                  <span class="suggestion-copy"><span>{{ suggestion.label }}</span><small>{{ suggestion.detail }}</small></span>
                  <ChevronRightIcon aria-hidden="true" />
                </button>
              </div>
              <p class="welcome-review">{{ mode.review }}</p>
            </div>

            <template v-else>
              <ChatMessage v-for="message in messages" :key="message.id" :message="message" @navigate="followSource" />
              <div v-if="isWaitingForResponse" class="loading-response" role="status" aria-atomic="true">
                <AssistantMark />
                <span>{{ isMockDevelopment ? 'Thinking (mock)' : 'Thinking' }}<span class="sr-only">...</span></span>
                <span class="loading-dots" aria-hidden="true"><i /><i /><i /></span>
              </div>
              <div v-if="error || (canRetry && !isLoading)" class="response-feedback">
                <p v-if="error" role="alert">{{ error }}</p>
                <p v-else>{{ notice }}</p>
                <button class="retry-button" @click="retry"><ArrowPathIcon aria-hidden="true" />Retry response</button>
              </div>
            </template>
          </div>

          <button v-if="unread" class="new-response" @click="scrollToLatest(); unread = false">New response ↓</button>

          <footer class="chat-footer">
            <div v-if="hasConversation && quickActions.length" class="followup-questions" :class="{ 'followup-questions--pending': isLoading }" :aria-hidden="isLoading ? 'true' : undefined" aria-label="More questions">
              <button v-for="followup in quickActions" :key="followup.question" :disabled="isLoading" @click="chooseSuggestion(followup)">{{ followup.quick || followup.label }}</button>
            </div>
            <form class="composer" @submit.prevent="submit()">
              <label class="sr-only" for="ask-shubham-input">{{ activeMode === 'recruiter' ? 'Ask about Shubham’s portfolio' : 'Ask a programming question' }}</label>
              <textarea
                id="ask-shubham-input"
                ref="composer"
                v-model="draft"
                name="question"
                rows="1"
                :maxlength="MAX_MESSAGE_LENGTH"
                :aria-describedby="draft.length > 500 ? 'ask-character-count ask-input-hint' : 'ask-input-hint'"
                :placeholder="mode.placeholder"
                @input="resizeComposer"
                @keydown="onComposerKeydown"
              />
              <button v-if="isLoading" type="button" class="send-button" aria-label="Stop response" title="Stop response" @click="stop"><StopIcon /></button>
              <button v-else type="submit" class="send-button" :disabled="!canSend" aria-label="Send message" title="Send message"><ArrowUpIcon /></button>
            </form>
            <div class="composer-meta">
              <p id="ask-input-hint">{{ isMobile ? 'A question is a good place to start.' : 'Enter to send · Shift + Enter for a new line' }}</p>
              <span v-if="draft.length > 500" id="ask-character-count">{{ draft.length }}/{{ MAX_MESSAGE_LENGTH }}</span>
              <span v-else class="session-note">Session only</span>
            </div>
          </footer>
          <p class="sr-only" role="status">{{ !canRetry ? notice : '' }}</p>
        </section>
      </Transition>

      <Transition name="ask-launcher">
        <button v-show="!isOpen" ref="launcher" class="chat-launcher" aria-label="Open Ask Shubham AI" aria-haspopup="dialog" aria-controls="ask-shubham-panel" :aria-expanded="isOpen" @click="open">
          <span class="launcher-mark"><AssistantMark /></span>
          <span class="launcher-copy"><small>A conversation about my work</small><span>Ask Shubham AI</span></span>
          <ChevronRightIcon class="launcher-arrow" aria-hidden="true" />
        </button>
      </Transition>
    </div>
  </Teleport>
</template>

<style scoped>
/* UI craft guided by unslop, Damir Sokolovsky (@heydamir), CC BY 4.0.
   https://heydamir.design/unslop */
.ask-shubham {
  --ask-accent: #17685e;
  --ask-accent-light: #298176;
  --ask-link: #17685e;
  --ask-bg: #faf9f6;
  --ask-text: #252927;
  --ask-muted: #626762;
  --ask-border: #dedfd9;
  --ask-soft: #efefea;
  --ask-panel-right: 24px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ask-text);
}
:global(html.dark .ask-shubham) {
  --ask-accent: #17685e;
  --ask-accent-light: #88bfb2;
  --ask-link: #a0cec3;
  --ask-bg: #181c1c;
  --ask-text: #eeefea;
  --ask-muted: #a5afa9;
  --ask-border: #363d39;
  --ask-soft: #252b28;
}
button, textarea, a { -webkit-tap-highlight-color: transparent; }
button { font: inherit; cursor: pointer; }
button:disabled { cursor: default; }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--ask-accent-light); outline-offset: 3px; }
.chat-launcher {
  position: fixed; z-index: 30;
  right: max(var(--ask-panel-right), env(safe-area-inset-right));
  bottom: max(24px, calc(env(safe-area-inset-bottom) + 16px));
  display: flex; align-items: center; gap: 12px; padding: 12px 16px 12px 12px;
  border: 1px solid var(--ask-border); border-radius: 16px;
  color: var(--ask-text); background: var(--ask-bg); box-shadow: 0 8px 24px #00000014;
  text-align: left; transition: background .16s ease, border-color .16s ease;
}
.chat-launcher:hover { background: var(--ask-soft); border-color: var(--ask-muted); }
.launcher-mark { display: grid; place-items: center; width: 40px; height: 40px; border-right: 1px solid var(--ask-border); padding-right: 12px; color: var(--ask-link); }
.launcher-mark .assistant-mark { width: 28px; height: 28px; }
.launcher-copy { display: flex; flex-direction: column; gap: 4px; }
.launcher-copy small { font-size: 11px; color: var(--ask-muted); }
.launcher-copy > span { font-size: 14px; font-weight: 600; }
.launcher-arrow { width: 16px; height: 16px; margin-left: 8px; color: var(--ask-muted); }
.chat-panel {
  position: fixed; z-index: 40;
  right: max(var(--ask-panel-right), env(safe-area-inset-right));
  bottom: max(24px, calc(env(safe-area-inset-bottom) + 16px));
  width: 440px; height: min(704px, calc(100vh - 48px)); height: min(704px, calc(100dvh - 48px));
  display: flex; flex-direction: column; overflow: hidden;
  border: 1px solid var(--ask-border); border-radius: 20px;
  background: var(--ask-bg); box-shadow: 0 16px 48px #0000001f;
  isolation: isolate; transform-origin: bottom right;
}
.chat-panel:focus { outline: none; }
.chat-panel, .chat-panel * { box-sizing: border-box; }
.chat-panel { max-width: calc(100vw - 32px); }
.header-identity { flex: 1; }
.header-identity > div { min-width: 0; overflow-wrap: anywhere; }
.header-actions { flex-shrink: 0; }
.chat-header { display: flex; flex-wrap: wrap; flex-shrink: 0; align-items: center; justify-content: space-between; padding: 20px 20px 16px; gap: 0 8px; }
.header-identity { display: flex; align-items: center; gap: 12px; min-width: 0; }
.header-avatar { display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border: 1px solid var(--ask-border); border-radius: 8px; color: var(--ask-link); }
.header-avatar .assistant-mark { width: 32px; height: 32px; }
.header-identity h2 { margin: 0; font-size: 16px; font-weight: 600; }
.header-identity p { margin: 4px 0 0; font-size: 11px; color: var(--ask-muted); }
.header-actions { display: flex; gap: 4px; }
.icon-button { display: grid; place-items: center; width: 36px; height: 36px; border: 0; border-radius: 8px; color: var(--ask-muted); background: transparent; transition: background .16s ease, color .16s ease; }
.icon-button svg { width: 20px; height: 20px; }
.icon-button:hover:not(:disabled) { background: var(--ask-soft); color: var(--ask-text); }
.icon-button:disabled { opacity: .4; }
.preview-bar { display: flex; align-items: center; gap: 12px; flex-shrink: 0; padding: 12px 20px; border-block: 1px solid var(--ask-border); font-size: 11px; color: var(--ask-muted); }
.preview-badge { color: var(--ask-link); font-weight: 600; }
.chat-transcript { flex: 1; min-height: 0; min-width: 0; padding: 20px 24px; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--ask-border) transparent; }
.chat-transcript :deep(.chat-message--assistant) { animation: ask-answer-in .16s ease; }
.chat-welcome { padding-top: 0; }
.welcome-eyebrow { margin: 0 0 12px; color: var(--ask-muted); font-size: 12px; }
.chat-welcome h3 { margin: 0; font-family: Georgia, 'Times New Roman', serif; font-size: 28px; font-weight: 400; line-height: 1.1; letter-spacing: -.025em; }
.welcome-description { margin: 12px 0 16px; font-size: 13px; line-height: 1.6; color: var(--ask-muted); }
.suggested-questions { display: grid; border-top: 1px solid var(--ask-border); }
.scrollable-suggestions { grid-auto-rows: minmax(4.5rem, auto); max-height: 18rem; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--ask-border) transparent; }
.suggestion { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 60px; padding: 12px 4px; text-align: left; color: var(--ask-text); border: 0; border-bottom: 1px solid var(--ask-border); border-radius: 0; background: transparent; transition: background .16s ease; }
.suggestion:hover { background: var(--ask-soft); }
.suggestion:focus-visible { outline-offset: -2px; }
.suggestion-index { width: 24px; flex-shrink: 0; font: 11px ui-monospace, monospace; font-variant-numeric: tabular-nums; color: var(--ask-muted); }
.suggestion-copy { min-width: 0; overflow-wrap: anywhere; line-height: 1.45; display: flex; flex-direction: column; gap: 4px; }
.suggestion-copy > span { font-size: 13px; font-weight: 500; }
.suggestion-copy small { font-size: 11px; color: var(--ask-muted); }
.suggestion > svg { width: 16px; height: 16px; margin-left: auto; flex-shrink: 0; color: var(--ask-muted); }
.welcome-review { margin: 12px 0 0; font-size: 11px; line-height: 1.6; color: var(--ask-muted); }
.loading-response { display: flex; align-items: center; gap: 8px; padding-bottom: 12px; color: var(--ask-muted); font-size: 13px; }
.loading-response > .assistant-mark { width: 24px; height: 24px; }
.loading-dots { display: flex; gap: 4px; }
.loading-dots i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; animation: ask-thinking 1.2s ease infinite; }
.loading-dots i:nth-child(2) { animation-delay: .16s; }
.loading-dots i:nth-child(3) { animation-delay: .32s; }
.response-feedback { padding: 16px; border: 1px solid var(--ask-border); border-radius: 8px; background: var(--ask-soft); }
.response-feedback p { overflow-wrap: anywhere; margin: 0 0 12px; font-size: 13px; line-height: 1.6; }
.retry-button { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 4px 0; border: 0; background: transparent; color: var(--ask-link); font-size: 13px; }
.retry-button svg { height: 16px; width: 16px; }
.new-response { align-self: center; margin-top: -40px; margin-bottom: 8px; padding: 8px 12px; border: 1px solid var(--ask-border); border-radius: 8px; background: var(--ask-soft); color: var(--ask-link); font-size: 12px; z-index: 1; }
.chat-footer { flex-shrink: 0; padding: 16px 20px; border-top: 1px solid var(--ask-border); background: var(--ask-bg); }
.followup-questions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: stretch; gap: 6px; margin-bottom: 12px; }
.followup-questions--pending { visibility: hidden; }
.followup-questions button { min-width: 0; min-height: 44px; padding: 6px; line-height: 1.35; overflow-wrap: anywhere; text-align: center; border: 1px solid var(--ask-border); border-radius: 8px; color: var(--ask-muted); background: transparent; font-size: 12px; transition: color .16s ease, background .16s ease; }
.followup-questions button:hover { color: var(--ask-link); background: var(--ask-soft); }
.composer { display: flex; align-items: flex-end; gap: 8px; padding: 8px; border: 1px solid var(--ask-border); border-radius: 12px; background: var(--ask-soft); transition: border-color .16s ease; }
.composer:focus-within { border-color: var(--ask-accent-light); outline: 1px solid var(--ask-accent-light); }
.composer textarea { display: block; flex: 1; min-width: 0; min-height: 40px; max-height: 112px; padding: 8px 4px; border: 0; outline: none; resize: none; background: transparent; color: var(--ask-text); font: inherit; font-size: 14px; line-height: 24px; scrollbar-width: thin; }
.composer textarea::placeholder { color: var(--ask-muted); opacity: 1; }
.composer textarea:focus-visible { outline: none; }
.send-button { display: grid; place-items: center; flex-shrink: 0; width: 40px; height: 40px; border: 0; border-radius: 8px; color: #fff; background: var(--ask-accent); transition: opacity .16s ease; }
.send-button svg { width: 20px; height: 20px; }
.send-button:hover:not(:disabled) { opacity: .85; }
.send-button:disabled { background: var(--ask-border); color: var(--ask-muted); }
.composer-meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; font-size: 11px; line-height: 1.5; color: var(--ask-muted); }
.composer-meta p { margin: 0; }
.session-note { white-space: nowrap; }
.chat-backdrop { position: fixed; z-index: 35; inset: 0; background: #0b100e80; }
.ask-panel-enter-active, .ask-panel-leave-active { transition: opacity .2s ease, transform .2s ease; }
.ask-panel-enter-from, .ask-panel-leave-to { opacity: 0; transform: translateY(8px); }
.ask-launcher-enter-active, .ask-launcher-leave-active, .ask-backdrop-enter-active, .ask-backdrop-leave-active { transition: opacity .16s ease; }
.ask-launcher-enter-from, .ask-launcher-leave-to, .ask-backdrop-enter-from, .ask-backdrop-leave-to { opacity: 0; }
@keyframes ask-thinking { 0%, 60%, 100% { opacity: .35; } 30% { opacity: 1; } }
@keyframes ask-answer-in { from { opacity: .7; } to { opacity: 1; } }
/* Keep clear of the portfolio's vertical location label. */
@media (min-width: 768px) { .ask-shubham { --ask-panel-right: 88px; } }
@media (max-width: 639px) {
  .ask-shubham { --ask-panel-right: 16px; }
  .chat-launcher { bottom: max(16px, calc(env(safe-area-inset-bottom) + 12px)); }
  .chat-panel { top: calc(var(--ask-viewport-top, 0px) + 8px); right: max(8px, env(safe-area-inset-right)); left: max(8px, env(safe-area-inset-left)); bottom: auto; width: auto; height: calc(var(--ask-viewport-height, 100dvh) - 16px); border-radius: 16px; transform-origin: bottom center; }
  .chat-header { padding: 16px; }
  .followup-questions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .icon-button { width: 40px; height: 40px; }
  .preview-bar { padding: 12px 16px; }
  .chat-transcript { padding: 24px 20px; }
  .chat-welcome h3 { font-size: 28px; }
  .chat-footer { padding: 12px 16px max(16px, env(safe-area-inset-bottom)); }
  .composer textarea { font-size: 16px; }
}
@media (max-width: 359px) {
  .header-identity { gap: 8px; }
  .header-avatar { width: 32px; height: 32px; }
  .header-identity h2 { font-size: 14px; }
  .header-identity p { font-size: 11px; max-width: 136px; }
  .chat-header { padding-inline: 12px; }
  .header-actions { gap: 0; }
  .icon-button { width: 36px; height: 40px; }
  .chat-welcome h3 { font-size: 26px; }
  .preview-bar { padding-inline: 12px; }
  .composer-meta { font-size: 10px; }
}
@media (max-height: 500px) {
  .chat-header { padding: 8px 12px; }
  .header-avatar { width: 32px; height: 32px; }
  .header-identity p { display: none; }
  .preview-bar { padding-block: 8px; }
  .chat-transcript { padding-block: 12px; }
  .chat-footer { padding: 8px 12px max(8px, env(safe-area-inset-bottom)); }
  .followup-questions { flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
  .followup-questions button { min-height: 32px; padding: 4px 8px; font-size: 11px; }
  .composer-meta { margin-top: 4px; font-size: 10px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } .chat-transcript :deep(.chat-message--assistant) { animation: none; } }
</style>
