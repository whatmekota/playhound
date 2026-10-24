<script setup lang="ts">
import type { MenuItem } from '~/components/ui/menu'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiContextMenu from '~/components/ui/UiContextMenu.vue'
import { useLoopSection } from '~/composables/useLoopSection'
import { useScriptAnalysis } from '~/composables/useScriptAnalysis'
import { useSmoothPlayhead } from '~/composables/useSmoothPlayhead'
import { toast } from '~/composables/useToast'
import { sampleEnvelope } from '~/lib/funscriptAnalysis'
import { formatTime } from '~/lib/time'
import { useBookmarkStore } from '~/stores/bookmarkStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useStatsStore } from '~/stores/statsStore'

/**
 * The scrub bar, with the script drawn on it.
 *
 * Lanes, top to bottom: the script waveform, then (when `heatmap` is on) a
 * band coloured by stroke speed with the stroke-rate curve over it. On top of
 * those sit the A–B loop, bookmarks, finish markers and the playhead.
 *
 * `dock` draws in theme colours for the bottom dock; `overlay` draws white
 * for the fullscreen bar over video. It seeks through the playback store.
 */
const props = withDefaults(defineProps<{
  variant?: 'dock' | 'overlay'
  heatmap?: boolean
}>(), { variant: 'dock', heatmap: true })

const player = usePlayerStore()
const playback = usePlaybackStore()
const scriptStore = useScriptStore()
const bookmarkStore = useBookmarkStore()
const statsStore = useStatsStore()
const { analysis } = useScriptAnalysis()
const loop = useLoopSection()

const rootEl = ref<HTMLDivElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const size = ref({ w: 0, h: 0 })

const hovering = ref(false)
const hoverX = ref(0)
const drag = ref<'scrub' | 'loopStart' | 'loopEnd' | null>(null)
/** Where the playhead is drawn while scrubbing, ahead of the video catching up. */
let scrubTime: number | null = null
let playheadT = 0

const videoName = computed(() => player.videoPath?.split(/[\\/]/).pop() ?? null)
const bookmarks = computed(() => (videoName.value ? bookmarkStore.forVideo(videoName.value) : []))
const finishes = computed(() => (videoName.value ? statsStore.stats[videoName.value]?.finishEvents ?? [] : []))

/**
 * Fraction of the strip given over to the heatmap band at the bottom.
 *
 * The heatmap used to be painted across the whole height, which left the
 * script waveform fighting a saturated background for the same pixels. Giving
 * each its own lane means both stay readable.
 */
const HEAT_BAND = 0.26
/** How close (px) the pointer must be to grab a loop edge. */
const HANDLE_GRAB = 7

// ─── Colours ─────────────────────────────────────────────────────────────────
// Canvas cannot resolve CSS variables, so the theme is read once and again
// whenever the theme attribute changes.
interface Palette { accent: string, accentLight: string, ink: string, warn: string, danger: string }
const palette = ref<Palette>(readPalette())

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    accent: v('--accent', 'magenta'),
    accentLight: v('--accent-light', 'violet'),
    ink: props.variant === 'overlay' ? 'white' : v('--text', 'white'),
    warn: v('--warn', 'gold'),
    danger: v('--danger', 'crimson'),
  }
}

let themeObs: MutationObserver | null = null

// ─── Static layer ────────────────────────────────────────────────────────────

