<script setup lang="ts">
import type { Action } from '~/lib/funscriptAnalysis'
import type { PreviewStrip } from '~/lib/previews'
import type { HeatScale } from '~/lib/shareCard'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { frameAt, frameStyle } from '~/lib/previews'
import { formatDuration, rgbCss, strokeColumns } from '~/lib/shareCard'

/**
 * Where on the video the card's pictures come from: the script's heatmap
 * with a row of frames above it, and a pin per picture. Click or drag to
 * move the picked pin; a live frame follows the pointer. Arrow keys move a
 * focused pin by a second (ten with Shift).
 */
const props = defineProps<{
  durationSec: number
  actions: Action[]
  scale: HeatScale
  /** How many of `moments` are in use: 1 or 4. */
  count: number
  /** The library's scrub previews, when there are some. */
  strip: PreviewStrip | null
  /** Frames grabbed for the row when there is no strip: [seconds, image URL]. */
  thumbs: [number, string][]
  /** A small frame at `sec`, for the live preview; null when there is none. */
  peek: ((sec: number) => Promise<string | null>) | null
}>()

const emit = defineEmits<{ commit: [index: number] }>()
const moments = defineModel<number[]>('moments', { required: true })
const active = defineModel<number>('active', { default: 0 })

const track = ref<HTMLElement | null>(null)
const heat = ref<HTMLCanvasElement | null>(null)
const width = ref(0)

let ro: ResizeObserver | null = null
watch(track, (el) => {
  ro?.disconnect()
  if (!el)
    return
  ro = new ResizeObserver(() => (width.value = el.clientWidth))
  ro.observe(el)
  width.value = el.clientWidth
}, { immediate: true })
onBeforeUnmount(() => ro?.disconnect())

/** The heatmap row, one column per device pixel. */
function drawHeat() {
  const c = heat.value
  if (!c || !width.value)
    return
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(width.value * dpr)
  const h = Math.round(c.clientHeight * dpr)
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g)
    return
  g.clearRect(0, 0, w, h)
  const cols = strokeColumns(props.actions, w, props.durationSec * 1000)
  const pad = 2 * dpr
  const span = h - pad * 2
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i]
    if (col.speed === null)
      continue
    const top = pad + (1 - col.hi) * span
    const bot = pad + (1 - col.lo) * span
    if (col.speed < 2) {
      g.fillStyle = 'rgba(255,255,255,0.3)'
      g.fillRect(i, top - dpr / 2, 1, bot - top + dpr)
      continue
    }
    const rgb = props.scale.rgb(col.speed)
    g.fillStyle = rgbCss(rgb, 0.22 * Math.min(1, col.speed / 80))
    g.fillRect(i, top, 1, h - top)
    g.fillStyle = rgbCss(rgb)
    g.fillRect(i, top - dpr / 2, 1, bot - top + dpr)
  }
}
watch([() => props.actions, () => props.scale, () => props.durationSec, width, heat], drawHeat)

