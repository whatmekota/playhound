<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import { useBinauralBeats } from '~/composables/useBinauralBeats'
import { breathRadius, flashOpacity, parseWords, spiralAngle, wordIndex } from '~/lib/hypno'
import { useAudioStore } from '~/stores/audio'
import { useHypnoStore } from '~/stores/hypnoStore'

const props = defineProps<{
  /**
   * Small rendition inside a panel. Sizes that are absolute on the stage (the
   * word's font size) are scaled to the box, so the preview looks like a
   * shrunken stage rather than a giant word in a thumbnail.
   */
  preview?: boolean
}>()

/** Stage width the preview pretends to be. */
const PREVIEW_STAGE_PX = 1100

const hypno = useHypnoStore()
const audio = useAudioStore()
const { getPulseClock } = useBinauralBeats()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const currentWord = ref('')
const wordAlpha = ref(0)
/** Text scale; 1 on the stage, box-relative in preview. */
const fit = ref(1)

let raf: number | null = null
let ro: ResizeObserver | null = null

/** Turns the spiral has made. Accumulated so a rate change never snaps it. */
let turns = 0
/** Pulses seen, for stepping through the word list. */
let pulses = 0
let lastPhase = 0
let lastTs = 0
/** Stand-in pulse rate when the audio engine is not running. */
const FALLBACK_RATE_HZ = 0.8
let freePhase = 0

const wordList = computed(() => parseWords(hypno.words))

function resize() {
  const c = canvasEl.value
  if (!c)
    return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const r = c.getBoundingClientRect()
  c.width = Math.max(1, Math.round(r.width * dpr))
  c.height = Math.max(1, Math.round(r.height * dpr))
  fit.value = props.preview ? r.width / PREVIEW_STAGE_PX : 1
}

/**
 * Archimedean spiral arms.
 *
 * Stroked with a width that grows outward, which is what gives the illusion of
 * motion inward rather than just a rotating line.
 */
function drawSpiral(ctx: CanvasRenderingContext2D, w: number, h: number, angle: number) {
  const cx = w / 2
  const cy = h / 2
  const maxR = Math.hypot(w, h) / 2
  const arms = Math.max(1, Math.min(6, Math.round(hypno.spiralArms)))
  const TURNS = 3.2

  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(angle)
  ctx.globalAlpha = hypno.spiralOpacity
  ctx.lineCap = 'round'

  for (let a = 0; a < arms; a++) {
    // Two-tone alternates arms, which is what gives a classic spiral its
    // depth; a single colour just reads as stripes.
    ctx.strokeStyle = hypno.spiralTwoTone && a % 2
      ? hypno.spiralColor2
      : hypno.spiralColor
    const offset = (a / arms) * Math.PI * 2
    ctx.beginPath()
    const steps = 160
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const theta = t * TURNS * Math.PI * 2 + offset
      const r = t * maxR
      const x = Math.cos(theta) * r
      const y = Math.sin(theta) * r
      if (i === 0)
        ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    // Width grows outward so the arms appear to sweep inward.
    ctx.lineWidth = Math.max(2, maxR * 0.06)
    ctx.stroke()
  }
  ctx.restore()
}

function drawRing(ctx: CanvasRenderingContext2D, w: number, h: number, phase: number) {
  const cx = w / 2
  const cy = h / 2
  const maxR = Math.min(w, h) * 0.32
  const r = maxR * breathRadius(phase, audio.breathInhaleRatio.value)

  ctx.save()
  ctx.globalAlpha = hypno.ringOpacity
  ctx.strokeStyle = hypno.ringColor
  ctx.lineWidth = Math.max(1.5, maxR * 0.012)
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

function frame(ts: number) {
  const c = canvasEl.value
  const ctx = c?.getContext('2d')
  if (!c || !ctx) {
    raf = null
    return
  }

  const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0
  lastTs = ts

  // Follow the session pulse when there is one. With the audio engine off
  // there is no clock at all, and without a fallback the overlay would sit
  // frozen and never show a word — so keep a synthetic one ticking.
  const clock = getPulseClock()
  const rate = clock ? clock.rateHz : FALLBACK_RATE_HZ

  let phase: number
  if (clock) {
    phase = clock.phase
  }
  else {
    freePhase = (freePhase + rate * dt) % 1
    phase = freePhase
  }

  // Count a pulse each time the phase wraps.
  if (phase < lastPhase)
    pulses++
  lastPhase = phase

  turns += rate * hypno.spiralRate * dt * 8

  ctx.clearRect(0, 0, c.width, c.height)

  if (hypno.spiral)
    drawSpiral(ctx, c.width, c.height, spiralAngle(turns, hypno.spiralReverse ? -1 : 1))

  if (hypno.ring) {
    const breathPhase = (ts / 1000 / Math.max(2, audio.breathPeriod.value)) % 1
    drawRing(ctx, c.width, c.height, breathPhase)
  }

  // ── Text ────────────────────────────────────────────────────────────────
  if (hypno.text && wordList.value.length) {
    const idx = wordIndex(pulses, hypno.wordEvery, wordList.value.length)
    currentWord.value = wordList.value[idx] ?? ''
    const within = (pulses % Math.max(1, hypno.wordEvery)) / Math.max(1, hypno.wordEvery)
    wordAlpha.value = flashOpacity(within + phase / Math.max(1, hypno.wordEvery))
  }
  else {
    wordAlpha.value = 0
  }

  raf = requestAnimationFrame(frame)
}

onMounted(() => {
  resize()
  ro = new ResizeObserver(resize)
  if (canvasEl.value)
    ro.observe(canvasEl.value)
  raf = requestAnimationFrame(frame)
})

function stop() {
  if (raf !== null)
    cancelAnimationFrame(raf)
  raf = null
}

onUnmounted(() => {
  stop()
  ro?.disconnect()
})

// Inside a kept-alive panel the preview stays mounted while hidden; there is
// nothing to draw for, so let the frame loop rest.
onDeactivated(stop)
onActivated(() => {
  if (raf === null) {
    lastTs = 0
    raf = requestAnimationFrame(frame)
  }
})
</script>

<template>
  <!-- Never intercepts input: it sits over the video while everything
       underneath stays usable. -->
  <div class="pointer-events-none select-none animate-fade-in inset-0 absolute overflow-hidden">
    <canvas ref="canvasEl" class="h-full w-full inset-0 absolute" />

    <div
      v-if="hypno.vignette > 0"
      class="inset-0 absolute"
      :style="{
        background: `radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,${hypno.vignette}) 100%)`,
      }"
    />

    <div
      v-if="hypno.text && currentWord"
      class="flex items-center inset-0 justify-center absolute"
    >
      <span
        class="tracking-[0.2em] font-semibold uppercase"
        :style="{
          color: hypno.textColor,
          fontSize: `${hypno.textSize * fit}px`,
          opacity: wordAlpha * hypno.textOpacity,
          textShadow: `0 ${2 * fit}px ${24 * fit}px rgba(0,0,0,0.6)`,
        }"
      >{{ currentWord }}</span>
    </div>
  </div>
</template>
