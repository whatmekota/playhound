<script setup lang="ts">
import type { MenuItem } from '~/components/ui/menu'
import type { MoveLimits, Pt, SelectMode } from '~/lib/scriptEdit'
import { useElementSize } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiContextMenu from '~/components/ui/UiContextMenu.vue'
import { useSmoothPlayhead } from '~/composables/useSmoothPlayhead'
import { cancelFrame, requestFrame } from '~/lib/frames'
import {
  combineSelection,
  dragSelection,
  hitTest,
  lowerBound,
  moveLimits,
  segmentSpeed,
  selectInBox,
} from '~/lib/scriptEdit'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useScriptEditStore } from '~/stores/scriptEditStore'

/**
 * The editing surface: the script over time, zoomable and scrollable, with
 * a ruler to scrub on and an overview of the whole script underneath.
 *
 * Drawn on canvas, since a dense script has tens of thousands of points;
 * only what is in view is walked. Times here are script times (what the
 * file says); the playhead is drawn where the device reads the script,
 * video time plus the offset.
 */

const edit = useScriptEditStore()
const player = usePlayerStore()
const playback = usePlaybackStore()

const wrapEl = ref<HTMLDivElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const overviewEl = ref<HTMLCanvasElement | null>(null)
const { width, height } = useElementSize(wrapEl)

// ─── View ────────────────────────────────────────────────────────────────────
const PAD = { l: 30, r: 10, t: 22, b: 10 }
const MIN_SPAN = 250
/** Zoom step for the buttons and keys; the wheel uses its own smaller one. */
const ZOOM_STEP = 1.6

const viewStart = ref(0)
const viewSpan = ref(10_000)

/** How long the script's world is: the video, or the script if it runs on. */
const totalMs = computed(() => {
  const p = edit.points
  const last = p.length ? p[p.length - 1].at : 0
  return Math.max(player.videoDuration * 1000, last, 1000)
})
const maxSpan = computed(() => Math.max(totalMs.value * 1.05, 5000))

// ─── Pointer and playhead state ─────────────────────────────────────────────
type Drag
  = | { kind: 'move', original: Pt[], sel: number[], anchor: number, x0: number, y0: number, limits: MoveLimits, moved: boolean }
    | { kind: 'box', x0: number, y0: number, x1: number, y1: number, mode: SelectMode }
    | { kind: 'range', x0: number, x1: number }
    | { kind: 'scrub' }

let drag: Drag | null = null
/** A redraw is booked for the next frame. */
let raf = 0

/** The playhead, in video seconds, as last drawn. */
let playheadT = player.currentTime
const playheadScript = () => playheadT * 1000 + (edit.target?.offsetMs ?? 0)

// The overview's script is drawn once per change, then blitted.
let overviewLayer: HTMLCanvasElement | null = null
let overviewKey = ''

const plotW = computed(() => Math.max(1, width.value - PAD.l - PAD.r))
const plotH = computed(() => Math.max(1, height.value - PAD.t - PAD.b))

const x = (at: number) => PAD.l + ((at - viewStart.value) / viewSpan.value) * plotW.value
const y = (pos: number) => PAD.t + (1 - pos) * plotH.value
const tAt = (px: number) => viewStart.value + ((px - PAD.l) / plotW.value) * viewSpan.value
const posAt = (py: number) => 1 - (py - PAD.t) / plotH.value

function setView(start: number, span: number) {
  const s = Math.max(MIN_SPAN, Math.min(maxSpan.value, span))
  viewSpan.value = s
  viewStart.value = Math.max(-s * 0.05, Math.min(totalMs.value - s * 0.95, start))
}

/** Zoom by `factor` (>1 zooms out) keeping time `around` where it is on screen. */
function zoom(factor: number, around = viewStart.value + viewSpan.value / 2) {
  const f = (around - viewStart.value) / viewSpan.value
  const span = Math.max(MIN_SPAN, Math.min(maxSpan.value, viewSpan.value * factor))
  setView(around - f * span, span)
}

