<script setup lang="ts">
import type { FaceMessage } from '~/lib/faceState'
import type { KerfusColor } from '~/lib/kerfus'
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { KERFUS as K, KERFUS_BLUSH, KERFUS_BOX, KERFUS_COLORS, kerfusPose } from '~/lib/kerfus'

/**
 * The Kerfus face, drawn from the same frames the CYD gets.
 *
 * The animation (blinks, a wandering gaze, the bob and the mouth riding the
 * stroke rate) is the firmware's faceTick() in miniature, so the screen face
 * and the board behave alike side by side.
 */
const props = withDefaults(defineProps<{
  msg: FaceMessage | null
  edging?: boolean
  color?: KerfusColor
  /** Draw it as a dot-matrix screen. Off for small previews, where it only shimmers. */
  led?: boolean
  /** Glow around the lines. */
  glow?: boolean
}>(), { edging: false, color: 'blue', led: false, glow: true })

const id = useId()
const ink = computed(() => KERFUS_COLORS[props.color])

const intensity = computed(() => props.msg?.intensity ?? 0)
const pose = computed(() => kerfusPose({
  expr: props.msg?.expr ?? null,
  panicked: !!props.msg?.panic,
  edging: props.edging,
  intensity: intensity.value,
  hearts: 'never',
}))
/** Something is driving strokes, so the bob and the mouth have a rhythm to ride. */
const moving = computed(() => {
  const m = props.msg
  return !!m && !m.panic && (m.spm ?? 0) > 1 && (m.playing || m.src === 'motion' || m.src === 'session')
})

// ─── Animation ───────────────────────────────────────────────────────────────
const lid = ref(1)
const lookX = ref(0)
const lookY = ref(0)
const bob = ref(0)
const mouthOpen = ref(0)

let raf = 0
let last = 0
let nextBlinkAt = 0
let blinkUntil = 0
let nextLookAt = 0
let lookTX = 0
let lookTY = 0
let bobPhase = 0
let mouthPhase = 0

function approach(cur: number, target: number, rate: number, dt: number) {
  const d = target - cur
  const step = rate * dt
  return Math.abs(d) <= step ? target : cur + Math.sign(d) * step
}
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

function frame(t: number) {
  raf = requestAnimationFrame(frame)
  const dt = Math.min(0.1, (t - (last || t)) / 1000)
  last = t
  const p = pose.value
  const x = intensity.value
  const spm = props.msg?.spm ?? 0

  // Blinks: quicker as the stroke rate climbs, slow and heavy when sleepy.
  if (p.blinks && t > nextBlinkAt) {
    blinkUntil = t + 120
    nextBlinkAt = t + (moving.value ? 2600 - Math.min(spm, 140) * 12 - x * 700 : 4200) + rand(0, 1600)
  }
  lid.value = approach(lid.value, p.blinks && t < blinkUntil ? 0.08 : 1, 9, dt)

  // Gaze wanders, drifting up as intensity climbs; once strokes run it can ride them.
  if (t > nextLookAt) {
    lookTX = rand(-1, 1) * 0.7
    lookTY = rand(-1, 1) * 0.45 - x * 0.55
    nextLookAt = t + (moving.value ? 1500 : 2600) + rand(0, 2200)
  }
  const sp = props.msg?.strokePos
  const follow = p.followStroke && sp !== undefined && moving.value
  let ty = follow ? (0.5 - sp) * 2 : lookTY
  let tx = lookTX
  if (p.pupil < 1 || p.dim) {
    tx = 0
    ty = 0
  }
  ty = Math.max(-1, Math.min(1, ty))
  lookX.value = approach(lookX.value, tx, 2.2, dt)
  lookY.value = approach(lookY.value, ty, follow ? 9 : 2.2, dt)

  if (moving.value) {
    bobPhase += (spm / 60) * dt
    bob.value = Math.sin(bobPhase * Math.PI * 2) * 2
    // Slower than the stroke: a mouth flapping at 2Hz reads as chewing.
    mouthPhase = (mouthPhase + Math.min(0.9, (spm / 60) * 0.34) * dt) % 1
    mouthOpen.value = (0.5 - 0.5 * Math.cos(mouthPhase * Math.PI * 2)) * (0.35 + 0.65 * x)
  }
  else {
    bob.value = approach(bob.value, 0, 12, dt)
    mouthOpen.value = approach(mouthOpen.value, 0, 3, dt)
  }
}

onMounted(() => {
  raf = requestAnimationFrame(frame)
})
onBeforeUnmount(() => cancelAnimationFrame(raf))

// ─── Shapes ──────────────────────────────────────────────────────────────────
const eyes = [{ cx: K.eyeL, side: -1 }, { cx: K.eyeR, side: 1 }] as const

/** Which shape each eye wears; the wink is the right eye only. */
function eyeShape(side: -1 | 1) {
  const e = pose.value.eyes
  if (e === 'wink')
    return side === 1 ? 'chevron' : 'ring'
  if (e === 'squeeze')
    return 'chevron'
  return e
}

