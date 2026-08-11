<template>
    <div :class="['flex flex-col lg:grid lg:grid-cols-2 lg:gap-x-4 transition-opacity motion-reduce:transition-none duration-500', showProject ? 'opacity-1' : 'opacity-0']">
        <div v-if="!project.alignLeft" class="order-first pb-4 lg:pb-0 lg:order-none lg:block">
            <div v-if="project.imageLinks">
                <div v-for="(img, idx) in project.imageLinks" :key="idx" class="mb-4 last:mb-0">
                    <div class="relative">
                        <div class="absolute -inset-2 rounded-xl -z-10 blur-3xl opacity-30 bg-gradient-to-br from-pink-300 via-purple-300 to-indigo-300 dark:from-pink-900 dark:via-purple-900 dark:to-indigo-900"></div>
                        <div class="relative bg-gradient-to-br from-white/60 via-slate-50 to-white/30 dark:from-slate-800 dark:via-gray-900 dark:to-black rounded-xl overflow-hidden shadow-lg border border-gray-200 dark:border-gray-700 transition-transform transition-shadow duration-300 ease-out transform hover:scale-[1.02] hover:shadow-2xl focus:shadow-2xl">
                            <img
                                @load="handleImageLoad"
                                :src="getImageUrl(img)"
                                class="block w-full h-auto object-contain"
                                loading="lazy"
                            />
                        </div>
                    </div>
                </div>
            </div>
            <div v-else>
                <div class="relative">
                    <div class="absolute -inset-2 rounded-xl -z-10 blur-3xl opacity-30 bg-gradient-to-br from-pink-300 via-purple-300 to-indigo-300 dark:from-pink-900 dark:via-purple-900 dark:to-indigo-900"></div>
                    <div class="relative bg-gradient-to-br from-white/60 via-slate-50 to-white/30 dark:from-slate-800 dark:via-gray-900 dark:to-black rounded-xl overflow-hidden shadow-lg border border-gray-200 dark:border-gray-700 transition-transform transition-shadow duration-300 ease-out transform hover:scale-[1.02] hover:shadow-2xl focus:shadow-2xl">
                        <img
                            @load="handleImageLoad"
                            :src="getImageUrl(project.imageLink)"
                            class="block w-full h-auto object-contain"
                            loading="lazy"
                        />
                    </div>
                </div>
            </div>
        </div>
        <div class="flex flex-col space-y-4" :class="project.alignLeft ? 'text-left' : 'lg:text-right'">
            <p>{{ project.yearCompleted }}</p>
            <h3 class="text-xl font-extrabold pb-2">{{ project.projectName }}</h3>
            <p class="text-slate-500 dark:text-slate-300">{{ project.description }}</p>
            <p class="text-slate-600">{{ project.techStack }}</p>
            <div class="flex space-x-6 items-center text-slate-400" :class="!project.alignLeft ? 'lg:justify-end' : ''">
                <a v-for="link in project.links" :href="link.url" class="flex items-center space-x-2 hover:text-link-color focus:text-link-color active:text-link-color" target="_blank">
                    <span v-if="link.type == 'git'" class="flex items-center space-x-2">
                        <font-awesome-icon icon="fa-brands fa-github" class="h-7 w-7"></font-awesome-icon>
                        <span>{{ link.label }}</span>
                    </span>
                    <span v-else-if="link.type == 'external'" class="flex items-center space-x-2">
                        <ArrowTopRightOnSquareIcon class="h-7 w-7"/>
                        <span>{{ link.label }}</span>
                    </span>
                    <span v-else class="flex items-center space-x-2">
                        <LinkIcon class="h-6 w-6"/>
                        <span>{{ link.label }}</span>
                    </span>
                </a>
            </div>
        </div>
        <div v-if="project.alignLeft" class="order-first pb-4 lg:pb-0 lg:order-none lg:block">
            <div v-if="project.imageLinks">
                <div v-for="(img, idx) in project.imageLinks" :key="idx" class="mb-4 last:mb-0">
                    <div class="relative">
                        <div class="absolute -inset-2 rounded-xl -z-10 blur-3xl opacity-30 bg-gradient-to-br from-pink-300 via-purple-300 to-indigo-300 dark:from-pink-900 dark:via-purple-900 dark:to-indigo-900"></div>
                        <div class="relative bg-gradient-to-br from-white/60 via-slate-50 to-white/30 dark:from-slate-800 dark:via-gray-900 dark:to-black rounded-xl overflow-hidden shadow-lg border border-gray-200 dark:border-gray-700 transition-transform transition-shadow duration-300 ease-out transform hover:scale-[1.02] hover:shadow-2xl focus:shadow-2xl">
                            <img
                                @load="handleImageLoad"
                                :src="getImageUrl(img)"
                                class="block w-full h-auto object-contain"
                                loading="lazy"
                            />
                        </div>
                    </div>
                </div>
            </div>
            <div v-else>
                <div class="relative">
                    <div class="absolute -inset-2 rounded-xl -z-10 blur-3xl opacity-30 bg-gradient-to-br from-pink-300 via-purple-300 to-indigo-300 dark:from-pink-900 dark:via-purple-900 dark:to-indigo-900"></div>
                    <div class="relative bg-gradient-to-br from-white/60 via-slate-50 to-white/30 dark:from-slate-800 dark:via-gray-900 dark:to-black rounded-xl overflow-hidden shadow-lg border border-gray-200 dark:border-gray-700 transition-transform transition-shadow duration-300 ease-out transform hover:scale-[1.02] hover:shadow-2xl focus:shadow-2xl">
                        <img
                            @load="handleImageLoad"
                            :src="getImageUrl(project.imageLink)"
                            class="block w-full h-auto object-contain"
                            loading="lazy"
                        />
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
<script setup>
import {ref} from 'vue'
import { LinkIcon, ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/solid';

const props = defineProps({
    project: Object
})

// Static Images
const showProject = ref(false)

const handleImageLoad = () => {
    if (!showProject.value) showProject.value = true
}

let getImageUrl = (path) => {
    return new URL(`../assets/${path}`, import.meta.url).href
}

</script>