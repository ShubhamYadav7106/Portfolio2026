<template>
	<Transition name="neural-reveal"><SplashView v-if="showingSplash"/></Transition>

	<div v-show="!showingSplash" class="min-h-screen overscroll-contain bg-white dark:bg-slate-900 dark:text-slate-300 text-base md:text-xl" :style="{ '--portfolio-accent': portfolio.colors.buttonColor }">
		<Navbar :show-transition="showLanding" :dark-mode-active="darkModeActive" @toggle-dark="toggleDark"/>

		<div class="min-h-full mx-10">
			<div class="flex flex-col md:grid md:grid-cols-6 min-h-full">
				<div class="col-span-1 flex-initial relative mx-auto md:mx-0 order-2 md:order-none">
					<ul class="md:fixed md:bottom-0 mb-3 flex items-center space-x-8 md:flex-col md:space-y-4 md:space-x-0">
						<li v-show="githubLink" :class="['transition-all motion-reduce:transition-none duration-500', showLanding ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">
							<a :href="githubLink" target="_blank" rel="noopener noreferrer" class="social-link social-github text-black dark:text-slate-300" aria-label="Shubham on GitHub">
								<font-awesome-icon icon="fa-brands fa-github" class="social-icon h-8 w-8 md:h-12 md:w-12"></font-awesome-icon>
								<span class="social-reveal" aria-hidden="true">
									<svg class="git-branch" viewBox="0 0 32 28"><path pathLength="1" d="M7 22V6M7 18c0-9 18-1 18-12"/><circle cx="7" cy="5" r="2.5"/><circle cx="7" cy="23" r="2.5"/><circle cx="25" cy="5" r="2.5"/></svg>
									<span>GitHub</span>
								</span>
							</a>
						</li>
						<li v-show="linkedinLink" :class="['transition-all motion-reduce:transition-none duration-500 delay-[100ms]', showLanding ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">
							<a :href="linkedinLink" target="_blank" rel="noopener noreferrer" class="social-link social-linkedin text-black dark:text-slate-300" aria-label="Shubham on LinkedIn">
									<font-awesome-icon icon="fa-brands fa-linkedin" class="social-icon h-8 w-8 md:h-12 md:w-12"></font-awesome-icon>
									<span class="social-reveal linkedin-reveal" aria-hidden="true"><span>LinkedIn</span><span class="social-arrow">↗</span></span>
							</a>
						</li>
						<li v-show="mediumLink" :class="['transition-all motion-reduce:transition-none duration-500 delay-[150ms]', showLanding ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">
							<a :href="mediumLink" target="_blank">
								<font-awesome-icon icon="fa-brands fa-medium" class="h-8 w-8 md:h-12 md:w-12 text-black transition ease-out hover:-translate-y-1 motion-reduce:hover:translate-y-0 duration-300 dark:text-slate-300"></font-awesome-icon>
							</a>
						</li>
						<li v-show="stackoverflowLink" :class="['transition-all motion-reduce:transition-none duration-500 delay-[200ms]', showLanding ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">
							<a :href="stackoverflowLink" target="_blank">
								<font-awesome-icon icon="fa-brands fa-stack-overflow" class="h-8 w-8 md:h-12 md:w-12 text-black transition ease-out hover:-translate-y-1 motion-reduce:hover:translate-y-0 duration-300 dark:text-slate-300"></font-awesome-icon>
							</a>
						</li>
						<li v-show="xTwitterLink" :class="['transition-all motion-reduce:transition-none duration-500 delay-[200ms]', showLanding ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">
							<a :href="xTwitterLink" target="_blank">
								<font-awesome-icon icon="fa-brands fa-x-twitter" class="h-8 w-8 md:h-12 md:w-12 text-black transition ease-out hover:-translate-y-1 motion-reduce:hover:translate-y-0 duration-300 dark:text-slate-300"></font-awesome-icon>
							</a>
						</li>
					</ul>
				</div>
				<div class="col-span-4 flex-1 flex-col order-1 md:order-none">
					<div class="container mx-auto max-w-full 2xl:max-w-6xl">
						<LandingView :content="portfolio.greeting" :show-transition="showLanding"/>

						<AboutView :content="portfolio.about" :transitions="portfolio.transitions" />

						<ExperienceView :content="portfolio.experiences" :transitions="portfolio.transitions" />

						<WorkView :content="portfolio.works" :transitions="portfolio.transitions" @open-assistant="openAssistant" />

						<ContactView :content="portfolio.contact" :transitions="portfolio.transitions" />

						
					</div>
				</div>
				<div class="hidden col-span-1 md:flex flex-initial relative order-2 text-center md:order-none">
					<p :class="['fixed bottom-2 right-10 origin-top-right rotate-90 transition-all motion-reduce:transition-none duration-500', showLanding ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">📍 Based in {{ portfolio.greeting.basedLocation }}</p>
				</div>
				
			</div>
		</div>
	</div>
	<AskShubhamWidget v-if="!showingSplash" ref="assistant" />