const pupil = computed(() => {
  const r = K.pupilR * pose.value.pupil
  const travel = K.eyeR0 - r - 3
  const dx = lookX.value * travel
  const dy = lookY.value * travel
  const n = Math.hypot(dx, dy)
  const k = n > travel ? travel / n : 1
  return { r, dx: dx * k, dy: dy * k }
})

/** `>` on the left eye and `<` on the right: both point at the nose. */
function chevron(cx: number, side: -1 | 1) {
  const w = 22
  const h = 20
  const tip = cx - side * w
  const back = cx + side * w
  return `M${back} ${K.eyeY - h} L${tip} ${K.eyeY} L${back} ${K.eyeY + h}`
}

/** A bar drooping toward the outer corner, and the tear hanging off it. */
function sadBar(cx: number, side: -1 | 1) {
  const inner = { x: cx - side * 38, y: K.eyeY - 8 }
  const outer = { x: cx + side * 38, y: K.eyeY + 4 }
  return { d: `M${inner.x} ${inner.y} L${outer.x} ${outer.y}`, tear: { x: outer.x - side * 2, y: outer.y + 11 } }
}

function heart(cx: number) {
  const y = K.eyeY - 4
  const s = 1.25
  return `M${cx} ${y + 26 * s} C${cx - 6 * s} ${y + 18 * s} ${cx - 30 * s} ${y + 6 * s} ${cx - 30 * s} ${y - 8 * s}`
    + ` C${cx - 30 * s} ${y - 20 * s} ${cx - 14 * s} ${y - 26 * s} ${cx} ${y - 12 * s}`
    + ` C${cx + 14 * s} ${y - 26 * s} ${cx + 30 * s} ${y - 20 * s} ${cx + 30 * s} ${y - 8 * s}`
    + ` C${cx + 30 * s} ${y + 6 * s} ${cx + 6 * s} ${y + 18 * s} ${cx} ${y + 26 * s} Z`
}

const mouthW = computed(() => {
  const g = K.mouthGap
  const r = K.mouthR
  const y = K.mouthY
  return pose.value.mouth === 'm'
    ? `M${160 - 2 * g} ${y + r} A${r} ${r} 0 0 1 160 ${y + r} A${r} ${r} 0 0 1 ${160 + 2 * g} ${y + r}`
    : `M${160 - 2 * g} ${y} A${r} ${r} 0 0 0 160 ${y} A${r} ${r} 0 0 0 ${160 + 2 * g} ${y}`
})
/** The open mouth: a tongue hanging under the cusp of the ω, growing with the stroke. */
const tongue = computed(() => {
  const o = mouthOpen.value
  const y = K.mouthY + 6
  return `M${160 - 9} ${y} Q160 ${y + 4 + 22 * o} ${160 + 9} ${y} Z`
})

const viewBox = `${KERFUS_BOX.x} ${KERFUS_BOX.y} ${KERFUS_BOX.w} ${KERFUS_BOX.h}`
</script>

