<script setup>
import { BriefcaseIcon, CodeBracketIcon } from '@heroicons/vue/24/outline'
defineProps({ modelValue: { type: String, required: true } })
defineEmits(['update:modelValue'])
</script>

<template>
  <fieldset class="mode-selector">
    <legend class="sr-only">Assistant mode</legend>
    <label class="mode-option">
      <input type="radio" name="assistant-mode" value="recruiter" :checked="modelValue === 'recruiter'" @change="$emit('update:modelValue', 'recruiter')" />
      <span><BriefcaseIcon aria-hidden="true" />Recruiter Mode</span>
    </label>
    <label class="mode-option">
      <input type="radio" name="assistant-mode" value="general" :checked="modelValue === 'general'" @change="$emit('update:modelValue', 'general')" />
      <span><CodeBracketIcon aria-hidden="true" />General AI Mode</span>
    </label>
  </fieldset>
</template>

<style scoped>
.mode-selector { display: flex; width: 100%; gap: 4px; margin: 16px 0 0; padding: 4px; border: 1px solid var(--ask-border); border-radius: 12px; background: var(--ask-soft); }
.mode-option { position: relative; flex: 1; min-width: 0; cursor: pointer; }
.mode-option input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.mode-option > span { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; border: 1px solid transparent; border-radius: 8px; color: var(--ask-muted); font-size: 12px; white-space: nowrap; transition: background .16s ease, color .16s ease; }
.mode-option svg { width: 16px; height: 16px; flex-shrink: 0; }
.mode-option input:checked + span { color: var(--ask-link); background: var(--ask-bg); border-color: var(--ask-border); font-weight: 600; }
.mode-option input:focus-visible + span { outline: 2px solid var(--ask-accent-light); outline-offset: 2px; }
@media (max-width: 639px) { .mode-selector { margin-top: 8px; } .mode-option > span { min-height: 36px; } }
@media (max-width: 359px) { .mode-option > span { font-size: 11px; gap: 4px; } }
@media (max-height: 500px) { .mode-selector { margin-top: 8px; } .mode-option > span { min-height: 32px; } }
@media (prefers-reduced-motion: reduce) { .mode-option > span { transition: none; } }
</style>