</template>

<script setup>
import { defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import Navbar from '../components/Navbar.vue'
import LandingView from './LandingView.vue'
import AboutView from './AboutView.vue'
import ExperienceView from './ExperienceView.vue'
import WorkView from './WorkView.vue'
import ContactView from './ContactView.vue'
import SplashView from './SplashView.vue'

import portfolio from '../portfolio'

const AskShubhamWidget = defineAsyncComponent(() => import('../components/assistant/AskShubhamWidget.vue'))

const router = useRouter()

const showingSplash = ref(portfolio.splashScreen)
const showLanding = ref(!(portfolio.transitions.active || portfolio.transitions.onlyLanding))
const darkModeActive = ref(false)
const assistant = ref(null)

const openAssistant = async () => {
	// Reuse the lazy-loaded widget even if its chunk is still arriving.
	await import('../components/assistant/AskShubhamWidget.vue')
	await nextTick()
	assistant.value?.open()
}

onMounted(() => {
	splashScreen()
	landingTransition()
	useDark()
})

// Social Media Links
const githubLink = portfolio.socialMediaLinks.github
const linkedinLink = portfolio.socialMediaLinks.linkedin
const mediumLink = portfolio.socialMediaLinks.medium
const stackoverflowLink = portfolio.socialMediaLinks.stackoverflow
const xTwitterLink = portfolio.socialMediaLinks.xtwitter;

const splashScreen = () => {
	if (portfolio.splashScreen) {
		setTimeout(() => {
			showingSplash.value = false
			router.push(window.location.hash)
		}, 1600)
	}
}

const landingTransition = () => {
	if (!showLanding.value && portfolio.splashScreen) {
		setTimeout(() => {
			showLanding.value = true
		}, 1600)
	} else if (!showLanding.value) {
		setTimeout(() => {
			showLanding.value = true
		}, 500)
	}
}

const useDark = () => {
	// credit: https://tailwindcss.com/docs/dark-mode#supporting-system-preference-and-manual-selection
	if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
		document.documentElement.classList.remove('bg-white')
		document.documentElement.classList.add('dark', 'bg-slate-900')
		darkModeActive.value = true
	} else {
		document.documentElement.classList.remove('dark', 'bg-slate-900')
		document.documentElement.classList.add('bg-white')
		darkModeActive.value = false
	}
}

let themeReveal
const toggleDark = async event => {
	if (themeReveal) return
	const nextTheme = darkModeActive.value ? 'light' : 'dark'
	const applyTheme = () => {
		localStorage.theme = nextTheme
		useDark()
	}
	if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
		applyTheme()
		return
	}
	const icon = event?.currentTarget?.querySelector('.theme-glyph') || event?.currentTarget
	const bounds = icon?.getBoundingClientRect()
	const x = bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2
	const y = bounds ? bounds.top + bounds.height / 2 : 0
	const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
	let applied = false
	document.documentElement.classList.add('theme-revealing')
	try {
		themeReveal = document.startViewTransition(async () => {
			applyTheme()
			applied = true
			await nextTick()
		})
		await themeReveal.ready
		await document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] }, {
			duration: 580, easing: 'cubic-bezier(.22, 1, .36, 1)', pseudoElement: '::view-transition-new(root)',
		}).finished
	} catch {
		// An interrupted/unsupported transition must still apply the preference once.
		if (!applied) { applyTheme(); applied = true }
	} finally {
		themeReveal?.skipTransition()
		themeReveal = undefined
		document.documentElement.classList.remove('theme-revealing')
	}
}