function zoomIn() {
  zoom(1 / ZOOM_STEP, playheadScript())
}
function zoomOut() {
  zoom(ZOOM_STEP, playheadScript())
}
function fitAll() {
  setView(0, totalMs.value * 1.02)
}
/** Bring the selection into view, zoomed so it fills most of it. */
function showSelection() {
  const sel = edit.selection
  const p = edit.points
  if (!sel.length)
    return
  const a = p[sel[0]].at
  const b = p[sel[sel.length - 1]].at
  const span = Math.max(viewSpan.value, (b - a) * 1.3, MIN_SPAN)
  setView((a + b) / 2 - span / 2, span)
}

/** Bring a stretch of time (script ms) into view, unless it is already. */
function showSpan(a: number, b: number) {
  const t0 = viewStart.value
  const t1 = t0 + viewSpan.value
  if (a >= t0 && b <= t1 && b - a > viewSpan.value * 0.1)
    return
  const span = Math.max(MIN_SPAN, (b - a) * 1.3)
  setView((a + b) / 2 - span / 2, span)
}

defineExpose({ zoomIn, zoomOut, fitAll, showSelection, showSpan })

// ─── Playhead ────────────────────────────────────────────────────────────────
/** While playing, the view scrolls to keep the playhead a third of the way in. */
function follow() {
  if (!player.isPlaying || drag)
    return
  const ph = playheadScript()
  const want = ph - viewSpan.value / 3
  if (Math.abs(want - viewStart.value) > 1)
    viewStart.value = want
}

useSmoothPlayhead((t) => {
  playheadT = t
  follow()
  invalidate()
})

// Start around the playhead, at a zoom where single strokes are visible.
onMounted(() => setView(playheadScript() - 3000, 10_000))

// ─── Colours ─────────────────────────────────────────────────────────────────
interface Palette { bg: string, ruler: string, grid: string, ink: string, muted: string, faint: string, accent: string, line: string, danger: string }
const palette = ref<Palette>(readPalette())

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    bg: v('--bg-900', '#0e0e12'),
    ruler: v('--bg-850', '#131318'),
    grid: v('--border', 'rgba(255,255,255,.07)'),
    ink: v('--text', 'white'),
    muted: v('--text-muted', 'gray'),
    faint: v('--text-faint', 'gray'),
    accent: v('--accent', 'magenta'),
    line: v('--accent-light', 'violet'),
    danger: v('--danger', 'crimson'),
  }
}

let themeObs: MutationObserver | null = null
onMounted(() => {
  themeObs = new MutationObserver(() => {
    palette.value = readPalette()
    overviewKey = ''
  })
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})
onBeforeUnmount(() => themeObs?.disconnect())

// ─── Interaction ─────────────────────────────────────────────────────────────
/** The points while a drag is under way, ahead of the store (which gets them a few times a second). */
let live: Pt[] | null = null
let lastPreview = 0
const PREVIEW_MS = 90
const HIT_RADIUS = 7

const hover = ref<number | null>(null)
const cursor = ref('crosshair')

function local(e: PointerEvent | MouseEvent) {
  const r = canvasEl.value!.getBoundingClientRect()
  return { px: e.clientX - r.left, py: e.clientY - r.top }
}

const pointsNow = () => live ?? (edit.points as Pt[])

function hit(px: number, py: number) {
  return hitTest(pointsNow(), px, py, x, y, HIT_RADIUS, tAt)
}

function seekScript(ms: number) {
  if (!player.videoUrl)
    return
  const t = (ms - (edit.target?.offsetMs ?? 0)) / 1000
  const d = player.videoDuration
  playback.seek(Math.max(0, d ? Math.min(d - 0.05, t) : t))
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || !canvasEl.value)
    return
  canvasEl.value.focus({ preventScroll: true })
  canvasEl.value.setPointerCapture(e.pointerId)
  const { px, py } = local(e)

  if (py < PAD.t) {
    drag = { kind: 'scrub' }
    seekScript(tAt(px))
    return
  }

  // Alt + drag marks a stretch of time to fill, points or none.
  if (e.altKey) {
    e.preventDefault()
    drag = { kind: 'range', x0: px, x1: px }
    return
  }

  const i = hit(px, py)
  const additive = e.shiftKey
  const toggling = e.ctrlKey || e.metaKey
  if (i !== null) {
    if (toggling) {
      edit.setSelection(combineSelection(edit.selection, [i], 'toggle'))
      return
    }
    let sel = edit.selection
    if (!sel.includes(i))
      sel = additive ? combineSelection(sel, [i], 'add') : [i]
    edit.setSelection(sel)
    const original = (edit.points as Pt[]).slice()
    drag = { kind: 'move', original, sel: edit.selection, anchor: i, x0: px, y0: py, limits: moveLimits(original, edit.selection), moved: false }
    cursor.value = 'grabbing'
    return
  }

  drag = { kind: 'box', x0: px, y0: py, x1: px, y1: py, mode: toggling ? 'toggle' : additive ? 'add' : 'replace' }
}

