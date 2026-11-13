<script setup>
import { ArrowUpRightIcon } from '@heroicons/vue/24/outline'
import { RouterLink } from 'vue-router'
import { computed, h, ref } from 'vue'
import { splitMessageContent, recruiterMarkdown, highlightMessageCode } from '../../services/assistant/messageContent'
import AssistantMark from './AssistantMark.vue'

const props = defineProps({ message: { type: Object, required: true } })
defineEmits(['navigate'])
const isExternal = href => /^https:\/\//.test(href)
const content = computed(() => props.message.role === 'assistant' ? splitMessageContent(props.message.text) : [{ type: 'text', text: props.message.text }])
const markdownAnswer = computed(() => props.message.role === 'assistant' && ['recruiter', 'general'].includes(props.message.mode))
const markdown = computed(() => markdownAnswer.value ? recruiterMarkdown(props.message.text) : [])
const copyStatus = ref({})
// Model content is always a text child. Tag names and attributes come only
// from this allowlist; no v-html, arbitrary attributes or HTML execution.
const inlineNodes = tokens => tokens.map(token => {
  if (token.type === 'strong') return h('strong', inlineNodes(token.children))
  if (token.type === 'inline-code') return h('code', token.text)
  if (token.type === 'link') return h('a', { href: token.href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${token.children.map(child => child.text).join('')} (opens in a new tab)` }, inlineNodes(token.children))
  return token.text
})
const InlineMarkdown = ({ tokens }) => inlineNodes(tokens)

async function copyCode(block, index) {
  try {
    await navigator.clipboard.writeText(block.text)
    copyStatus.value[index] = { text: block.text, label: 'Copied' }
  } catch {
    copyStatus.value[index] = { text: block.text, label: 'Copy failed' }
  }
}
</script>

<template>
  <article class="chat-message" :class="`chat-message--${message.role}`" :aria-label="message.role === 'user' ? 'You' : 'Ask Shubham AI'">
    <div v-if="message.role === 'assistant'" class="message-byline">
      <AssistantMark class="message-mark" />
      <span>Ask Shubham AI</span>
    </div>
    <div v-if="markdownAnswer" class="markdown-content">
      <template v-for="(block, index) in markdown" :key="index">
        <div v-if="block.type === 'code'" class="code-block">
          <div class="code-toolbar">
            <span>{{ block.language || 'code' }}</span>
            <button type="button" :aria-label="`Copy ${block.language || ''} code`" @click="copyCode(block, index)">{{ copyStatus[index]?.text === block.text ? copyStatus[index].label : 'Copy' }}</button>
            <span class="sr-only" role="status">{{ copyStatus[index]?.text === block.text ? copyStatus[index].label : '' }}</span>
          </div>
          <pre><code><span v-for="(token, tokenIndex) in highlightMessageCode(block.text, block.language)" :key="tokenIndex" :class="`syntax-${token.type}`">{{ token.text }}</span></code></pre>
        </div>
        <component :is="`h${block.level}`" v-else-if="block.type === 'heading'"><InlineMarkdown :tokens="block.tokens" /></component>
        <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.type === 'list'" :start="block.ordered ? block.start : undefined" :class="{ 'skills-list': block.skills }">
          <li v-for="(item, itemIndex) in block.items" :key="itemIndex"><InlineMarkdown :tokens="item" /></li>
        </component>
        <p v-else><InlineMarkdown :tokens="block.tokens" /></p>
      </template>
    </div>
    <template v-for="(block, index) in markdownAnswer ? [] : content" :key="index">
      <div v-if="block.type === 'code'" class="code-block">
        <span class="code-language">{{ block.language || 'code' }}</span>
        <pre><code>{{ block.text }}</code></pre>
      </div>
      <p v-else class="message-text">{{ block.text }}</p>
    </template>
    <template v-if="message.role === 'assistant' && message.sources?.length">
      <div class="message-sources" aria-label="Portfolio sources">
        <template v-for="source in message.sources" :key="source.id">
          <a v-if="isExternal(source.href)" :href="source.href" target="_blank" rel="noopener noreferrer" class="source-link" :aria-label="`${source.label} (opens in a new tab)`">
            {{ source.label }}<ArrowUpRightIcon aria-hidden="true" />
          </a>
          <RouterLink v-else :to="source.href" class="source-link" @click="$emit('navigate')">
            {{ source.label }}<ArrowUpRightIcon aria-hidden="true" />
          </RouterLink>
        </template>
      </div>
      <p class="review-note">{{ message.verification === 'verified' ? 'Approved public facts · Within review period' : 'Verification unavailable' }}</p>
    </template>
    <p v-if="message.role === 'assistant' && message.mode === 'recruiter' && message.status === 'complete' && message.generalQuestion" class="review-note">For more technical or general questions, switch to General AI Mode.</p>
  </article>
</template>

<style scoped>
.chat-message { min-width: 0; max-width: 100%; overflow-wrap: anywhere; margin: 0 0 24px; font-size: 14px; line-height: 1.7; }
.chat-message--user { margin-left: 24px; padding: 10px 14px; background: var(--ask-soft); color: var(--ask-text); border-radius: 12px 12px 4px 12px; }
.message-byline { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; color: var(--ask-muted); font-size: 12px; font-weight: 600; }
.message-mark { height: 20px; width: 20px; color: var(--ask-accent-light); }
.message-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.markdown-content { min-width: 0; overflow-wrap: anywhere; }
.markdown-content p { margin: 0 0 10px; white-space: pre-wrap; }
.markdown-content :is(h3, h4, h5, h6) { margin: 16px 0 6px; color: var(--ask-text); font-size: 14px; line-height: 1.5; font-weight: 600; }
.markdown-content h3 { font-size: 15px; }
.markdown-content > :first-child { margin-top: 0; }
.markdown-content > :last-child { margin-bottom: 0; }
.markdown-content :is(ul, ol) { margin: 6px 0 12px; padding-left: 22px; }
.markdown-content ul { list-style: disc; }
.markdown-content ol { list-style: decimal; }
.markdown-content li { min-width: 0; padding-left: 2px; margin: 3px 0; }
.markdown-content .skills-list { display: flex; flex-wrap: wrap; column-gap: 24px; row-gap: 0; padding-left: 18px; }
.markdown-content :deep(strong) { color: var(--ask-text); font-weight: 600; }
.markdown-content :deep(a) { color: var(--ask-link); text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
.markdown-content :deep(a:focus-visible) { outline: 2px solid var(--ask-accent-light); outline-offset: 3px; border-radius: 2px; }
.markdown-content :deep(p code), .markdown-content :deep(li code) { padding: 1px 4px; border-radius: 4px; background: var(--ask-soft); font-size: .9em; font-family: ui-monospace, monospace; }
.code-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 12px; border-bottom: 1px solid var(--ask-border); color: var(--ask-muted); font-size: 11px; }
.code-toolbar > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.code-toolbar button { flex-shrink: 0; min-width: 76px; text-align: center; padding: 4px 6px; color: var(--ask-link); font: inherit; border: 0; border-radius: 4px; background: transparent; cursor: pointer; }
.code-toolbar button:focus-visible { outline: 2px solid var(--ask-accent-light); outline-offset: 2px; }
.syntax-keyword { color: var(--ask-link); font-weight: 600; }
.syntax-string { color: var(--ask-accent-light); }
.syntax-number { color: var(--ask-text); font-weight: 600; }
.syntax-comment { color: var(--ask-muted); font-style: italic; }
.code-block { margin: 12px 0; border: 1px solid var(--ask-border); border-radius: 8px; background: var(--ask-soft); overflow: hidden; }
.code-language { display: block; padding: 8px 12px; border-bottom: 1px solid var(--ask-border); color: var(--ask-muted); font-size: 11px; }
.code-block pre { margin: 0; padding: 12px; max-width: 100%; overflow-x: hidden; overscroll-behavior-x: contain; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.8; }
.code-block code { font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; }
.message-sources { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.source-link { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--ask-border); border-radius: 8px; padding: 4px 8px; font-size: 12px; color: var(--ask-link); text-decoration: none; transition: background .16s ease; }
.source-link:hover { background: var(--ask-soft); }
.source-link:focus-visible { outline: 2px solid var(--ask-accent-light); outline-offset: 3px; }
.source-link { max-width: 100%; overflow-wrap: anywhere; }
.source-link svg { flex-shrink: 0; height: 12px; width: 12px; flex-shrink: 0; }
.review-note { margin-top: 8px; color: var(--ask-muted); font-size: 11px; }
@media (max-width: 639px) {
  .chat-message { margin-bottom: 20px; }
  .chat-message--user { margin-left: 16px; }
  .code-block pre { padding: 10px; }
}
@media (prefers-reduced-motion: reduce) { .source-link { transition: none; } }
</style>