/** Speed heatmap, drawn as a band along the bottom edge. */
function drawHeatmap(ctx: CanvasRenderingContext2D, W: number, H: number, duration: number) {
  const a = analysis.value
  if (!a || !a.envelope.length)
    return

  const durMs = duration * 1000
  const bandTop = H * (1 - HEAT_BAND)
  const bandH = H - bandTop
  // Normalise against this script's own peak so quiet scripts still read,
  // with a floor so a nearly-static script is not amplified into noise.
  const ref = Math.max(0.5, a.peakSpeed)

  const step = 2
  for (let x = 0; x < W; x += step) {
    const s = sampleEnvelope(a.envelope, (x / W) * durMs)
    if (!s)
      continue
    const v = Math.min(1, s.speed / ref)
    if (v < 0.02)
      continue
    // A data ramp, not a theme colour: cool blue for slow, hot magenta for fast.
    const hue = 260 - v * 220
    ctx.fillStyle = `hsla(${hue},${60 + v * 40}%,${36 + v * 24}%,0.9)`
    ctx.fillRect(x, bandTop, step + 0.5, bandH)
  }

  // Stroke-rate curve inside the band.
  const maxSpm = Math.max(30, a.peakSpm)
  ctx.beginPath()
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'
  ctx.lineWidth = 1
  let started = false
  for (let x = 0; x <= W; x += 2) {
    const s = sampleEnvelope(a.envelope, (x / W) * durMs)
    if (!s)
      continue
    const y = H - (Math.min(1, s.spm / maxSpm) * (bandH - 2) + 1)
    if (started) {
      ctx.lineTo(x, y)
    }
    else {
      ctx.moveTo(x, y)
      started = true
    }
  }
  ctx.stroke()
}

/**
 * The script itself.
 *
 * Iterates every action, which is tens of thousands of points on a dense
 * script, so this belongs in the cached layer rather than in each frame.
 */
function drawWaveform(ctx: CanvasRenderingContext2D, W: number, waveH: number, duration: number) {
  const actions = scriptStore.primaryScript?.parsed.actions ?? []
  const p = palette.value
  const durMs = duration * 1000
  const pad = 2
  const h = waveH - pad * 2

  ctx.save()
  if (props.variant === 'overlay') {
    // Over video a dark halo keeps the line legible on bright frames.
    ctx.shadowColor = 'rgba(0,0,0,0.85)'
    ctx.shadowBlur = 2
  }
  ctx.beginPath()
  ctx.strokeStyle = p.accentLight
  ctx.globalAlpha = 0.9
  ctx.lineWidth = 1.25
  ctx.lineJoin = 'round'
  for (let i = 0; i < actions.length; i++) {
    const x = (actions[i].at / durMs) * W
    const y = pad + h - actions[i].pos * h
    if (i === 0)
      ctx.moveTo(x, y)
    else
      ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.restore()
}

// The heatmap, the envelope curve and the script depend only on the script and
// the canvas size, but the playhead moves every frame. Sampling the envelope
// and walking every action per frame made long scripts stutter, so they are
// rendered once and blitted after.
let staticLayer: HTMLCanvasElement | null = null
let staticKey = ''

const hasScript = computed(() => (scriptStore.primaryScript?.parsed.actions.length ?? 0) > 1)
const showBand = computed(() => props.heatmap && hasScript.value && !!analysis.value?.envelope.length)

function ensureStaticLayer(W: number, H: number, dpr: number, duration: number) {
  const a = analysis.value
  const s = scriptStore.primaryScript
  const key = [
    showBand.value ? 1 : 0,
    W,
    H,
    dpr,
    Math.round(duration * 10),
    a ? a.envelope.length : 0,
    a ? Math.round(a.peakSpeed * 1000) : 0,
    s?.filename ?? '',
    s?.channel ?? '',
    s?.parsed.actions.length ?? 0,
    s?.offsetMs ?? 0,
    palette.value.accentLight,
  ].join(':')

  if (staticLayer && staticKey === key)
    return staticLayer

  const c = staticLayer ?? document.createElement('canvas')
  c.width = Math.round(W * dpr)
  c.height = Math.round(H * dpr)
  const ctx = c.getContext('2d')
  if (!ctx)
    return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)

  if (hasScript.value) {
    if (showBand.value)
      drawHeatmap(ctx, W, H, duration)
    drawWaveform(ctx, W, showBand.value ? H * (1 - HEAT_BAND) - 1 : H, duration)
  }

  staticLayer = c
  staticKey = key
  return c
}

// ─── Per-frame ───────────────────────────────────────────────────────────────