function onPointerMove(e: PointerEvent) {
  const { px, py } = local(e)
  if (!drag) {
    const i = py >= PAD.t ? hit(px, py) : null
    if (i !== hover.value)
      hover.value = i
    cursor.value = py < PAD.t ? 'col-resize' : i !== null ? 'grab' : 'crosshair'
    return
  }
  if (drag.kind === 'scrub') {
    seekScript(tAt(px))
    return
  }
  if (drag.kind === 'box') {
    drag.x1 = px
    drag.y1 = py
    invalidate()
    return
  }
  if (drag.kind === 'range') {
    drag.x1 = px
    invalidate()
    return
  }
  // Moving: a few pixels of slack, so a click on a point never nudges it.
  if (!drag.moved && Math.hypot(px - drag.x0, py - drag.y0) < 3)
    return
  drag.moved = true
  const dt = ((px - drag.x0) / plotW.value) * viewSpan.value
  const dp = -(py - drag.y0) / plotH.value
  const snap = { positions: edit.prefs.snapPositions, fps: edit.prefs.snapFrames ? edit.prefs.fps : 0 }
  live = dragSelection(drag.original, drag.sel, drag.anchor, dt, dp, snap, drag.limits)
  hover.value = drag.anchor
  invalidate()
  // The device follows the drag, a few times a second.
  const now = performance.now()
  if (now - lastPreview > PREVIEW_MS) {
    lastPreview = now
    edit.preview(live)
  }
}

function onPointerUp(e: PointerEvent) {
  if (canvasEl.value?.hasPointerCapture(e.pointerId))
    canvasEl.value.releasePointerCapture(e.pointerId)
  const d = drag
  drag = null
  cursor.value = 'crosshair'
  if (!d)
    return
  if (d.kind === 'move') {
    if (d.moved && live)
      edit.commit(live, d.sel, d.original, d.sel)
    live = null
  }
  else if (d.kind === 'range') {
    const a = Math.max(0, tAt(Math.min(d.x0, d.x1)))
    const b = tAt(Math.max(d.x0, d.x1))
    // A plain Alt + click takes the mark away.
    edit.markedRange = Math.abs(d.x1 - d.x0) < 3 || b - a < 2 ? null : { t0: Math.round(a), t1: Math.round(b) }
  }
  else if (d.kind === 'box') {
    const small = Math.abs(d.x1 - d.x0) < 3 && Math.abs(d.y1 - d.y0) < 3
    if (small) {
      // A plain click on empty space: let go of the selection, and of a marked stretch.
      if (d.mode === 'replace') {
        edit.setSelection([])
        edit.markedRange = null
      }
    }
    else {
      const hits = selectInBox(edit.points, tAt(d.x0), tAt(d.x1), posAt(d.y0), posAt(d.y1))
      edit.setSelection(combineSelection(edit.selection, hits, d.mode))
    }
  }
  invalidate()
}

function onDoubleClick(e: MouseEvent) {
  const { px, py } = local(e)
  if (py < PAD.t || hit(px, py) !== null)
    return
  edit.insertAt(tAt(px), Math.max(0, Math.min(1, posAt(py))))
}

// ─── Right-click ─────────────────────────────────────────────────────────────
const menu = ref<{ x: number, y: number, items: MenuItem[] } | null>(null)
const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

