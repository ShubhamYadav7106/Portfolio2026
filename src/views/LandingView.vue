<template>
    <section class="min-h-[60vh] w-full flex justify-center mb-6 md:mb-10 lg:mb-20" id="landing-page">
        <div class="flex items-center space-x-0 space-y-7 md:space-y-0 md:space-x-7 flex-col md:flex-row m-auto">
           <img :class="['w-64 h-64 md:w-72 md:h-72 lg:w-96 lg:h-96 object-cover rounded-tl-[100px] rounded-tr-[30px] rounded-br-[100px] rounded-bl-[30px] shadow-md transition-all duration-700 ease-out hover:scale-[1.04] hover:-translate-y-3 hover:rotate-2 hover:rounded-tl-[30px] hover:rounded-tr-[100px] hover:rounded-br-[30px] hover:rounded-bl-[100px] hover:shadow-[0_25px_60px_rgba(59,130,246,0.35)] motion-reduce:transition-none', showTransition ? 'translate-y-0 opacity-100' : '-translate-y-4 opacity-0']" :src="getImageUrl(content.portraitLink)" />
            <div class="flex flex-col space-y-2">
                <p :class="['text-lg lg:text-xl transition-all motion-reduce:transition-none duration-500 delay-[500ms]', showTransition ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">{{ content.intro }}</p>
                <h1 :class="['text-2xl lg:text-4xl font-bold transition-all motion-reduce:transition-none duration-500 delay-[550ms]', showTransition ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">{{ content.name }}</h1>
                <p :class="['text-sm lg:text-base text-slate-500 dark:text-slate-300 transition-all motion-reduce:transition-none duration-500 delay-[600ms]', showTransition ? 'translate-y-0 opacity-1' : '-translate-y-4 opacity-0']">{{ content.message }}</p>
            </div>
        </div>
    </section>
</template>
<script setup>
import { ref } from 'vue';

const props = defineProps({
    content: Object,
    showTransition: Boolean
})

// Static Images
const showIntro = ref(false)

let getImageUrl = (path) => {
  return new URL(`../assets/${path}`, import.meta.url).href
}
</script>