function draw(t: number) {
  playheadT = t
  const canvas = canvasEl.value
  const { w: W, h: H } = size.value
  if (!canvas || !W || !H)
    return
  const ctx = canvas.getContext('2d')
  if (!ctx)
    return
  const dpr = window.devicePixelRatio || 1
  const p = palette.value
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)

  const duration = player.videoDuration
  const now = scrubTime ?? t
  const px = duration > 0 ? Math.max(0, Math.min(W, (now / duration) * W)) : 0
  const live = hovering.value || drag.value !== null

  // ── Track: the whole strip is a soft well; without a script it is a bar. ──
  ctx.fillStyle = p.ink
  ctx.globalAlpha = props.variant === 'overlay' ? 0.12 : 0.05
  ctx.fillRect(0, 0, W, H)
  ctx.globalAlpha = 1

  if (duration <= 0)
    return

  if (hasScript.value) {
    const layer = ensureStaticLayer(W, H, dpr, duration)
    if (layer)
      ctx.drawImage(layer, 0, 0, W, H)
    // What has played gets a wash, so position reads at a glance.
    ctx.fillStyle = p.accent
    ctx.globalAlpha = 0.16
    ctx.fillRect(0, 0, px, H)
    ctx.globalAlpha = 1
  }
  else {
    const barH = live ? 6 : 4
    const y = H / 2 - barH / 2
    ctx.fillStyle = p.ink
    ctx.globalAlpha = 0.14
    ctx.fillRect(0, y, W, barH)
    ctx.globalAlpha = 1
    ctx.fillStyle = p.accent
    ctx.fillRect(0, y, px, barH)
  }

  // ── A–B loop ──
  const { loopStart, loopEnd } = player
  if (loopStart !== null) {
    const lx0 = (loopStart / duration) * W
    const lx1 = loopEnd !== null ? (loopEnd / duration) * W : null
    if (lx1 !== null) {
      ctx.fillStyle = p.accent
      ctx.globalAlpha = player.loopActive ? 0.2 : 0.09
      ctx.fillRect(lx0, 0, lx1 - lx0, H)
      ctx.globalAlpha = 1
    }
    for (const x of lx1 !== null ? [lx0, lx1] : [lx0]) {
      ctx.fillStyle = p.accent
      ctx.globalAlpha = player.loopActive || lx1 === null ? 1 : 0.6
      ctx.fillRect(x - 1, 0, 2, H)
      // A tab at the top to grab.
      ctx.fillRect(x - 4, 0, 8, 6)
      ctx.globalAlpha = 1
    }
  }

  // ── Bookmarks: small flags along the bottom edge ──
  ctx.fillStyle = p.warn
  for (const bm of bookmarks.value) {
    const bx = (bm.time / duration) * W
    ctx.beginPath()
    ctx.moveTo(bx - 4, H)
    ctx.lineTo(bx + 4, H)
    ctx.lineTo(bx, H - 7)
    ctx.closePath()
    ctx.fill()
  }

  // ── Finish markers: a dot at the top with a faint stem ──
  for (const fe of finishes.value) {
    const cx = (fe.at / duration) * W
    ctx.fillStyle = p.danger
    ctx.globalAlpha = 0.35
    ctx.fillRect(cx - 0.5, 8, 1, H - 8)
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.arc(cx, 5, 3.5, 0, Math.PI * 2)
    ctx.fill()
  }

  // ── Hover guide ──
  if (hovering.value && drag.value === null) {
    ctx.strokeStyle = p.ink
    ctx.globalAlpha = 0.45
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(hoverX.value + 0.5, 0)
    ctx.lineTo(hoverX.value + 0.5, H)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  // ── Playhead ──
  ctx.fillStyle = p.ink
  ctx.fillRect(px - 1, 0, 2, H)
  ctx.beginPath()
  ctx.arc(px, live ? 4 : 3, live ? 5 : 3.5, 0, Math.PI * 2)
  ctx.fill()
}

const { redraw } = useSmoothPlayhead(draw)

watch(
  [
    () => player.loopStart,
    () => player.loopEnd,
    () => player.loopActive,
    () => player.videoDuration,
    () => scriptStore.primaryScript,
    () => scriptStore.primaryScript?.offsetMs,
    bookmarks,
    finishes,
    analysis,
    showBand,
    palette,
    hovering,
    hoverX,
    drag,
  ],
  () => redraw(),
  { flush: 'post' },
)

// ─── Interaction ─────────────────────────────────────────────────────────────