onBeforeUnmount(() => { themeReveal?.skipTransition(); document.documentElement.classList.remove('theme-revealing') })

</script>

<style scoped>
.social-link { position: relative; display: inline-flex; vertical-align: middle; border-radius: 5px; -webkit-tap-highlight-color: transparent; }
.social-link:focus-visible { outline: 2px solid var(--portfolio-accent); outline-offset: 6px; }
.social-icon { transition: transform .4s cubic-bezier(.22, 1, .36, 1); }
.social-reveal { position: absolute; left: calc(100% + 12px); top: 50%; display: flex; align-items: center; gap: 8px; padding: 7px 11px; border: 1px solid currentColor; border-radius: 6px; background: white; font-size: 12px; line-height: 1.4; white-space: nowrap; pointer-events: none; opacity: 0; transform: translate(-6px, -50%); clip-path: inset(0 100% 0 0); transition: opacity .18s ease, transform .38s cubic-bezier(.22, 1, .36, 1), clip-path .45s cubic-bezier(.22, 1, .36, 1); z-index: 12; }
:global(html.dark .social-reveal) {
  background-color: rgb(30 41 59);
  color: rgb(203 213 225);
  border-color: rgb(100 116 139);
}
.social-link:is(:hover, :focus-visible, :active) .social-reveal { opacity: 1; transform: translate(0, -50%); clip-path: inset(0); }
.social-link:is(:hover, :focus-visible, :active) .social-icon { transform: translateY(-2px); }
.git-branch { width: 26px; height: 24px; overflow: visible; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; }
.git-branch path { stroke-dasharray: 1; stroke-dashoffset: 1; transition: stroke-dashoffset .55s cubic-bezier(.22, 1, .36, 1) .05s; }
.git-branch circle { opacity: 0; transform: scale(.3); transform-box: fill-box; transform-origin: center; transition: opacity .2s .1s, transform .4s cubic-bezier(.22, 1, .36, 1) .1s; }
.git-branch circle:nth-of-type(2) { transition-delay: .18s; }
.git-branch circle:nth-of-type(3) { transition-delay: .27s; }
.social-github:is(:hover, :focus-visible, :active) .git-branch path { stroke-dashoffset: 0; }
.social-github:is(:hover, :focus-visible, :active) .git-branch circle { opacity: 1; transform: scale(1); }
.linkedin-reveal { overflow: hidden; }
.linkedin-reveal > span { transform: translateY(120%); transition: transform .4s cubic-bezier(.22, 1, .36, 1) .06s; }
.linkedin-reveal .social-arrow { transition-delay: .12s; }
.social-linkedin:is(:hover, :focus-visible, :active) .social-icon { transform: translate(2px, -2px) rotate(-3deg); }
.social-linkedin:is(:hover, :focus-visible, :active) .linkedin-reveal > span { transform: translateY(0); }
@media (max-width: 767px) {
  .social-reveal { left: 50%; top: auto; bottom: calc(100% + 12px); transform: translate(-50%, 5px); clip-path: inset(100% 0 0 0); }
  .social-link:is(:hover, :focus-visible, :active) .social-reveal { transform: translate(-50%, 0); }
}
@media (prefers-reduced-motion: reduce) {
  .social-icon, .social-reveal, .git-branch path, .git-branch circle, .linkedin-reveal > span { transition: none; }
  .social-link:is(:hover, :focus-visible, :active) .social-icon { transform: none; }
}
</style>