/** Tiles along the frame row: as many as fit at about 16:9. */
const tiles = computed(() => {
  const n = Math.max(4, Math.min(16, Math.round(width.value / 96)))
  const d = props.durationSec
  return Array.from({ length: n }, (_, i) => {
    const t = ((i + 0.5) / n) * d
    if (props.strip)
      return { t, style: frameStyle(props.strip, frameAt(props.strip, t)) }
    // The grabbed frame nearest this tile.
    let best: [number, string] | null = null
    for (const th of props.thumbs) {
      if (!best || Math.abs(th[0] - t) < Math.abs(best[0] - t))
        best = th
    }
    return { t, style: best ? { backgroundImage: `url("${best[1]}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : null }
  })
})

const pct = (sec: number) => `${(Math.max(0, Math.min(1, sec / (props.durationSec || 1))) * 100).toFixed(3)}%`

// ─── Picking ─────────────────────────────────────────────────────────────────

const dragging = ref(false)
/** The pin being dragged: the model's `active` only catches up on the next render. */
let dragIdx = 0
const hoverSec = ref<number | null>(null)
const peekUrl = ref<string | null>(null)
let peekAt = -1
let peekTimer: ReturnType<typeof setTimeout> | null = null

function secAt(clientX: number) {
  const el = track.value
  if (!el)
    return 0
  const r = el.getBoundingClientRect()
  const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  return Math.round(f * props.durationSec * 10) / 10
}

/** Ask for a live frame at `sec`, no more often than the grabber can keep up. */
function wantPeek(sec: number) {
  if (!props.peek)
    return
  if (peekTimer)
    clearTimeout(peekTimer)
  peekTimer = setTimeout(async () => {
    peekAt = sec
    const url = await props.peek?.(sec)
    if (url && peekAt === sec)
      peekUrl.value = url
  }, 60)
}

function setMoment(i: number, sec: number) {
  const next = [...moments.value]
  next[i] = Math.max(0, Math.min(props.durationSec, sec))
  moments.value = next
}

function onDown(e: PointerEvent) {
  if (e.button !== 0 || !props.durationSec)
    return
  const sec = secAt(e.clientX)
  // A pin close to the pointer is picked up; otherwise the picked pin jumps here.
  const el = track.value!
  const px = (s: number) => (s / props.durationSec) * el.clientWidth
  let near = -1
  let nearD = 12
  for (let i = 0; i < props.count; i++) {
    const d = Math.abs(px(moments.value[i]) - px(sec))
    if (d < nearD) {
      near = i
      nearD = d
    }
  }
  dragIdx = near >= 0 ? near : Math.min(active.value, props.count - 1)
  active.value = dragIdx
  setMoment(dragIdx, sec)
  dragging.value = true
  hoverSec.value = sec
  wantPeek(sec)
  el.setPointerCapture(e.pointerId)
}

function onMove(e: PointerEvent) {
  const sec = secAt(e.clientX)
  hoverSec.value = sec
  if (dragging.value)
    setMoment(dragIdx, sec)
  wantPeek(sec)
}

function onUp(e: PointerEvent) {
  if (!dragging.value)
    return
  dragging.value = false
  track.value?.releasePointerCapture(e.pointerId)
  emit('commit', dragIdx)
}

function onLeave() {
  if (!dragging.value) {
    hoverSec.value = null
    peekUrl.value = null
  }
}

function onKey(e: KeyboardEvent, i: number) {
  const step = e.shiftKey ? 10 : 1
  let d = 0
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown')
    d = -step
  else if (e.key === 'ArrowRight' || e.key === 'ArrowUp')
    d = step
  else
    return
  e.preventDefault()
  active.value = i
  setMoment(i, Math.round((moments.value[i] + d) * 10) / 10)
  emit('commit', i)
}

/** The live preview: the grabbed frame once it is in, the strip's meanwhile. */
const bubble = computed(() => {
  const s = hoverSec.value
  if (s === null)
    return null
  const style = peekUrl.value
    ? { backgroundImage: `url("${peekUrl.value}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : props.strip ? frameStyle(props.strip, frameAt(props.strip, s)) : null
  // Kept inside the track at its ends.
  const half = 92
  const x = (s / (props.durationSec || 1)) * width.value
  const left = `${Math.max(half, Math.min(width.value - half, x))}px`
  return { left, style, label: formatDuration(s * 1000) }
})
</script>

<template>
  <div class="card-timeline">
    <div
      ref="track"
      class="track"
      :class="{ dragging }"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @pointerleave="onLeave"
    >
      <div class="frames">
        <div v-for="(tile, i) in tiles" :key="i" class="tile" :style="tile.style ?? undefined" />
      </div>
      <canvas ref="heat" class="heat" aria-hidden="true" />

      <button
        v-for="i in count"
        :key="i"
        type="button"
        class="pin"
        :class="{ on: active === i - 1 }"
        :style="{ left: pct(moments[i - 1] ?? 0) }"
        role="slider"
        :aria-label="`Picture ${i}`"
        :aria-valuemin="0"
        :aria-valuemax="Math.round(durationSec)"
        :aria-valuenow="Math.round(moments[i - 1] ?? 0)"
        :aria-valuetext="formatDuration((moments[i - 1] ?? 0) * 1000)"
        @focus="active = i - 1"
        @keydown="onKey($event, i - 1)"
        @pointerdown.prevent
      >
        <span class="knob num">{{ count > 1 ? i : '' }}</span>
      </button>

      <div v-if="bubble" class="bubble" :style="{ left: bubble.left }">
        <div class="shot" :style="bubble.style ?? undefined" />
        <span class="num">{{ bubble.label }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card-timeline {
  padding-top: 4px;
}
.track {
  position: relative;
  cursor: pointer;
  touch-action: none;
  user-select: none;
  border-radius: var(--radius-md);
  background: var(--bg-base);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}
.track.dragging {
  cursor: grabbing;
}
.frames {
  display: flex;
  height: 48px;
  overflow: hidden;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
}
.tile {
  flex: 1 1 0;
  min-width: 0;
  background-color: var(--bg-800);
  border-right: 1px solid rgba(0, 0, 0, 0.4);
}
.heat {
  display: block;
  width: 100%;
  height: 34px;
  background: #0b0b0e;
  border-radius: 0 0 var(--radius-md) var(--radius-md);
}
.pin {
  position: absolute;
  top: -6px;
  bottom: -2px;
  width: 18px;
  margin-left: -9px;
  padding: 0;
  border: 0;
  background: none;
  cursor: grab;
  outline: none;
}
.pin::before {
  content: '';
  position: absolute;
  left: 8px;
  top: 10px;
  bottom: 0;
  width: 2px;
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
}
.knob {
  position: absolute;
  left: 0;
  top: 0;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  font-size: 10.5px;
  font-weight: 700;
  color: #fff;
  background: var(--bg-600);
  box-shadow:
    0 0 0 2px rgba(255, 255, 255, 0.85),
    0 2px 6px rgba(0, 0, 0, 0.5);
}
.pin.on::before {
  background: var(--accent-light);
}
.pin.on .knob {
  background: var(--accent);
}
.pin:focus-visible .knob {
  box-shadow:
    0 0 0 2px #fff,
    0 0 0 4px var(--accent);
}
.bubble {
  position: absolute;
  bottom: calc(100% + 10px);
  transform: translateX(-50%);
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius-md);
  background: var(--glass);
  box-shadow:
    0 0 0 1px var(--border-strong),
    0 8px 24px hsl(var(--shadow-color) / 0.4);
  font-size: 11px;
  color: var(--text);
  z-index: 2;
}
.shot {
  width: 176px;
  height: 99px;
  border-radius: calc(var(--radius-md) - 2px);
  background-color: var(--bg-800);
}
</style>