function xToTime(clientX: number) {
  const r = rootEl.value?.getBoundingClientRect()
  if (!r || !r.width)
    return 0
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * player.videoDuration
}

function loopHandleAt(clientX: number): 'loopStart' | 'loopEnd' | null {
  const r = rootEl.value?.getBoundingClientRect()
  const d = player.videoDuration
  if (!r || !d)
    return null
  const at = (t: number | null) => (t === null ? Number.POSITIVE_INFINITY : Math.abs(r.left + (t / d) * r.width - clientX))
  const a = at(player.loopStart)
  const b = at(player.loopEnd)
  if (Math.min(a, b) > HANDLE_GRAB)
    return null
  return b <= a ? 'loopEnd' : 'loopStart'
}

const nearHandle = ref(false)

// Seeking the element on every pointermove floods the decoder; coalesce to one
// seek per frame.
let seekRaf = 0
let pendingSeek = 0
function scrubTo(t: number) {
  scrubTime = t
  pendingSeek = t
  redraw()
  if (seekRaf)
    return
  seekRaf = requestAnimationFrame(() => {
    seekRaf = 0
    playback.seek(pendingSeek)
  })
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || player.videoDuration <= 0)
    return
  rootEl.value?.setPointerCapture(e.pointerId)
  const handle = loopHandleAt(e.clientX)
  drag.value = handle ?? 'scrub'
  if (!handle)
    scrubTo(xToTime(e.clientX))
}

function onPointerMove(e: PointerEvent) {
  const r = rootEl.value?.getBoundingClientRect()
  if (!r)
    return
  hoverX.value = Math.max(0, Math.min(r.width, e.clientX - r.left))
  nearHandle.value = drag.value === null && loopHandleAt(e.clientX) !== null
  if (!drag.value)
    return
  const t = xToTime(e.clientX)
  if (drag.value === 'scrub')
    scrubTo(t)
  else if (drag.value === 'loopStart')
    player.setLoopStart(player.loopEnd !== null ? Math.min(t, player.loopEnd - 0.1) : t)
  else
    player.setLoopEnd(player.loopStart !== null ? Math.max(t, player.loopStart + 0.1) : t)
}

function onPointerUp(e: PointerEvent) {
  if (rootEl.value?.hasPointerCapture(e.pointerId))
    rootEl.value.releasePointerCapture(e.pointerId)
  drag.value = null
  // Hold the scrub position until the video reports it, so the playhead does
  // not flick back to the old time for a frame.
  setTimeout(() => {
    scrubTime = null
    redraw()
  }, 120)
}

function onKeyDown(e: KeyboardEvent) {
  const d = player.videoDuration
  if (!d)
    return
  const step = e.shiftKey ? 30 : 5
  const handled: Record<string, () => void> = {
    ArrowLeft: () => playback.seekRelative(-step),
    ArrowRight: () => playback.seekRelative(step),
    Home: () => playback.seek(0),
    End: () => playback.seek(Math.max(0, d - 1)),
  }
  const run = handled[e.key]
  if (!run)
    return
  // Stop it here: the player's own window-level arrow keys would seek again.
  e.preventDefault()
  e.stopPropagation()
  run()
}

// ─── Hover readout ──────────────────────────────────────────────────────────
const hoverTime = computed(() => {
  const w = size.value.w
  return w ? (hoverX.value / w) * player.videoDuration : 0
})

/** A bookmark under the pointer, so its label shows in the readout. */
const hoverBookmark = computed(() => {
  const w = size.value.w
  const d = player.videoDuration
  if (!w || !d)
    return null
  return bookmarks.value.find(b => Math.abs((b.time / d) * w - hoverX.value) < 6) ?? null
})

const readoutLeft = computed(() => {
  const w = size.value.w
  // Keep the bubble inside the strip.
  return Math.max(28, Math.min(w - 28, hoverX.value))
})

// ─── Context menu ────────────────────────────────────────────────────────────
const menu = ref<{ x: number, y: number, items: MenuItem[] } | null>(null)

