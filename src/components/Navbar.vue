<template>
    <nav class="block w-full sticky top-0 z-10 transition-all duration-300" :class="{ '-translate-y-full absolute': !showNavbar }" id="navbar">
        <!-- Navbar Body -->
        <div class="flex flex-wrap items-center justify-between px-9 md:py-4 bg-white/[.9] dark:bg-slate-900 backdrop-blur-sm transition-shadow duration-300" :class="{ 'shadow-lg dark:bg-slate-900/[.8]': !hideNavShadow }">
            <!-- Logo -->
            <router-link to="/#landing-page" class="signature-link" aria-label="Shubham Yadav — home" @pointerdown="redrawSignature" @focus="redrawSignature">
                <div :class="['transition-all motion-reduce:transition-none duration-500', showTransition ? 'opacity-1 blur-0' : 'opacity-0 blur-sm']">
                    <div v-if="!portfolio.greeting.logo.custom">
                        <img :src="getImageUrl(portfolio.greeting.logo.link)" class="scale-75 md:scale-100 origin-left drop-shadow-lg" id="logo-img"/>
                    </div>
                    <!-- Custom Logo -->
                    <div v-else class="drop-shadow-lg">
                        <div ref="signatureSurface" class="flex items-center space-x-2 py-4 md:py-1 bg-gradient-to-r from-[#fa3205] to-[#5301c5] bg-clip-text text-transparent">
                            <p>&lt;</p>
                            <p class="text-5xl md:text-7xl" id="custom-logo">S.Y.</p>
                            <p>/></p>
                        </div>
                        <svg class="signature-definitions" width="0" height="0" aria-hidden="true" focusable="false">
                            <defs><mask :id="signatureMaskId" ref="signatureMask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" style="mask-type: luminance"/></defs>
                        </svg>
                    </div>
                </div>
            </router-link>

            <button @click="dropDownActive = !dropDownActive" :class="['inline-flex items-center p-2 ml-3 text-sm text-gray-500 xl:hidden transition-all motion-reduce:transition-none duration-500', showTransition ? 'opacity-1 blur-0' : 'opacity-0 blur-sm']">
                <div v-if="!dropDownActive">
                    <Bars2Icon class="h-10 w-10 dark:fill-slate-300"/>
                </div>
                <div v-else>
                    <XMarkIcon class="h-10 w-10 dark:fill-slate-300"/>
                </div>
            </button>

            <div class="hidden w-full xl:block xl:w-auto items-center" id="navbar-default">
                <ul class="font-medium flex flex-col p-4 xl:p-0 mt-4 xl:flex-row xl:space-x-8 xl:mt-0">
                    <li :class="['transition-all motion-reduce:transition-none duration-500 delay-[50ms]', showTransition ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">
                        <router-link class="block py-2 pl-3 pr-4 hover:text-link-color" to="/#about-section">About</router-link>
                    </li>
                    <li :class="['transition-all motion-reduce:transition-none duration-500 delay-[100ms]', showTransition ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">
                        <router-link class="block py-2 pl-3 pr-4 hover:text-link-color" to="/#experience-section">Experience</router-link>
                    </li>
                    <li :class="['transition-all motion-reduce:transition-none duration-500 delay-[150ms]', showTransition ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">
                        <router-link class="block py-2 pl-3 pr-4 hover:text-link-color" to="/#work-section">Work</router-link>
                    </li>
                    <li :class="['transition-all motion-reduce:transition-none duration-500 delay-[200ms]', showTransition ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">
                        <router-link class="block py-2 pl-3 pr-4 hover:text-link-color" to="/#contact-section">Contact</router-link>
                    </li>
                    <li :class="['transition-all motion-reduce:transition-none duration-500 delay-[250ms]', showTransition ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">
                        <a :href="portfolio.greeting.resumeLink" target="_blank" rel="noopener noreferrer" class="resume-link">
                            <span class="resume-button block py-2 px-6 bg-transparent border border-button-color shadow-sm shadow-button-color text-button-color transition ease-in-out hover:bg-button-color hover:text-white hover:dark:text-slate-300 focus:bg-button-color focus:text-white active:bg-button-color active:text-white duration-300">
                                <svg class="resume-trace" aria-hidden="true"><rect width="100%" height="100%" pathLength="1"/></svg>
                                <span class="resume-sheet" aria-hidden="true"><svg viewBox="0 0 18 22"><path d="M3 1h8l4 4v16H3zM11 1v5h4M6 10h6M6 13h6M6 16h4"/></svg></span>
                                <span class="resume-label">Resume</span>
                            </span>
                        </a>
                    </li>
                    <li :class="['transition-all motion-reduce:transition-none duration-500 delay-[250ms]', showTransition ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">
                        <button class="theme-toggle block py-2" :class="{ 'is-dark': darkModeActive }" :aria-label="darkModeActive ? 'Switch to light theme' : 'Switch to dark theme'" :aria-pressed="darkModeActive" @click="$emit('toggle-dark', $event)">
                            <span class="theme-glyph"><SunIcon class="theme-sun h-7 w-7 text-slate-400" aria-hidden="true"/><MoonIcon class="theme-moon h-7 w-7 text-slate-300" aria-hidden="true"/></span>
                        </button>
                    </li>
                </ul>
            </div>
        </div>

        <!-- Navbar Dropdown Area -->
        <NavTransition>
            <div v-show="dropDownActive" class="block w-full absolute xl:hidden px-9 pb-4 bg-white/[.9] dark:bg-slate-900/[.8] backdrop-blur-sm">
                <ul>
                    <li>
                        <router-link class="block py-5  hover:text-link-color" to="/#about-section">😎 About</router-link>
                    </li>
                    <li>
                        <router-link class="block py-5  hover:text-link-color" to="/#experience-section">🛡️ Experience</router-link>
                    </li>
                    <li>
                        <router-link class="block py-5  hover:text-link-color" to="/#work-section">💻 Work</router-link>
                    </li>
                    <li>
                        <router-link class="block py-5  hover:text-link-color" to="/#contact-section">📭 Contact</router-link>
                    </li>
                    <li>
                        <a :href="portfolio.greeting.resumeLink" target="_blank" rel="noopener noreferrer" class="resume-link">
                            <span class="resume-button block w-full text-center bg-button-color py-2 px-6 mt-5 shadow-sm shadow-button-color focus:bg-button-color focus:text-white active:bg-button-color active:text-white text-white">
                                <svg class="resume-trace" aria-hidden="true"><rect width="100%" height="100%" pathLength="1"/></svg>
                                <span class="resume-sheet" aria-hidden="true"><svg viewBox="0 0 18 22"><path d="M3 1h8l4 4v16H3zM11 1v5h4M6 10h6M6 13h6M6 16h4"/></svg></span>
                                <span class="resume-label">Resume</span>
                            </span>
                        </a>
                    </li>
                    <li>
                        <div class="block w-full text-center py-2 mt-5">
                            <button class="theme-toggle block py-2" :class="{ 'is-dark': darkModeActive }" :aria-label="darkModeActive ? 'Switch to light theme' : 'Switch to dark theme'" :aria-pressed="darkModeActive" @click="$emit('toggle-dark', $event)">
                                <span class="theme-glyph"><SunIcon class="theme-sun h-7 w-7 text-slate-400" aria-hidden="true"/><MoonIcon class="theme-moon h-7 w-7 text-slate-300" aria-hidden="true"/></span>
                            </button>
                        </div>
                    </li>
                </ul>
            </div>
        </NavTransition>
    </nav>