function onContextMenu(e: MouseEvent) {
  const { px, py } = local(e)
  if (py < PAD.t)
    return
  const at = Math.max(0, tAt(px))
  const pos = Math.max(0, Math.min(1, posAt(py)))
  const n = edit.selection.length
  const fillLabel = n >= 2
    ? 'Fill between the selected points…'
    : edit.markedRange ? 'Fill the marked stretch…' : 'Fill…'
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: fillLabel, icon: 'i-carbon-chart-line-smooth', kbd: 'Shift I', run: () => edit.openFill() },
      { label: 'Insert a pattern here…', icon: 'i-carbon-add-alt', run: () => edit.openFill(at) },
      { label: 'Save the selection as a pattern…', icon: 'i-carbon-save-series', disabled: n < 2, run: () => edit.openPatternSave() },
      { separator: true },
      { label: 'Add a point here', icon: 'i-carbon-dot-mark', run: () => edit.insertAt(at, pos) },
      { label: 'Select all', kbd: `${mod} A`, run: () => edit.selectAll() },
      ...(edit.markedRange ? [{ label: 'Clear the marked stretch', icon: 'i-carbon-close', run: () => (edit.markedRange = null) }] : []),
      { label: n === 1 ? 'Delete the selected point' : 'Delete the selected points', icon: 'i-carbon-trash-can', kbd: 'Del', danger: true, disabled: !n, run: () => edit.deleteSelected() },
    ],
  }
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  // A sideways scroll (trackpad, Shift + wheel) pans; up and down zooms around the pointer.
  const sideways = e.shiftKey ? e.deltaY : e.deltaX
  if (Math.abs(sideways) > Math.abs(e.deltaY) || e.shiftKey) {
    setView(viewStart.value + (sideways / plotW.value) * viewSpan.value, viewSpan.value)
    return
  }
  const { px } = local(e)
  zoom(Math.exp(e.deltaY * 0.0015), tAt(px))
}

// ─── Overview ────────────────────────────────────────────────────────────────
let overviewDrag = false
function overviewTo(e: PointerEvent) {
  const el = overviewEl.value
  if (!el)
    return
  const r = el.getBoundingClientRect()
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  setView(f * totalMs.value - viewSpan.value / 2, viewSpan.value)
}
function onOverviewDown(e: PointerEvent) {
  if (e.button !== 0)
    return
  overviewDrag = true
  overviewEl.value?.setPointerCapture(e.pointerId)
  overviewTo(e)
}
function onOverviewMove(e: PointerEvent) {
  if (overviewDrag)
    overviewTo(e)
}
function onOverviewUp(e: PointerEvent) {
  overviewDrag = false
  if (overviewEl.value?.hasPointerCapture(e.pointerId))
    overviewEl.value.releasePointerCapture(e.pointerId)
}

// ─── Drawing ─────────────────────────────────────────────────────────────────
function invalidate() {
  if (!raf) {
    raf = requestFrame(() => {
      raf = 0
      draw()
      drawOverview()
    })
  }
}
onBeforeUnmount(() => cancelFrame(raf))

/** A step for time ticks that leaves at least `minPx` between them. */
function tickStep(minPx: number) {
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000]
  const perPx = viewSpan.value / plotW.value
  return steps.find(s => s / perPx >= minPx) ?? steps[steps.length - 1]
}

function fmtTick(ms: number, step: number) {
  const neg = ms < 0
  const t = Math.abs(ms)
  const m = Math.floor(t / 60_000)
  const s = Math.floor((t % 60_000) / 1000)
  const rest = Math.round(t % 1000)
  const base = `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}`
  if (step >= 1000)
    return base
  return `${base}.${String(rest).padStart(3, '0').slice(0, step >= 100 ? 1 : step >= 10 ? 2 : 3)}`
}