function onContextMenu(e: MouseEvent) {
  if (props.variant !== 'dock' || player.videoDuration <= 0)
    return
  e.preventDefault()
  const t = xToTime(e.clientX)
  const at = formatTime(t)
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: `Play from ${at}`, icon: 'i-carbon-play', run: () => playback.seek(t) },
      { separator: true },
      { label: `Loop start at ${at}`, icon: 'i-carbon-skip-back-outline', run: () => loop.setLoopStart(t) },
      { label: `Loop end at ${at}`, icon: 'i-carbon-skip-forward-outline', run: () => loop.setLoopEnd(t) },
      {
        label: player.loopEnabled ? 'Loop off' : 'Loop on',
        icon: 'i-carbon-repeat',
        disabled: !player.hasLoop,
        run: () => loop.toggleLoop(),
      },
      { label: 'Clear loop', icon: 'i-carbon-close', disabled: player.loopStart === null, run: () => loop.clearLoop() },
      { separator: true },
      {
        label: `Bookmark ${at}`,
        icon: 'i-carbon-bookmark-add',
        disabled: !videoName.value,
        run: () => {
          if (!videoName.value)
            return
          bookmarkStore.add(videoName.value, t)
          toast('Bookmark added', { detail: at, icon: 'i-carbon-bookmark', key: 'bookmark' })
        },
      },
    ],
  }
}

// ─── Sizing ──────────────────────────────────────────────────────────────────
let ro: ResizeObserver | null = null

function resize() {
  const el = rootEl.value
  const canvas = canvasEl.value
  if (!el || !canvas)
    return
  const w = el.clientWidth
  const h = el.clientHeight
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  size.value = { w, h }
  redraw()
}

onMounted(() => {
  ro = new ResizeObserver(resize)
  if (rootEl.value)
    ro.observe(rootEl.value)
  resize()
  themeObs = new MutationObserver(() => (palette.value = readPalette()))
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})

onBeforeUnmount(() => {
  ro?.disconnect()
  themeObs?.disconnect()
  cancelAnimationFrame(seekRaf)
})

const ariaNow = computed(() => Math.round(player.currentTime))
const ariaText = computed(() => `${formatTime(player.currentTime, '0:00')} of ${formatTime(player.videoDuration, '0:00')}`)

defineExpose({ redraw, playhead: () => playheadT })
</script>

<template>
  <div
    ref="rootEl"
    role="slider"
    tabindex="0"
    aria-label="Seek"
    :aria-valuemin="0"
    :aria-valuemax="Math.round(player.videoDuration)"
    :aria-valuenow="ariaNow"
    :aria-valuetext="ariaText"
    class="outline-none rounded-[var(--radius-sm)] w-full select-none relative touch-none focus-visible:ring-2 focus-visible:ring-accent/60"
    :class="[
      nearHandle || drag === 'loopStart' || drag === 'loopEnd' ? 'cursor-ew-resize' : player.videoDuration > 0 ? 'cursor-pointer' : 'cursor-default',
    ]"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @pointerenter="hovering = true"
    @pointerleave="hovering = false; nearHandle = false"
    @keydown="onKeyDown"
    @contextmenu="onContextMenu"
  >
    <canvas ref="canvasEl" class="rounded-[var(--radius-sm)] h-full w-full inset-0 absolute" />

    <!-- Hover readout -->
    <Transition name="t-fade">
      <div
        v-if="(hovering || drag === 'scrub') && player.videoDuration > 0"
        class="text-[11px] font-medium px-1.5 py-0.5 rounded-[var(--radius-xs)] flex gap-1.5 pointer-events-none whitespace-nowrap items-center absolute z-1 -translate-x-1/2"
        :class="variant === 'overlay'
          ? 'bg-black/75 text-white -top-7'
          : 'bg-surface-700 text-fg shadow-[var(--shadow-md)] -top-7'"
        :style="{ left: `${readoutLeft}px` }"
      >
        <span class="num">{{ formatTime(hoverTime, '0:00') }}</span>
        <template v-if="hoverBookmark && drag === null">
          <span class="i-carbon-bookmark-filled text-[11px] text-warn" />
          <span class="max-w-[160px] truncate">{{ hoverBookmark.label }}</span>
        </template>
      </div>
    </Transition>

    <UiContextMenu v-if="variant === 'dock'" v-model="menu" />
  </div>
</template>