</template>

<script setup>
import { Bars2Icon, XMarkIcon, MoonIcon, SunIcon } from '@heroicons/vue/24/solid'
import { ref, nextTick, watch, onMounted, onBeforeUnmount, useId } from 'vue';
import NavTransition from './transitions/NavTransition.vue';
import portfolio from '../portfolio'

const dropDownActive = ref(false)
const showNavbar = ref(true)
const prevScrollPosition = ref(0)

const hideNavShadow = ref(true)

const props = defineProps({
    showTransition: Boolean,
    mainVisible: Boolean,
    darkModeActive: Boolean
})
defineEmits(['toggle-dark'])

const signatureSurface = ref(null)
const signatureMask = ref(null)
const signatureMaskId = `signature-ink-${useId()}`
let signatureAnimations = []
let signatureRun = 0
let initialSignaturePlayed = false
const svgNamespace = 'http://www.w3.org/2000/svg'
// Pen trajectories reveal the existing glyphs; they never replace their outlines.
const signaturePen = {
    '<': [[[['M', .9, .06], ['L', .1, .5], ['L', .9, .94]], 150]],
    S: [[[['M', .78, .28], ['Q', .95, -.06, .67, .06], ['C', .18, .2, -.08, .43, .16, .5], ['S', 1.12, .54, .91, .76], ['S', .42, 1, .32, .94]], 360]],
    '.': [[[['M', .38, .65], ['L', .62, .35]], 65]],
    Y: [[[['M', .05, .19], ['Q', .5, .44, .95, .44]], 145], [[['M', .76, .02], ['Q', .56, .5, .8, .98]], 235]],
    '/': [[[['M', .9, .03], ['L', .1, .97]], 110]],
    '>': [[[['M', .1, .06], ['L', .9, .5], ['L', .1, .94]], 150]],
}

