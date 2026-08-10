<template>
    <section class="min-h-[40vh] md:min-h-[60vh] w-full" ref="aboutSection" id="about-section">
        <div class="relative flex py-5 items-center" :class="[visible ? 'translate-y-0 opacity-1 blur-0' : 'translate-y-4 opacity-0 blur-sm', 'transition-all motion-reduce:transition-none duration-500']">
            <h1 class="text-3xl font-bold pr-5">😎 About Me</h1>
            <div class="flex-grow border-t border-black dark:border-white border-1"></div>
        </div>
        <div :class="['flex flex-col gap-y-4 lg:grid lg:grid-cols-2 lg:gap-x-5 lg:gap-y-0 mb-6 text-slate-500 dark:text-slate-300 transition-all motion-reduce:transition-none duration-500 delay-300', visible ? 'translate-y-0 opacity-1 blur-0' : 'translate-y-4 opacity-0 blur-sm']">
            <div class="order-2 xl:order-none">
                <div class="space-y-4">
                    <p v-for="paragraph in content.autobiography" class="m-0">{{ paragraph }}</p>
                </div>
                <div class="mt-1 mb-6 px-4">
    <p class="pb-4 font-semibold">Most Recent Tech Stack...</p>

    <ul class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <li v-for="tech in content.techStack" class="px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:scale-105 transition-all duration-300">
            ✅{{ tech }}
        </li>
    </ul>
</div>
            </div>
            <div class="grid grid-rows-2 gap-y-4 lg:gap-y-3 order-1 lg:order-none self-start">
                <div class="grid grid-cols-2 gap-x-4">
                    <div>
                        <img :src="getImageUrl(content.photo1Link)" class="shadow-md w-full object-cover h-48 sm:h-56 md:h-64 lg:h-72" loading="lazy"/>
                    </div>
                    <div>
                        <img :src="getImageUrl(content.photo2Link)" class="shadow-md w-full object-cover h-48 sm:h-56 md:h-64 lg:h-72" loading="lazy"/>
                    </div>
                </div>
                <div>
                    <img :src="getImageUrl(content.photo3Link)" class="shadow-md w-full object-cover h-48 sm:h-56 md:h-64 lg:h-72" loading="lazy"/>
                </div>
            </div>
        </div>
    </section>
</template>
<script setup>
import { ref } from 'vue';
import { onIntersect } from '../composables/onIntersect'

const props = defineProps({
    content: Object,
    transitions: Object
})

const aboutSection = ref({})
const visible = props.transitions.active && window.matchMedia('(prefers-reduced-motion: no-preference)').matches ? onIntersect(aboutSection, !!props.transitions.showOnce, { threshold: props.transitions.thresholdOption }) : true

// Static Images
let getImageUrl = (path) => {
  return new URL(`../assets/${path}`, import.meta.url).href
}

</script>