<template>
  <svg :viewBox="viewBox" class="kerfus" :style="{ color: ink }" aria-hidden="true">
    <defs>
      <filter :id="`${id}-glow`" x="-20%" y="-30%" width="140%" height="160%">
        <feGaussianBlur stdDeviation="2.4" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <pattern :id="`${id}-dots`" width="2" height="2" patternUnits="userSpaceOnUse">
        <rect width="1.55" height="1.55" fill="white" />
      </pattern>
      <mask :id="`${id}-led`">
        <rect :x="KERFUS_BOX.x" :y="KERFUS_BOX.y" :width="KERFUS_BOX.w" :height="KERFUS_BOX.h" :fill="`url(#${id}-dots)`" />
      </mask>
      <clipPath v-for="e in eyes" :id="`${id}-lid${e.side}`" :key="e.side">
        <rect :x="e.cx - K.eyeR0 - 6" :y="K.eyeY - K.eyeR0 * K.lidCut" :width="2 * K.eyeR0 + 12" :height="2 * K.eyeR0" />
      </clipPath>
    </defs>

    <g :filter="glow ? `url(#${id}-glow)` : undefined" :mask="led ? `url(#${id}-led)` : undefined">
      <g class="body" :style="{ opacity: pose.dim ? 0.28 : 1 }">
        <!-- Brows and eyes bob together -->
        <g :transform="`translate(0 ${bob})`">
          <ellipse
            v-for="e in eyes"
            :key="`b${e.side}`"
            :cx="e.side < 0 ? K.browL : K.browR"
            :cy="K.browY + pose.browDy"
            :rx="K.browRx"
            :ry="K.browRy"
            fill="currentColor"
            :transform="`rotate(${-e.side * pose.browTilt} ${e.side < 0 ? K.browL : K.browR} ${K.browY + pose.browDy})`"
            class="brow"
          />

          <g v-for="e in eyes" :key="`e${e.side}`">
            <path
              v-if="(eyeShape(e.side) === 'ring' || eyeShape(e.side) === 'lid') && pose.blinks && lid < 0.3"
              :d="`M${e.cx - K.eyeR0 + 6} ${K.eyeY} L${e.cx + K.eyeR0 - 6} ${K.eyeY}`"
              stroke="currentColor"
              stroke-width="8"
              stroke-linecap="round"
            />
            <template v-else-if="eyeShape(e.side) === 'ring' || eyeShape(e.side) === 'lid'">
              <g
                :clip-path="eyeShape(e.side) === 'lid' ? `url(#${id}-lid${e.side})` : undefined"
                :transform="`translate(0 ${K.eyeY}) scale(1 ${Math.max(0.1, lid)}) translate(0 ${-K.eyeY})`"
              >
                <circle :cx="e.cx" :cy="K.eyeY" :r="K.eyeR0" fill="currentColor" />
                <circle :cx="e.cx + pupil.dx" :cy="K.eyeY + pupil.dy" :r="pupil.r" fill="#000" />
              </g>
              <path
                v-if="eyeShape(e.side) === 'lid'"
                :d="`M${e.cx - K.eyeR0 + 2} ${K.eyeY - K.eyeR0 * K.lidCut} L${e.cx + K.eyeR0 - 2} ${K.eyeY - K.eyeR0 * K.lidCut}`"
                stroke="currentColor"
                :stroke-width="K.lineT"
                stroke-linecap="round"
              />
            </template>
            <path
              v-else-if="eyeShape(e.side) === 'chevron'"
              :d="chevron(e.cx, e.side)"
              fill="none"
              stroke="currentColor"
              :stroke-width="K.lineT"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path v-else-if="eyeShape(e.side) === 'hearts'" :d="heart(e.cx)" :fill="KERFUS_BLUSH" />
            <template v-else-if="eyeShape(e.side) === 'sad'">
              <path :d="sadBar(e.cx, e.side).d" stroke="currentColor" :stroke-width="K.lineT + 3" stroke-linecap="round" />
              <circle :cx="sadBar(e.cx, e.side).tear.x" :cy="sadBar(e.cx, e.side).tear.y" r="7" fill="currentColor" />
            </template>
            <path
              v-else-if="eyeShape(e.side) === 'sleep'"
              :d="`M${e.cx - 32} ${K.eyeY + 2} Q${e.cx} ${K.eyeY + 16} ${e.cx + 32} ${K.eyeY + 2}`"
              fill="none"
              stroke="currentColor"
              stroke-width="8"
              stroke-linecap="round"
            />
            <path v-else :d="`M${e.cx - 28} ${K.eyeY + 4} L${e.cx + 28} ${K.eyeY + 4}`" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
          </g>
        </g>

        <!-- Nose, mouth, whiskers -->
        <ellipse cx="160" :cy="K.noseY" :rx="K.noseRx" :ry="K.noseRy" fill="currentColor" />
        <template v-if="pose.mouth === 'w' || pose.mouth === 'm'">
          <path v-if="pose.mouth === 'w' && mouthOpen > 0.04" :d="tongue" fill="currentColor" />
          <path :d="mouthW" fill="none" stroke="currentColor" :stroke-width="K.mouthT" stroke-linecap="round" stroke-linejoin="round" />
        </template>
        <circle v-else-if="pose.mouth === 'o'" cx="160" :cy="K.mouthY + 10" r="8" fill="none" stroke="currentColor" stroke-width="5" />
        <path v-else :d="`M148 ${K.mouthY + 6} L172 ${K.mouthY + 6}`" stroke="currentColor" stroke-width="5" stroke-linecap="round" />

        <g v-for="side in [-1, 1]" :key="`w${side}`">
          <line
            v-for="(wy, i) in K.whiskerY"
            :key="i"
            :x1="(side < 0 ? K.whiskerX : 320 - K.whiskerX) - K.whiskerLen / 2"
            :x2="(side < 0 ? K.whiskerX : 320 - K.whiskerX) + K.whiskerLen / 2"
            :y1="wy"
            :y2="wy"
            stroke="currentColor"
            :stroke-width="K.whiskerT"
            stroke-linecap="round"
            :transform="`rotate(${(i === 0 ? 1 : -1) * -side * K.whiskerTilt} ${side < 0 ? K.whiskerX : 320 - K.whiskerX} ${wy})`"
          />
        </g>

        <g v-if="pose.blush" :stroke="KERFUS_BLUSH" stroke-width="3.5" stroke-linecap="round">
          <template v-for="e in eyes" :key="`bl${e.side}`">
            <line v-for="k in 3" :key="k" :x1="e.cx - 17 + (k - 1) * 12" :y1="K.eyeY + 54" :x2="e.cx - 11 + (k - 1) * 12" :y2="K.eyeY + 44" />
          </template>
        </g>

        <text v-if="pose.eyes === 'sleep'" x="286" y="52" class="zz" fill="currentColor">z</text>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.kerfus {
  display: block;
  overflow: visible;
}
.body {
  transition: opacity 0.3s ease;
}
.brow {
  transition:
    cy 0.25s ease,
    transform 0.25s ease;
}
.zz {
  font:
    700 16px ui-sans-serif,
    system-ui,
    sans-serif;
  animation: zz 3s ease-in-out infinite;
}
@keyframes zz {
  0%,
  100% {
    opacity: 0.25;
    transform: translateY(4px);
  }
  50% {
    opacity: 1;
    transform: translateY(-4px);
  }
}
</style>