function resetSignature() {
    signatureRun++
    signatureAnimations.forEach(animation => animation.cancel())
    signatureAnimations = []
    signatureSurface.value?.style.removeProperty('mask-image')
    signatureSurface.value?.style.removeProperty('-webkit-mask-image')
}

function redrawSignature(event = {}) {
    if (event.type === 'pointerdown' && event.pointerType === 'mouse'
        || event.type === 'focus' && !event.currentTarget.matches(':focus-visible')) return
    const surface = signatureSurface.value
    const mask = signatureMask.value
    if (!surface || !mask || !surface.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return
    resetSignature()
    const run = signatureRun
    const bounds = surface.getBoundingClientRect()
    mask.setAttribute('width', bounds.width)
    mask.setAttribute('height', bounds.height)
    mask.replaceChildren()
    let delay = 70
    for (const element of surface.children) {
        const style = getComputedStyle(element)
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        context.fontKerning = style.fontKerning
        const text = element.textContent
        const metrics = context.measureText(text)
        const rect = element.getBoundingClientRect()
        const ascent = metrics.fontBoundingBoxAscent ?? parseFloat(style.fontSize) * .8
        const descent = metrics.fontBoundingBoxDescent ?? parseFloat(style.fontSize) * .2
        const baseline = rect.top - bounds.top + (rect.height - ascent - descent) / 2 + ascent
        for (let index = 0; index < text.length; index++) {
            const glyph = context.measureText(text[index])
            const left = rect.left - bounds.left + context.measureText(text.slice(0, index)).width - glyph.actualBoundingBoxLeft
            const width = glyph.actualBoundingBoxLeft + glyph.actualBoundingBoxRight
            const height = glyph.actualBoundingBoxAscent + glyph.actualBoundingBoxDescent
            const viewport = document.createElementNS(svgNamespace, 'svg')
            const attributes = { x: left - 1, y: baseline - glyph.actualBoundingBoxAscent - 1, width: width + 2, height: height + 2, overflow: 'hidden' }
            for (const [name, value] of Object.entries(attributes)) viewport.setAttribute(name, value)
            mask.append(viewport)
            for (const [trajectory, duration] of signaturePen[text[index]] || []) {
                const path = document.createElementNS(svgNamespace, 'path')
                const d = trajectory.map(([command, ...points]) => command + points.map((point, axis) => point * (axis % 2 ? height + 2 : width + 2)).join(' ')).join(' ')
                const attributes = { d, pathLength: 1, fill: 'none', stroke: 'white', 'stroke-width': Math.max(3, width * .45), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': 1, 'stroke-dashoffset': 1 }
                for (const [name, value] of Object.entries(attributes)) path.setAttribute(name, value)
                viewport.append(path)
                signatureAnimations.push(path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration, delay, easing: 'cubic-bezier(.4, .05, .3, 1)', fill: 'both' }))
                delay += duration
            }
        }
    }
    // Mask the whole original gradient surface, including both brackets.
    // There is no unmasked duplicate or colour/opacity animation underneath.
    surface.style.maskImage = `url("#${signatureMaskId}")`
    surface.style.webkitMaskImage = `url("#${signatureMaskId}")`
    void Promise.allSettled(signatureAnimations.map(animation => animation.finished)).then(() => {
        if (signatureRun === run) resetSignature()
    })
}

