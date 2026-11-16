<template>
    <div class="neural-splash" role="status" aria-label="Loading portfolio" aria-busy="true">
        <div class="neural-stage">
            <canvas ref="canvas" aria-hidden="true" />
            <div ref="logo" class="neural-logo" aria-hidden="true">
                <div v-if="portfolio.greeting.logo.custom" ref="signature" class="flex items-center space-x-2 py-4 md:py-1 drop-shadow-lg bg-gradient-to-r from-[#fa3205] to-[#5301c5] bg-clip-text text-transparent">
                    <p>&lt;</p>
                    <p class="neural-monogram text-5xl md:text-7xl">S.Y.</p>
                    <p>/></p>
                </div>
                <img v-else ref="signature" :src="imageLogo" class="scale-75 md:scale-100 origin-left drop-shadow-lg" alt="" @load="sampleLogo" />
            </div>
        </div>
    </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import portfolio from '../portfolio'

const canvas = ref(null)
const logo = ref(null)
const signature = ref(null)
const imageLogo = portfolio.greeting.logo.custom ? '' : new URL(`../assets/images/${portfolio.greeting.logo.link.replace(/^images\//, '')}`, import.meta.url).href
// The parent reveals the page after formation; its 200ms leave transition
// completes the full 1.8-second loading sequence.
const formationDuration = 1600
const points = []
const edges = []
let targets = []
let context, motion, frame, started, size, radius, disposed = false

const smooth = (from, to, value) => {
    const amount = Math.max(0, Math.min(1, (value - from) / (to - from)))
    return amount * amount * (3 - 2 * amount)
}

function sampleLogo() {
    if (!context || disposed || !signature.value) return
    const source = document.createElement('canvas')
    source.width = source.height = Math.ceil(size)
    const ink = source.getContext('2d', { willReadFrequently: true })
    if (!ink) return
    const stage = canvas.value.getBoundingClientRect()
    if (signature.value.tagName === 'IMG') {
        if (!signature.value.naturalWidth) return
        const rect = signature.value.getBoundingClientRect()
        ink.drawImage(signature.value, rect.left - stage.left, rect.top - stage.top, rect.width, rect.height)
    } else {
        ink.fillStyle = '#fff'
        for (const element of signature.value.children) {
            const style = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            ink.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
            ink.fontKerning = style.fontKerning
            const metrics = ink.measureText(element.textContent)
            const ascent = metrics.fontBoundingBoxAscent ?? parseFloat(style.fontSize) * .8
            const descent = metrics.fontBoundingBoxDescent ?? parseFloat(style.fontSize) * .2
            ink.fillText(element.textContent, rect.left - stage.left, rect.top - stage.top + (rect.height - ascent - descent) / 2 + ascent)
        }
    }
    const { data } = ink.getImageData(0, 0, source.width, source.height)
    const pixels = []
    for (let y = 0; y < source.height; y += 2) for (let x = 0; x < source.width; x += 2) {
        if (data[(y * source.width + x) * 4 + 3] > 120) pixels.push({ x, y })
    }
    if (pixels.length) targets = points.map((_, index) => pixels[Math.floor(index * pixels.length / points.length)])
}

function resize() {
    if (!context) return
    size = canvas.value.getBoundingClientRect().width
    if (!size) return
    radius = size * .32
    const density = Math.min(window.devicePixelRatio || 1, window.innerWidth < 640 ? 1.5 : 2)
    canvas.value.width = canvas.value.height = Math.round(size * density)
    context.setTransform(density, 0, 0, density, 0, 0)
    sampleLogo()
}

