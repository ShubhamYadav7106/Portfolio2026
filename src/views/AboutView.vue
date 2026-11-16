<template>
    <section class="min-h-[40vh] md:min-h-[60vh] w-full" ref="aboutSection" id="about-section">
        <div class="relative flex py-5 items-center" :class="[visible ? 'translate-y-0 opacity-1 blur-0' : 'translate-y-4 opacity-0 blur-sm', 'transition-all motion-reduce:transition-none duration-500']">
            <h1 class="text-3xl font-bold pr-5">😎 About Me</h1>
            <div class="flex-grow border-t border-black dark:border-white border-1"></div>
        </div>
        <div :class="['flex flex-col gap-y-4 lg:grid lg:grid-cols-2 lg:gap-x-5 lg:gap-y-0 mb-6 text-slate-500 dark:text-slate-300 transition-all motion-reduce:transition-none duration-500 delay-300', visible ? 'translate-y-0 opacity-1 blur-0' : 'translate-y-4 opacity-0 blur-sm']">
            <div class="order-2 lg:order-none">
                <div class="space-y-4">
                    <p v-for="paragraph in content.autobiography" class="m-0">{{ paragraph }}</p>
                </div>
                <div class="mt-1 mb-6 px-4">
    <p class="pb-4 font-semibold">Tech Stack...</p>

    <ul class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <li v-for="tech in content.techStack" class="min-w-0 break-words px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:scale-105 transition-all duration-300">
            ✅{{ tech }}
        </li>
    </ul>
</div>
            </div>
            <div class="grid w-full grid-cols-2 gap-4 order-1 lg:order-none self-start lg:self-center">
                <img :src="getImageUrl(content.photo1Link)" class="shadow-md w-full h-auto aspect-[3/4] object-contain bg-gray-100 dark:bg-gray-800" width="960" height="1280" loading="lazy"/>
                <img :src="getImageUrl(content.photo3Link)" class="shadow-md w-full h-auto aspect-[3/4] object-contain bg-gray-100 dark:bg-gray-800" width="1052" height="1488" loading="lazy"/>
                <img :src="getImageUrl(content.photo2Link)" class="col-span-2 shadow-md w-full h-auto object-contain" width="848" height="477" loading="lazy"/>
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
  return new URL(`../assets/images/${path.replace(/^images\//, '')}`, import.meta.url).href
}

</script>