watch(() => props.mainVisible && props.showTransition, async visible => {
    if (!visible || initialSignaturePlayed) return
    initialSignaturePlayed = true
    await nextTick()
    await document.fonts.ready
    redrawSignature()
}, { immediate: true, flush: 'post' })

onMounted(() => {
    window.addEventListener('scroll', onScroll)
})

onBeforeUnmount(() => {
    resetSignature()
    window.removeEventListener('scroll', onScroll)
})

let onScroll = () => {
    const currScrollPosition = window.scrollY

    if (currScrollPosition <= 60) {
        hideNavShadow.value = true
    } else {
        hideNavShadow.value = false
    }

    if (currScrollPosition < 0 || Math.abs(currScrollPosition - prevScrollPosition.value) < 60) {
        return
    }

    showNavbar.value = currScrollPosition < prevScrollPosition.value
    prevScrollPosition.value = currScrollPosition
    dropDownActive.value = false
}

// Static Images
let getImageUrl = (path) => {
  return new URL(`../assets/images/${path.replace(/^images\//, '')}`, import.meta.url).href
}

</script>

<style scoped>
.signature-definitions { position: absolute; pointer-events: none; }
.signature-link:focus-visible { outline: 2px solid #5301c5; outline-offset: 5px; border-radius: 4px; }
.theme-toggle { border-radius: 50%; -webkit-tap-highlight-color: transparent; }
.theme-glyph { display: block; position: relative; width: 28px; height: 28px; }
.theme-glyph svg { position: absolute; inset: 0; transform-origin: center; transition: transform .58s cubic-bezier(.22, 1, .36, 1), opacity .35s ease, clip-path .5s ease, color .2s; }
.theme-sun { opacity: 1; transform: rotate(0) scale(1); clip-path: circle(75% at 50% 50%); }
.theme-moon { opacity: 0; transform: rotate(-70deg) scale(.45); clip-path: circle(0% at 70% 25%); }
.is-dark .theme-sun { opacity: 0; transform: rotate(100deg) scale(.45); clip-path: circle(0% at 25% 70%); }
.is-dark .theme-moon { opacity: 1; transform: rotate(0) scale(1); clip-path: circle(75% at 50% 50%); }
.theme-toggle:is(:hover, :focus-visible) svg { color: var(--portfolio-accent); }
.theme-toggle:focus-visible, .resume-link:focus-visible { outline: 2px solid var(--portfolio-accent); outline-offset: 5px; }
.resume-link { display: block; }
.resume-button { position: relative; isolation: isolate; }
.resume-trace { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.resume-trace rect { fill: none; stroke: currentColor; stroke-width: 1.5px; stroke-dasharray: 1; stroke-dashoffset: 1; opacity: 0; transition: stroke-dashoffset .7s cubic-bezier(.22, 1, .36, 1), opacity .2s; }
.resume-sheet { position: absolute; left: 10px; top: 50%; width: 14px; height: 18px; opacity: 0; transform: translate(-3px, -25%) rotate(-8deg); clip-path: inset(100% 0 0 0); transition: transform .45s cubic-bezier(.22, 1, .36, 1), opacity .2s, clip-path .45s; }
.resume-sheet svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.25; stroke-linecap: round; stroke-linejoin: round; }
.resume-label { display: inline-block; transition: transform .4s cubic-bezier(.22, 1, .36, 1); }
.resume-link:is(:hover, :focus-visible, :active) .resume-trace rect { stroke-dashoffset: 0; opacity: 1; }
.resume-link:is(:hover, :focus-visible, :active) .resume-sheet { opacity: 1; transform: translate(0, -50%) rotate(0); clip-path: inset(0); }
.resume-link:is(:hover, :focus-visible, :active) .resume-label { transform: translateX(5px); }
@media (hover: none) { .resume-sheet { opacity: 1; transform: translate(0, -50%); clip-path: none; } .resume-label { transform: translateX(5px); } }
@media (prefers-reduced-motion: reduce) {
  .theme-glyph svg, .resume-trace rect, .resume-sheet, .resume-label { transition: none; }
}
</style>
