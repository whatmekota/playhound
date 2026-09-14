<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useScriptAnalysis } from '~/composables/useScriptAnalysis'
import { sampleEnvelope } from '~/lib/funscriptAnalysis'
import { formatTime } from '~/lib/time'
import { useBookmarkStore } from '~/stores/bookmarkStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useStatsStore } from '~/stores/statsStore'

const emit = defineEmits<{
  seek: [time: number]
}>()
const playerStore = usePlayerStore()
const scriptStore = useScriptStore()
const bookmarkStore = useBookmarkStore()
const statsStore = useStatsStore()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const { analysis } = useScriptAnalysis()
const showHeatmap = useLocalStorage('ph-timeline-heatmap', true)
const timelineEl = ref<HTMLDivElement | null>(null)
const isDragging = ref(false)
const dragTarget = ref<'scrub' | 'loopStart' | 'loopEnd' | null>(null)
const isHovering = ref(false)
const hoverX = ref(0)
const hoverTime = ref(0)

// ─── Waveform drawing ─────────────────────────────────────────────────────────

/**
 * Fraction of the strip given over to the heatmap band at the bottom.
 *
 * The heatmap used to be painted across the whole height, which left the
 * script waveform fighting a saturated background for the same pixels. Giving
 * each its own lane means both stay readable.
 */
const HEAT_BAND = 0.24

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

  const step = W / Math.max(1, Math.floor(W / 2))
  for (let x = 0; x < W; x += step) {
    const s = sampleEnvelope(a.envelope, (x / W) * durMs)
    if (!s)
      continue
    const v = Math.min(1, s.speed / ref)
    if (v < 0.02)
      continue
    // cool blue -> hot magenta
    const hue = 260 - v * 220
    const sat = 60 + v * 40
    const lit = 34 + v * 26
    ctx.fillStyle = `hsla(${hue},${sat}%,${lit}%,0.85)`
    ctx.fillRect(x, bandTop, step + 1, bandH)
  }

  // Hairline so the band reads as its own lane rather than bleeding upward.
  ctx.fillStyle = 'rgba(0,0,0,0.35)'
  ctx.fillRect(0, bandTop, W, 1)
}

/** Stroke-rate curve, drawn inside the heatmap band. */
function drawEnvelope(ctx: CanvasRenderingContext2D, W: number, H: number, duration: number) {
  const a = analysis.value
  if (!a || !a.envelope.length)
    return

  const durMs = duration * 1000
  const bandTop = H * (1 - HEAT_BAND)
  const bandH = H - bandTop
  const maxSpm = Math.max(30, ...a.envelope.map(s => s.spm))

  ctx.beginPath()
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'
  ctx.lineWidth = 1
  let started = false
  for (let x = 0; x <= W; x += 2) {
    const s = sampleEnvelope(a.envelope, (x / W) * durMs)
    if (!s)
      continue
    const y = H - (Math.min(1, s.spm / maxSpm) * (bandH - 2) + 1)
    if (!started) {
      ctx.moveTo(x, y)
      started = true
    }
    else {
      ctx.lineTo(x, y)
    }
  }
  ctx.stroke()
}

