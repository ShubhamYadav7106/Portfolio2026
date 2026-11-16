<script setup>
import { onBeforeUnmount, onMounted } from 'vue'
import { RouterView } from 'vue-router'

let portfolioRoot
const elementFor = node => node instanceof Element ? node : node?.parentElement
const allowsCopy = element => Boolean(element?.isContentEditable || element?.closest('input, textarea, select, .ask-shubham'))

function protectSelection(event) {
  if (!allowsCopy(elementFor(event.target))) event.preventDefault()
}

function protectImage(event) {
  const target = elementFor(event.target)
  if (!allowsCopy(target) && target?.closest('img')) event.preventDefault()
}

function protectCopy(event) {
  const target = elementFor(event.target)
  if (allowsCopy(target) || allowsCopy(document.activeElement)) return
  if (portfolioRoot?.contains(target)) {
    event.preventDefault()
    return
  }
  // Keyboard copying can target the body rather than the selected content.
  // Leave selections in the teleported assistant and editable controls alone.
  const selection = window.getSelection()
  for (let index = 0; portfolioRoot && index < (selection?.rangeCount || 0); index++) {
    if (selection.getRangeAt(index).intersectsNode(portfolioRoot)) {
      event.preventDefault()
      return
    }
  }
}

onMounted(() => {
  portfolioRoot = document.getElementById('app')
  portfolioRoot?.addEventListener('selectstart', protectSelection)
  portfolioRoot?.addEventListener('contextmenu', protectImage)
  portfolioRoot?.addEventListener('dragstart', protectImage)
  document.addEventListener('copy', protectCopy)
  document.addEventListener('cut', protectCopy)
})

onBeforeUnmount(() => {
  portfolioRoot?.removeEventListener('selectstart', protectSelection)
  portfolioRoot?.removeEventListener('contextmenu', protectImage)
  portfolioRoot?.removeEventListener('dragstart', protectImage)
  document.removeEventListener('copy', protectCopy)
  document.removeEventListener('cut', protectCopy)
})
</script>

<template>
  <RouterView />
</template>
