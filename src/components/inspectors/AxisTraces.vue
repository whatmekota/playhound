<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from 'vue'
import { axisOutput, axisOutputAt } from '~/composables/useTCode'
import { traceSampleTime } from '~/lib/traceSample'
import { useDeviceStore } from '~/stores/deviceStore'

/**
 * A small live trace for every axis besides the stroke: what each one was
 * sent over the last few seconds, so linked, filled and scripted axes can be
 * seen moving with no device. A click opens one up, with its range and
 * where it is now.
 *
 * Axes switched on in the Device panel show, and any other one that is
 * being sent something.
 */

const WINDOW_MS = 4000
const ROW = 16
const ROW_OPEN = 56

const device = useDeviceStore()

/** Opened rows, kept while the panel comes and goes. */
const open = reactive(new Set<string>())

interface Trace { samples: { t: number, p: number }[], plottedAt: number | undefined }
const traces = new Map<string, Trace>()
/** Axes that were sent something lately, refreshed a few times a second. */
const busy = ref<string[]>([])

const channels = computed(() => {
  const list = device.orderedAxes.filter(a => a.channel !== 'L0' && (a.enabled || busy.value.includes(a.channel))).map(a => a.channel)
  for (const ch of busy.value) {
    if (ch !== 'L0' && !list.includes(ch))
      list.push(ch)
  }
  return list
})
const label = (ch: string) => device.axisConfigs[ch]?.label ?? ch
const now = ref<Record<string, number>>({})

const canvases = new Map<string, HTMLCanvasElement>()
function bind(ch: string, el: unknown) {
  if (el instanceof HTMLCanvasElement)
    canvases.set(ch, el)
  else
    canvases.delete(ch)
}

let colors = { accent: '#888', faint: '#444', grid: '#222' }
function readColors(el: HTMLElement) {
  const cs = getComputedStyle(el)
  colors = {
    accent: cs.getPropertyValue('--accent').trim() || colors.accent,
    faint: cs.getPropertyValue('--text-faint').trim() || colors.faint,
    grid: cs.getPropertyValue('--border').trim() || colors.grid,
  }
}

function position(ch: string) {
  return axisOutput[ch] ?? device.axisConfigs[ch]?.defaultPos ?? 0.5
}

function draw(ch: string, el: HTMLCanvasElement, t: number) {
  const trace = traces.get(ch)
  const dpr = window.devicePixelRatio || 1
  const w = el.clientWidth
  const h = el.clientHeight
  if (!w || !h)
    return
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
  }
  const ctx = el.getContext('2d')
  if (!ctx)
    return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const opened = open.has(ch)
  const inset = opened ? 5 : 2
  const y = (p: number) => inset + (1 - p) * (h - inset * 2)
  const x = (at: number) => w - ((t - at) / WINDOW_MS) * w

  const cfg = device.axisConfigs[ch]
  if (opened && cfg) {
    ctx.strokeStyle = colors.grid
    ctx.lineWidth = 1
    ctx.setLineDash([3, 4])
    for (const p of [cfg.min, cfg.max]) {
      ctx.beginPath()
      ctx.moveTo(0, Math.round(y(p)) + 0.5)
      ctx.lineTo(w, Math.round(y(p)) + 0.5)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }
  const s = trace?.samples ?? []
  if (s.length < 2)
    return
  ctx.beginPath()
  s.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.p)) : ctx.moveTo(x(p.t), y(p.p))))
  ctx.strokeStyle = colors.accent
  ctx.globalAlpha = opened ? 1 : 0.8
  ctx.lineWidth = opened ? 1.5 : 1.25
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.globalAlpha = 1
}

let raf: number | null = null
let frameNo = 0
function frame(t: number) {
  raf = requestAnimationFrame(frame)
  const recent: string[] = []
  for (const ch of new Set([...channels.value, ...Object.keys(axisOutputAt)])) {
    const at = axisOutputAt[ch]
    if (at !== undefined && t - at < WINDOW_MS)
      recent.push(ch)
    let trace = traces.get(ch)
    if (!trace) {
      trace = { samples: [], plottedAt: undefined }
      traces.set(ch, trace)
    }
    const st = traceSampleTime(axisOutput[ch] === undefined ? undefined : at, trace.plottedAt, t)
    if (st !== null) {
      trace.plottedAt = at
      trace.samples.push({ t: Math.max(st, trace.samples.at(-1)?.t ?? st), p: position(ch) })
    }
    while (trace.samples.length && t - trace.samples[0].t > WINDOW_MS)
      trace.samples.shift()
  }
  if (frameNo++ % 15 === 0) {
    const first = canvases.values().next().value
    if (first)
      readColors(first)
    recent.sort()
    if (recent.join() !== busy.value.join())
      busy.value = recent
    now.value = Object.fromEntries(channels.value.map(ch => [ch, position(ch)]))
  }
  for (const [ch, el] of canvases)
    draw(ch, el, t)
}

function start() {
  if (raf === null)
    raf = requestAnimationFrame(frame)
}
function stop() {
  if (raf !== null)
    cancelAnimationFrame(raf)
  raf = null
}
onMounted(start)
onActivated(start)
onDeactivated(stop)
onBeforeUnmount(stop)

function toggle(ch: string) {
  if (open.has(ch))
    open.delete(ch)
  else
    open.add(ch)
}
</script>

<template>
  <div v-if="channels.length" class="px-1.5 pb-1.5 pt-1 border-t border-edge flex flex-col gap-px">
    <button
      v-for="ch in channels"
      :key="ch"
      type="button"
      class="px-1 py-0.5 text-left focusable rounded-[var(--radius-sm)] flex gap-2 transition-colors items-center hover:bg-fg/5"
      :aria-expanded="open.has(ch)"
      :aria-label="`${label(ch)} trace`"
      @click="toggle(ch)"
    >
      <span class="flex shrink-0 flex-col w-14" :class="open.has(ch) ? 'self-start pt-0.5' : ''">
        <span class="text-[11px] text-fg-muted font-medium truncate">{{ label(ch) }}</span>
        <span v-if="open.has(ch)" class="text-[10px] text-fg-faint font-mono">{{ ch }} · {{ Math.round((now[ch] ?? 0) * 100) }}%</span>
      </span>
      <canvas
        :ref="el => bind(ch, el)"
        class="flex-1 min-w-0 block transition-[height]"
        :style="{ height: `${open.has(ch) ? ROW_OPEN : ROW}px` }"
        aria-hidden="true"
      />
    </button>
  </div>
</template>