function render(now) {
    if (disposed || motion.matches) return
    const elapsed = Math.min(now - started, formationDuration)
    const progress = elapsed / formationDuration
    const seconds = elapsed / 1000
    const morph = smooth(.50, .87, progress)
    const ink = smooth(.79, .93, progress)
    const dark = document.documentElement.classList.contains('dark')
    const center = size / 2
    const turn = -.5 + seconds * .8
    const tilt = .24 + Math.sin(seconds * 1.3) * .12
    const cosY = Math.cos(turn), sinY = Math.sin(turn)
    const cosX = Math.cos(tilt), sinX = Math.sin(tilt)
    const projected = points.map((point, index) => {
        const wave = 1 + .045 * Math.sin(point.y * 5 + seconds * 2.2) * Math.cos(point.x * 3 - seconds * 1.5)
        const x = (point.x * cosY + point.z * sinY) * wave
        const rotatedZ = (point.z * cosY - point.x * sinY) * wave
        const y = point.y * cosX * wave - rotatedZ * sinX
        const z = point.y * sinX * wave + rotatedZ * cosX
        const perspective = 3.6 / (3.6 - z)
        const target = targets[index] || { x: center, y: center }
        return {
            x: (center + x * radius * perspective) * (1 - morph) + target.x * morph,
            y: (center - y * radius * perspective) * (1 - morph) + target.y * morph,
            depth: (z + 1.15) / 2.3,
        }
    })
    context.clearRect(0, 0, size, size)
    const gradient = context.createLinearGradient(size * .2, 0, size * .8, size)
    gradient.addColorStop(0, dark ? '#a78bfa' : '#fa3205')
    gradient.addColorStop(1, dark ? '#7c3aed' : '#5301c5')
    context.strokeStyle = context.fillStyle = gradient
    const connections = Math.pow(1 - morph, 1.8) * (1 - ink)
    for (const [first, second] of edges) {
        const a = projected[first], b = projected[second]
        const depth = (a.depth + b.depth) / 2
        context.globalAlpha = (.07 + depth * .35) * connections
        context.lineWidth = .35 + depth * .6
        context.beginPath()
        context.moveTo(a.x, a.y)
        context.lineTo(b.x, b.y)
        context.stroke()
    }
    for (const point of projected.sort((a, b) => a.depth - b.depth)) {
        context.globalAlpha = (.2 + point.depth * .8) * (1 - ink) * smooth(0, .09, progress)
        context.beginPath()
        context.arc(point.x, point.y, (.65 + point.depth * 1.65) * (1 - morph * .35), 0, Math.PI * 2)
        context.fill()
    }
    context.globalAlpha = 1
    logo.value.style.opacity = ink
    if (elapsed < formationDuration) frame = requestAnimationFrame(render)
}

function reduceMotion() {
    if (!motion.matches) return
    cancelAnimationFrame(frame)
    canvas.value.style.visibility = 'hidden'
    logo.value.style.opacity = 1
}

onMounted(() => {
    motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (motion.matches) { logo.value.style.opacity = 1; return }
    context = canvas.value.getContext('2d')
    if (!context) { logo.value.style.opacity = 1; return }
    const count = window.innerWidth < 640 ? 88 : 132
    for (let index = 0; index < count; index++) {
        const y = 1 - 2 * (index + .5) / count
        const ring = Math.sqrt(1 - y * y)
        const angle = index * Math.PI * (3 - Math.sqrt(5))
        points.push({ x: Math.cos(angle) * ring, y, z: Math.sin(angle) * ring })
    }
    // Topology is computed once, never searched again inside the frame loop.
    for (let first = 0; first < count; first++) for (let second = first + 1; second < count; second++) {
        const a = points[first], b = points[second]
        if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < .47) edges.push([first, second])
    }
    resize()
    started = performance.now()
    frame = requestAnimationFrame(render)
    window.addEventListener('resize', resize, { passive: true })
    motion.addEventListener('change', reduceMotion)
    // Reuse existing fonts without blocking or extending loading.
    document.fonts?.ready.then(() => { if (!disposed) sampleLogo() })
})

onBeforeUnmount(() => {
    disposed = true
    cancelAnimationFrame(frame)
    window.removeEventListener('resize', resize)
    motion?.removeEventListener('change', reduceMotion)
})
</script>

<style scoped>
.neural-splash {
    position: fixed; inset: 0; z-index: 50;
    display: grid; place-items: center; overflow: hidden;
    background: #fff; font-size: 16px;
}
:global(html.dark .neural-splash) { background: #0f172a; }
.neural-stage { position: relative; width: min(400px, calc(100vw - 40px), calc(100svh - 40px)); aspect-ratio: 1; }
.neural-stage canvas { display: block; width: 100%; height: 100%; }
.neural-logo { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); opacity: 0; }
.neural-monogram { font-family: 'Reenie Beanie', cursive; }
.neural-splash.neural-reveal-leave-active { transition: opacity 200ms ease-out; pointer-events: none; }
.neural-splash.neural-reveal-leave-to { opacity: 0; }
@media (min-width: 768px) { .neural-splash { font-size: 20px; } }
@media (prefers-reduced-motion: reduce) {
    .neural-stage canvas { display: none; }
    .neural-logo { opacity: 1; }
    .neural-splash.neural-reveal-leave-active { transition: none; }
}
</style>