function drawTimeline() {
  const canvas = canvasEl.value
  if (!canvas)
    return
  const ctx = canvas.getContext('2d')
  if (!ctx)
    return

  const W = canvas.width
  const H = canvas.height
  ctx.clearRect(0, 0, W, H)

  const duration = playerStore.videoDuration
  if (duration === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.fillRect(0, H / 2 - 2, W, 4)
    return
  }

  const primary = scriptStore.primaryScript

  // ── Speed heatmap and session shape ──
  if (showHeatmap.value) {
    drawHeatmap(ctx, W, H, duration)
    drawEnvelope(ctx, W, H, duration)
  }

  // ── Draw funscript waveform ──
  if (primary && primary.parsed.actions.length > 0) {
    const actions = primary.parsed.actions
    // Keep clear of the heatmap band so the two do not overlap.
    const waveH = showHeatmap.value ? H * (1 - HEAT_BAND) - 2 : H

    ctx.save()
    // A dark outline under the stroke keeps it legible over the busiest
    // stretches of script, where the line is dense enough to read as a fill.
    ctx.shadowColor = 'rgba(0,0,0,0.9)'
    ctx.shadowBlur = 2
    ctx.beginPath()
    ctx.strokeStyle = isHovering.value ? 'rgba(240, 171, 252, 0.95)' : 'rgba(232, 121, 249, 0.8)'
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'

    for (let i = 0; i < actions.length - 1; i++) {
      const x0 = (actions[i].at / (duration * 1000)) * W
      const y0 = waveH - actions[i].pos * waveH
      const x1 = (actions[i + 1].at / (duration * 1000)) * W
      const y1 = waveH - actions[i + 1].pos * waveH

      if (i === 0)
        ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
    }
    ctx.stroke()
    ctx.restore()
  }
  else {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.fillRect(0, H / 2 - 2, W, 4)
  }

  // ── Draw loop region ──
  if (playerStore.loopStart !== null && playerStore.loopEnd !== null) {
    const lx0 = (playerStore.loopStart / duration) * W
    const lx1 = (playerStore.loopEnd / duration) * W
    ctx.fillStyle = 'rgba(217, 70, 239, 0.15)'
    ctx.fillRect(lx0, 0, lx1 - lx0, H)
    ctx.strokeStyle = 'rgba(217, 70, 239, 0.8)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(lx0, 0); ctx.lineTo(lx0, H)
    ctx.moveTo(lx1, 0); ctx.lineTo(lx1, H)
    ctx.stroke()
  }
  else if (playerStore.loopStart !== null) {
    const lx = (playerStore.loopStart / duration) * W
    ctx.strokeStyle = 'rgba(217, 70, 239, 0.8)'
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, H); ctx.stroke()
  }

  // ── Bookmark ticks ──
  if (playerStore.videoPath) {
    const videoName = playerStore.videoPath.split(/[\\/]/).pop() ?? playerStore.videoPath
    const bms = bookmarkStore.forVideo(videoName)
    for (const bm of bms) {
      const bx = (bm.time / duration) * W
      ctx.fillStyle = 'rgba(251, 191, 36, 0.9)'
      ctx.beginPath()
      ctx.moveTo(bx - 4, H)
      ctx.lineTo(bx + 4, H)
      ctx.lineTo(bx, H - 8)
      ctx.closePath()
      ctx.fill()
    }

    // ── Cum markers (💦) ──
    const videoStats = statsStore.stats[videoName]
    if (videoStats) {
      for (const fe of videoStats.finishEvents) {
        const cx = (fe.at / duration) * W
        // Glowing droplet shape: circle at top of timeline
        ctx.save()
        ctx.shadowColor = 'rgba(236, 72, 153, 0.8)'
        ctx.shadowBlur = 6
        ctx.fillStyle = 'rgba(236, 72, 153, 0.95)'
        ctx.beginPath()
        ctx.arc(cx, 5, 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
        // Thin vertical line down
        ctx.strokeStyle = 'rgba(236, 72, 153, 0.35)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(cx, 9)
        ctx.lineTo(cx, H)
        ctx.stroke()
      }
    }
  }

  // ── Draw playhead ──
  const px = (playerStore.currentTime / duration) * W
  ctx.fillStyle = 'rgba(255,255,255,0.15)'
  ctx.fillRect(0, H / 2 - 2, px, 4)
  ctx.fillStyle = 'rgba(255,255,255,0.06)'
  ctx.fillRect(px, H / 2 - 2, W - px, 4)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.beginPath(); ctx.arc(px, H / 2, 6, 0, Math.PI * 2); ctx.fill()

  // ── Hover time indicator ──
  if (isHovering.value) {
    const hx = hoverX.value
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke()
    ctx.setLineDash([])
  }
}