function draw() {
  const c = canvasEl.value
  const W = width.value
  const H = height.value
  if (!c || W < 2 || H < 2)
    return
  const dpr = window.devicePixelRatio || 1
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr)
    c.height = Math.round(H * dpr)
  }
  const ctx = c.getContext('2d')
  if (!ctx)
    return
  const p = palette.value
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = p.bg
  ctx.fillRect(0, 0, W, H)

  const t0 = viewStart.value
  const t1 = t0 + viewSpan.value

  // Ruler.
  ctx.fillStyle = p.ruler
  ctx.fillRect(0, 0, W, PAD.t)

  // Position grid: 0, 25, 50, 75, 100.
  ctx.font = '10px "Geist Mono", ui-monospace, monospace'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'right'
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const yy = Math.round(y(v)) + 0.5
    ctx.strokeStyle = p.grid
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(PAD.l, yy)
    ctx.lineTo(W - PAD.r, yy)
    ctx.stroke()
    if (v === 0 || v === 0.5 || v === 1) {
      ctx.fillStyle = p.faint
      ctx.fillText(String(v * 100), PAD.l - 6, yy)
    }
  }

  // Time ticks.
  const step = tickStep(80)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
    const xx = Math.round(x(t)) + 0.5
    if (xx < PAD.l - 1)
      continue
    ctx.strokeStyle = p.grid
    ctx.beginPath()
    ctx.moveTo(xx, PAD.t - 6)
    ctx.lineTo(xx, H - PAD.b)
    ctx.stroke()
    ctx.fillStyle = p.muted
    ctx.fillText(fmtTick(t, step), xx + 4, PAD.t / 2)
  }

  ctx.save()
  ctx.beginPath()
  ctx.rect(PAD.l, PAD.t, W - PAD.l - PAD.r, H - PAD.t)
  ctx.clip()

  // A marked stretch (Alt + drag), or one being marked: a band behind everything.
  const band = drag?.kind === 'range'
    ? { a: Math.min(drag.x0, drag.x1), b: Math.max(drag.x0, drag.x1) }
    : edit.markedRange ? { a: x(edit.markedRange.t0), b: x(edit.markedRange.t1) } : null
  if (band) {
    ctx.fillStyle = p.accent
    ctx.globalAlpha = 0.1
    ctx.fillRect(band.a, PAD.t, band.b - band.a, H - PAD.t)
    ctx.globalAlpha = 0.6
    ctx.strokeStyle = p.accent
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    for (const bx of [band.a, band.b]) {
      ctx.beginPath()
      ctx.moveTo(Math.round(bx) + 0.5, PAD.t)
      ctx.lineTo(Math.round(bx) + 0.5, H)
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  // What plays, when tweaks change it: a faint line behind the points.
  const played = edit.played
  if (played && played.length > 1) {
    ctx.strokeStyle = p.faint
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    polyline(ctx, played as Pt[], t0, t1)
    ctx.stroke()
    ctx.setLineDash([])
  }

  const pts = pointsNow()
  const n = pts.length
  const i0 = Math.max(0, lowerBound(pts, t0) - 1)
  const i1 = Math.min(n, lowerBound(pts, t1) + 1)

  // The script.
  if (n > 1) {
    ctx.strokeStyle = p.line
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    polyline(ctx, pts, t0, t1)
    ctx.stroke()

    // Too fast for most devices: drawn over in the danger colour.
    const limit = edit.prefs.fastLimit
    ctx.strokeStyle = p.danger
    ctx.lineWidth = 3
    ctx.beginPath()
    for (let i = Math.max(0, i0); i < Math.min(n - 1, i1); i++) {
      if (segmentSpeed(pts[i], pts[i + 1]) > limit) {
        ctx.moveTo(x(pts[i].at), y(pts[i].pos))
        ctx.lineTo(x(pts[i + 1].at), y(pts[i + 1].pos))
      }
    }
    ctx.stroke()
  }

  // Points: every one while there is room to tell them apart, else only the selected.
  const sel = new Set(edit.selection)
  const roomy = i1 - i0 < plotW.value / 4
  for (let i = i0; i < i1; i++) {
    const on = sel.has(i)
    if (!on && !roomy && i !== hover.value)
      continue
    const px = x(pts[i].at)
    const py = y(pts[i].pos)
    ctx.beginPath()
    ctx.arc(px, py, on ? 4.5 : i === hover.value ? 4.5 : 3.25, 0, Math.PI * 2)
    ctx.fillStyle = on ? p.accent : p.bg
    ctx.fill()
    ctx.lineWidth = on ? 2 : 1.5
    ctx.strokeStyle = on ? p.ink : i === hover.value ? p.ink : p.line
    ctx.stroke()
  }

  // A fill being set up: what is there now dimmed, what it would become over it.
  const fp = edit.fillPreview
  if (fp && fp.points.length) {
    const a = x(fp.from)
    const b = x(fp.to)
    ctx.fillStyle = p.bg
    ctx.globalAlpha = 0.72
    ctx.fillRect(a, PAD.t, b - a, H - PAD.t)
    ctx.globalAlpha = 0.1
    ctx.fillStyle = p.accent
    ctx.fillRect(a, PAD.t, b - a, H - PAD.t)
    ctx.globalAlpha = 1
    ctx.strokeStyle = p.accent
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    polyline(ctx, fp.points as Pt[], t0, t1)
    ctx.stroke()
    const vis = lowerBound(fp.points, t1) - lowerBound(fp.points, t0)
    if (vis < plotW.value / 6) {
      ctx.fillStyle = p.accent
      for (const q of fp.points) {
        if (q.at < t0 || q.at > t1)
          continue
        ctx.beginPath()
        ctx.arc(x(q.at), y(q.pos), 2.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  ctx.restore()

  // Selection box.
  if (drag?.kind === 'box') {
    const bx = Math.min(drag.x0, drag.x1)
    const by = Math.min(drag.y0, drag.y1)
    const bw = Math.abs(drag.x1 - drag.x0)
    const bh = Math.abs(drag.y1 - drag.y0)
    ctx.fillStyle = p.accent
    ctx.globalAlpha = 0.14
    ctx.fillRect(bx, by, bw, bh)
    ctx.globalAlpha = 1
    ctx.strokeStyle = p.accent
    ctx.lineWidth = 1
    ctx.strokeRect(Math.round(bx) + 0.5, Math.round(by) + 0.5, Math.round(bw), Math.round(bh))
  }

  // Playhead.
  const ph = playheadScript()
  if (player.videoUrl && ph >= t0 && ph <= t1) {
    const xx = Math.round(x(ph)) + 0.5
    ctx.strokeStyle = p.ink
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(xx, PAD.t - 4)
    ctx.lineTo(xx, H)
    ctx.stroke()
    ctx.fillStyle = p.ink
    ctx.beginPath()
    ctx.moveTo(xx - 5, PAD.t - 8)
    ctx.lineTo(xx + 5, PAD.t - 8)
    ctx.lineTo(xx, PAD.t - 2)
    ctx.closePath()
    ctx.fill()
  }
}

/** The part of `pts` between t0 and t1 (and one either side) as a path. */
function polyline(ctx: CanvasRenderingContext2D, pts: Pt[], t0: number, t1: number) {
  const i0 = Math.max(0, lowerBound(pts, t0) - 1)
  const i1 = Math.min(pts.length, lowerBound(pts, t1) + 1)
  ctx.beginPath()
  for (let i = i0; i < i1; i++) {
    const px = x(pts[i].at)
    const py = y(pts[i].pos)
    if (i === i0)
      ctx.moveTo(px, py)
    else
      ctx.lineTo(px, py)
  }
}

function drawOverview() {
  const c = overviewEl.value
  if (!c)
    return
  const W = c.clientWidth
  const H = c.clientHeight
  if (W < 2 || H < 2)
    return
  const dpr = window.devicePixelRatio || 1
  const total = totalMs.value
  const pts = edit.points as Pt[]
  const key = `${W}:${H}:${dpr}:${total}:${edit.target?.source?.rev ?? 0}:${pts.length}:${edit.prefs.fastLimit}`
  const p = palette.value
  if (!overviewLayer || overviewKey !== key) {
    overviewKey = key
    overviewLayer ??= document.createElement('canvas')
    overviewLayer.width = Math.round(W * dpr)
    overviewLayer.height = Math.round(H * dpr)
    const o = overviewLayer.getContext('2d')!
    o.setTransform(dpr, 0, 0, dpr, 0, 0)
    o.clearRect(0, 0, W, H)
    // The whole script as one line, then its too-fast segments over it in red.
    const ox = (at: number) => (at / total) * W
    const oy = (pos: number) => 2 + (1 - pos) * (H - 4)
    o.lineWidth = 1
    o.lineJoin = 'round'
    o.globalAlpha = 0.6
    o.strokeStyle = p.line
    o.beginPath()
    pts.forEach((a, i) => (i ? o.lineTo(ox(a.at), oy(a.pos)) : o.moveTo(ox(a.at), oy(a.pos))))
    o.stroke()
    o.globalAlpha = 1
    o.strokeStyle = p.danger
    o.lineWidth = 2
    o.beginPath()
    for (let i = 0; i + 1 < pts.length; i++) {
      if (segmentSpeed(pts[i], pts[i + 1]) > edit.prefs.fastLimit) {
        o.moveTo(ox(pts[i].at), oy(pts[i].pos))
        o.lineTo(ox(pts[i + 1].at), oy(pts[i + 1].pos))
      }
    }
    o.stroke()
  }
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr)
    c.height = Math.round(H * dpr)
  }
  const ctx = c.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.drawImage(overviewLayer, 0, 0)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  // The part in view.
  const vx = (viewStart.value / total) * W
  const vw = Math.max(3, (viewSpan.value / total) * W)
  ctx.fillStyle = p.ink
  ctx.globalAlpha = 0.1
  ctx.fillRect(vx, 0, vw, H)
  ctx.globalAlpha = 0.45
  ctx.strokeStyle = p.ink
  ctx.lineWidth = 1
  ctx.strokeRect(Math.round(vx) + 0.5, 0.5, Math.round(vw) - 1, H - 1)
  ctx.globalAlpha = 1
  // Playhead.
  if (player.videoUrl) {
    const px = Math.round((playheadScript() / total) * W) + 0.5
    ctx.strokeStyle = p.ink
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, H)
    ctx.stroke()
  }
}

watch(
  [() => edit.points, () => edit.selection, () => edit.played, () => edit.fillPreview, () => edit.markedRange, palette, width, height, viewStart, viewSpan, hover, () => edit.target],
  invalidate,
  { flush: 'post' },
)
watch(() => edit.prefs, invalidate, { deep: true })
watch(() => player.videoUrl, invalidate)

// ─── Readout ─────────────────────────────────────────────────────────────────
const hoverInfo = computed(() => {
  const i = hover.value
  const pts = edit.points
  if (i === null || !pts[i])
    return null
  const a = pts[i]
  const prev = pts[i - 1]
  const next = pts[i + 1]
  const speed = Math.max(prev ? segmentSpeed(prev, a) : 0, next ? segmentSpeed(a, next) : 0)
  return { left: x(a.at), top: y(a.pos), at: a.at, pos: Math.round(a.pos * 100), speed: Math.round(speed) }
})
</script>

<template>
  <div class="flex flex-col min-h-0">
    <div ref="wrapEl" class="flex-1 min-h-0 relative">
      <canvas
        ref="canvasEl"
        tabindex="0"
        aria-label="Script points. Drag to select, drag a point to move, double-click to add."
        class="outline-none h-full w-full inset-0 absolute touch-none"
        :style="{ cursor }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="hover = null"
        @dblclick="onDoubleClick"
        @wheel="onWheel"
        @contextmenu.prevent="onContextMenu"
      />
      <UiContextMenu v-model="menu" />
      <div
        v-if="hoverInfo"
        class="text-[11px] text-fg num px-1.5 py-0.5 pop rounded-[var(--radius-xs)] pointer-events-none whitespace-nowrap absolute"
        :style="{ left: `${Math.min(hoverInfo.left + 10, width - 150)}px`, top: `${Math.max(PAD.t + 2, hoverInfo.top - 28)}px` }"
      >
        {{ fmtTick(hoverInfo.at, 1) }} · {{ hoverInfo.pos }}
        <span :class="hoverInfo.speed > edit.prefs.fastLimit ? 'text-danger' : 'text-fg-faint'"> · {{ hoverInfo.speed }}/s</span>
      </div>
    </div>
    <canvas
      ref="overviewEl"
      aria-label="The whole script. Click or drag to move the view."
      class="border-t border-edge h-7 w-full block cursor-pointer touch-none"
      @pointerdown="onOverviewDown"
      @pointermove="onOverviewMove"
      @pointerup="onOverviewUp"
      @pointercancel="onOverviewUp"
    />
  </div>
</template>
