<template>
    <section class="min-h-[30vh] md:min-h-[70vh] w-full flex flex-col" ref="contactSection" id="contact-section">
        <div class="relative flex py-5 items-center" :class="[visible ? 'translate-y-0 opacity-1 blur-0' : 'translate-y-4 opacity-0 blur-sm', 'transition-all motion-reduce:transition-none duration-500']">
            <div class="flex-grow border-t border-black dark:border-white border-1"></div>
            <h1 class="text-3xl font-bold px-5">📭 Contact</h1>
            <div class="flex-grow border-t border-black dark:border-white border-1"></div>
        </div>
            <div :class="['flex flex-col mt-2 md:mt-4 mb-4 transition-all motion-reduce:transition-none duration-500 delay-300', visible ? 'translate-y-0 opacity-1 blur-0' : 'translate-y-4 opacity-0 blur-sm']">
            <div v-if="content.formEmbedLink">
                <iframe :src="content.formEmbedLink" frameborder="0" marginheight="0" marginwidth="0" class="mb-6 min-h-[40vh] w-full">Loading...</iframe>
            </div>
            <div v-else class="space-y-6 mx-auto">
                <h1 class="text-3xl font-extrabold text-center">Get in Touch</h1>
                <p v-for="msg in content.externalLink.note" class="text-slate-500 dark:text-slate-300">{{ msg }}<br/></p>
                <div class="flex flex-col sm:flex-row items-center justify-center space-y-4 sm:space-x-5">
                    <template v-if="content.externalLink.link.email">
                        <a
                            :href="emailHref"
                            @click="handleEmailClick"
                            class="email-button py-2 px-6 bg-transparent border border-button-color shadow-sm shadow-button-color text-button-color hover:text-white hover:bg-button-color duration-300 focus:bg-button-color focus:text-white active:bg-button-color active:text-white"
                            :class="{ 'is-unfolding': emailUnfolding }"
                            aria-label="Send an Email"
                            :aria-disabled="emailPending ? 'true' : undefined"
                            :aria-busy="emailPending"
                        >
                            <span :key="`email-label-${emailUnfoldRun}`" class="email-button-label">Send an Email</span>
                            <span v-if="emailUnfolding" :key="emailUnfoldRun" class="email-envelope" aria-hidden="true">
                                <svg class="envelope-back" viewBox="0 0 240 144" preserveAspectRatio="none"><rect x="1" y="1" width="238" height="142" rx="4"/></svg>
                                <span class="envelope-letter-track">
                                    <span class="envelope-letter" @animationend.self="launchEmail">
                                        <span class="letter-heading">LET’S CONNECT</span>
                                        <span class="letter-message">Great things begin with a conversation.</span>
                                        <svg class="letter-rule" viewBox="0 0 120 8"><path d="M1 4h118"/></svg>
                                    </span>
                                </span>
                                <svg class="envelope-front" viewBox="0 0 240 144" preserveAspectRatio="none">
                                    <path class="envelope-left" d="M1 1l119 83L1 143Z"/>
                                    <path class="envelope-right" d="M239 1 120 84l119 59Z"/>
                                    <path class="envelope-bottom" d="M1 143 94 68q26-16 52 0l93 75Z"/>
                                    <path class="envelope-seams" d="M1 1v142h238V1M1 143 94 68q26-16 52 0l93 75"/>
                                </svg>
                                <svg class="envelope-flap" viewBox="0 0 240 144" preserveAspectRatio="none"><path d="M1 1h238L128 81q-8 6-16 0Z"/></svg>
                            </span>
                        </a>
                        <p class="text-sm mt-4 sm:mt-0 text-slate-500 dark:text-slate-300">{{ content.externalLink.responseTimeMessage }}</p>
                    </template>
                    <template v-else>
                        <a :href="content.externalLink.link.other" target="_blank">
                            <button class="py-2 px-6 bg-transparent border border-button-color shadow-sm shadow-button-color text-button-color hover:text-white hover:bg-button-color focus:bg-button-color focus:text-white active:bg-button-color active:text-white duration-300">Reach Out</button>
                        </a>
                    </template>
                </div>
            </div>
        </div>
    </section>
</template>
<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { onIntersect } from '../composables/onIntersect';

const props = defineProps({
    content: Object,
    transitions: Object
})

const contactSection = ref({})
const visible = props.transitions.active && window.matchMedia('(prefers-reduced-motion: no-preference)').matches ? onIntersect(contactSection, !!props.transitions.showOnce, { threshold: props.transitions.thresholdOption }) : true

const emailAddress = props.content.externalLink.link.email
const emailHref = `mailto:${emailAddress}`
const emailUnfolding = ref(false)
const emailUnfoldRun = ref(0)
const emailPending = ref(false)
let emailLaunchTimer
let emailResetTimer
let emailNavigated = false

function resetEmailButton() {
    clearTimeout(emailLaunchTimer)
    clearTimeout(emailResetTimer)
    emailNavigated = false
    emailPending.value = false
    emailUnfolding.value = false
}

function resetEmailOnReturn() {
    if (emailNavigated && !document.hidden) resetEmailButton()
}

function launchEmail() {
    if (!emailPending.value || emailNavigated) return
    clearTimeout(emailLaunchTimer)
    emailNavigated = true
    // Also recover if the mail handler leaves the browser focused (or none opens).
    emailResetTimer = setTimeout(() => {
        if (!document.hidden && document.hasFocus()) resetEmailButton()
    }, 2000)
    // Use the existing mailto target without a delayed, potentially blocked popup.
    window.location.assign(emailHref)
}