// Redraw on changes
watch(
  [
    () => playerStore.currentTime,
    () => playerStore.loopStart,
    () => playerStore.loopEnd,
    () => scriptStore.primaryScript,
    () => playerStore.videoDuration,
    () => playerStore.videoPath,
    () => bookmarkStore.bookmarks,
    () => statsStore.stats,
    isHovering,
    hoverX,
    analysis,
    showHeatmap,
  ],
  drawTimeline,
  { flush: 'post' },
)

// ─── Interaction ──────────────────────────────────────────────────────────────

function posToTime(clientX: number): number {
  if (!timelineEl.value)
    return 0
  const rect = timelineEl.value.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  return ratio * playerStore.videoDuration
}

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0)
    return
  const time = posToTime(e.clientX)

  // Check if clicking near loop markers
  if (playerStore.loopStart !== null && playerStore.videoDuration > 0) {
    const rect = timelineEl.value!.getBoundingClientRect()
    const W = rect.width
    const lx0 = (playerStore.loopStart / playerStore.videoDuration) * W + rect.left
    if (Math.abs(e.clientX - lx0) < 8) {
      dragTarget.value = 'loopStart'
      isDragging.value = true
      return
    }
  }
  if (playerStore.loopEnd !== null && playerStore.videoDuration > 0) {
    const rect = timelineEl.value!.getBoundingClientRect()
    const W = rect.width
    const lx1 = (playerStore.loopEnd / playerStore.videoDuration) * W + rect.left
    if (Math.abs(e.clientX - lx1) < 8) {
      dragTarget.value = 'loopEnd'
      isDragging.value = true
      return
    }
  }

  dragTarget.value = 'scrub'
  isDragging.value = true
  emit('seek', time)
}

function onMouseMove(e: MouseEvent) {
  if (!timelineEl.value)
    return
  const rect = timelineEl.value.getBoundingClientRect()
  hoverX.value = e.clientX - rect.left
  hoverTime.value = posToTime(e.clientX)

  if (!isDragging.value)
    return
  const time = posToTime(e.clientX)
  if (dragTarget.value === 'scrub') {
    emit('seek', time)
  }
  else if (dragTarget.value === 'loopStart') {
    playerStore.setLoopStart(time)
  }
  else if (dragTarget.value === 'loopEnd') {
    playerStore.setLoopEnd(time)
  }
}

function onMouseUp() {
  isDragging.value = false
  dragTarget.value = null
}

onMounted(() => {
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('mousemove', onMouseMove)

  // Set canvas resolution
  const observer = new ResizeObserver(() => {
    if (canvasEl.value && timelineEl.value) {
      canvasEl.value.width = timelineEl.value.clientWidth
      canvasEl.value.height = timelineEl.value.clientHeight
      drawTimeline()
    }
  })
  if (timelineEl.value)
    observer.observe(timelineEl.value)
})

onUnmounted(() => {
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('mousemove', onMouseMove)
})
</script>

<template>
  <div
    ref="timelineEl"
    class="group h-12 w-full cursor-pointer select-none relative"
    @mousedown="onMouseDown"
    @mouseenter="isHovering = true"
    @mouseleave="isHovering = false"
  >
    <canvas
      ref="canvasEl"
      class="h-full w-full inset-0 absolute"
    />
    <!-- Hover time tooltip -->
    <div
      v-if="isHovering && playerStore.videoDuration > 0"
      class="text-[10px] text-white/70 font-mono px-1.5 py-0.5 rounded bg-black/60 pointer-events-none top-1 absolute"
      :style="{ left: `${Math.min(hoverX, (timelineEl?.clientWidth ?? 0) - 60)}px` }"
    >
      {{ formatTime(hoverTime) }}
    </div>
  </div>
</template>