const handleEmailClick = (event) => {
    event.preventDefault()
    if (emailPending.value) return
    emailPending.value = true
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        launchEmail()
        return
    }
    emailUnfoldRun.value++
    emailUnfolding.value = true
    // Animation completion launches mail immediately; the bounded fallback
    // also covers a cancelled animation or a motion-preference change.
    emailLaunchTimer = setTimeout(launchEmail, 700)
}

onMounted(() => {
    window.addEventListener('focus', resetEmailOnReturn)
    window.addEventListener('pageshow', resetEmailOnReturn)
    document.addEventListener('visibilitychange', resetEmailOnReturn)
})

onBeforeUnmount(() => {
    resetEmailButton()
    window.removeEventListener('focus', resetEmailOnReturn)
    window.removeEventListener('pageshow', resetEmailOnReturn)
    document.removeEventListener('visibilitychange', resetEmailOnReturn)
})

</script>

<style scoped>
.email-button {
    --email-accent: var(--portfolio-accent, #4305ba);
    --email-paper: #fdfbff;
    --email-paper-shade: #ede5fa;
    --email-pocket: #ddd0f2;
    --email-crease: #ab91d4;
    --email-ink: #3d2670;
    --email-muted: #67587f;
    position: relative;
    isolation: isolate;
    -webkit-tap-highlight-color: transparent;
}
:global(html.dark .email-button) {
    --email-paper: #29253e;
    --email-paper-shade: #211c35;
    --email-pocket: #191529;
    --email-crease: #82729f;
    --email-ink: #e8deff;
    --email-muted: #c0b3d7;
}
.email-button:focus-visible { outline: 2px solid var(--email-accent); outline-offset: 5px; }
.email-button.is-unfolding { z-index: 2; background: transparent; border-color: transparent; box-shadow: none; }
.email-button-label { display: inline-block; }
.is-unfolding .email-button-label { animation: email-label-rest 650ms both; }
.email-envelope {
    position: absolute;
    left: 50%; top: 50%;
    width: 220px; max-width: calc(100vw - 48px); height: 96px;
    transform: translate(-50%, -50%);
    perspective: 700px;
    pointer-events: none;
    color: var(--email-ink);
    animation: email-envelope-unfold 650ms cubic-bezier(.22, 1, .36, 1) both;
}
.email-envelope > svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.envelope-back { z-index: 0; fill: var(--email-pocket); stroke: var(--email-crease); stroke-width: 1; filter: drop-shadow(0 8px 12px #160b3024); }
.envelope-letter-track { position: absolute; inset: 0; z-index: 2; clip-path: inset(-180px 0 0); }
.envelope-letter {
    position: absolute; top: 12px; left: 10px; right: 10px;
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    height: 146px; padding: 14px 12px;
    border: 1px solid var(--email-paper-shade); border-radius: 3px 3px 0 0;
    background: var(--email-paper);
    box-shadow: 0 2px 8px #160b3014;
    text-align: center;
    transform-origin: bottom center;
    animation: email-letter-rise 650ms cubic-bezier(.22, 1, .36, 1) both;
}
.letter-heading { color: var(--email-ink); font-size: 12px; font-weight: 600; line-height: 1.4; letter-spacing: .08em; }
.letter-message { color: var(--email-muted); font-size: 10px; font-weight: 400; line-height: 1.6; }
.letter-rule { width: 80%; height: 8px; margin-top: 4px; stroke: var(--email-crease); stroke-width: 1; opacity: .45; }
.envelope-front { z-index: 3; }
.envelope-left { fill: var(--email-paper-shade); }
.envelope-right { fill: var(--email-paper); }
.envelope-bottom { fill: var(--email-paper); }
.envelope-seams { fill: none; stroke: var(--email-crease); stroke-width: .8; stroke-linejoin: round; }
.envelope-flap { z-index: 4; transform-origin: center top; animation: email-flap-fold 650ms cubic-bezier(.45, 0, .2, 1) both; }
.envelope-flap path { fill: var(--email-paper-shade); stroke: var(--email-crease); stroke-width: .8; stroke-linejoin: round; }
@keyframes email-label-rest {
    0%, 4% { opacity: 1; }
    8%, 100% { opacity: 0; }
}
@keyframes email-envelope-unfold {
    0% { width: 100%; height: 100%; opacity: 0; }
    8% { opacity: 1; }
    20%, 100% { width: 220px; height: 96px; opacity: 1; }
}
@keyframes email-flap-fold {
    0%, 15% { transform: rotateX(0); z-index: 4; filter: drop-shadow(0 1px 1px #160b301a); }
    30% { transform: rotateX(-90deg); z-index: 4; }
    31% { z-index: 1; }
    45%, 100% { transform: rotateX(-180deg); z-index: 1; filter: drop-shadow(0 -1px 1px #160b3014); }
}
@keyframes email-letter-rise {
    0%, 37% { transform: translateY(18px) rotateX(-5deg); }
    100% { transform: translateY(-100px) rotateX(0); }
}
@media (prefers-reduced-motion: reduce) {
    .email-envelope { display: none; }
    .is-unfolding .email-button-label { animation: none; }
    .email-button.is-unfolding { z-index: auto; border-color: var(--email-accent); box-shadow: 0 1px 2px var(--email-accent); }
    .email-button.is-unfolding:is(:hover, :focus, :active) { background: var(--email-accent); }
}
</style>
