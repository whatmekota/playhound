<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { usePlayerStore } from '~/stores/playerStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useLoopSection } from '~/composables/useLoopSection'
import { useBookmarkStore } from '~/stores/bookmarkStore'
import { useStatsStore } from '~/stores/statsStore'

const playerStore = usePlayerStore()
const scriptStore = useScriptStore()
const bookmarkStore = useBookmarkStore()
const statsStore = useStatsStore()
const { setLoopStart, setLoopEnd, checkLoop } = useLoopSection()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const timelineEl = ref<HTMLDivElement | null>(null)
const isDragging = ref(false)
const dragTarget = ref<'scrub' | 'loopStart' | 'loopEnd' | null>(null)
const isHovering = ref(false)
const hoverX = ref(0)
const hoverTime = ref(0)

const emit = defineEmits<{
  seek: [time: number]
}>()

// ─── Waveform drawing ─────────────────────────────────────────────────────────

function formatTime(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

function drawHeatmap(ctx: CanvasRenderingContext2D, W: number, H: number, duration: number) {
  const primary = scriptStore.primaryScript
  if (!primary || primary.parsed.actions.length < 2) return
  const actions = primary.parsed.actions
  const BUCKETS = Math.max(1, Math.floor(W / 3))
  const bucketMs = (duration * 1000) / BUCKETS
  const intensity = new Float32Array(BUCKETS)
  for (let i = 0; i < actions.length - 1; i++) {
    const b = Math.floor(actions[i].at / bucketMs)
    if (b >= 0 && b < BUCKETS) {
      intensity[b] = Math.max(intensity[b], Math.abs(actions[i + 1].pos - actions[i].pos) / 100)
    }
  }
  const bw = W / BUCKETS
  for (let b = 0; b < BUCKETS; b++) {
    const v = intensity[b]
    if (v < 0.01) continue
    // cool blue → hot magenta
    const hue = 260 - v * 220
    const sat = 60 + v * 40
    const lit = 35 + v * 30
    ctx.fillStyle = `hsla(${hue},${sat}%,${lit}%,0.55)`
    ctx.fillRect(b * bw, 0, bw + 1, H)
  }
}

function drawTimeline() {
  const canvas = canvasEl.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

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

  // ── Heatmap (shown when hovering) ──
  if (isHovering.value) {
    drawHeatmap(ctx, W, H, duration)
  }

  // ── Draw funscript waveform ──
  if (primary && primary.parsed.actions.length > 0) {
    const actions = primary.parsed.actions
    ctx.beginPath()
    ctx.strokeStyle = isHovering.value ? 'rgba(217, 70, 239, 0.85)' : 'rgba(217, 70, 239, 0.5)'
    ctx.lineWidth = 1.5

    for (let i = 0; i < actions.length - 1; i++) {
      const x0 = (actions[i].at / (duration * 1000)) * W
      const y0 = H - actions[i].pos * H
      const x1 = (actions[i + 1].at / (duration * 1000)) * W
      const y1 = H - actions[i + 1].pos * H

      if (i === 0) ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
    }
    ctx.stroke()
  } else {
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
  } else if (playerStore.loopStart !== null) {
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
  ],
  drawTimeline,
  { flush: 'post' }
)

// ─── Interaction ──────────────────────────────────────────────────────────────

function posToTime(clientX: number): number {
  if (!timelineEl.value) return 0
  const rect = timelineEl.value.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  return ratio * playerStore.videoDuration
}

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
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
  if (!timelineEl.value) return
  const rect = timelineEl.value.getBoundingClientRect()
  hoverX.value = e.clientX - rect.left
  hoverTime.value = posToTime(e.clientX)

  if (!isDragging.value) return
  const time = posToTime(e.clientX)
  if (dragTarget.value === 'scrub') {
    emit('seek', time)
  } else if (dragTarget.value === 'loopStart') {
    playerStore.setLoopStart(time)
  } else if (dragTarget.value === 'loopEnd') {
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
  if (timelineEl.value) observer.observe(timelineEl.value)
})

onUnmounted(() => {
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('mousemove', onMouseMove)
})
</script>

<template>
  <div
    ref="timelineEl"
    class="relative w-full h-12 cursor-pointer select-none group"
    @mousedown="onMouseDown"
    @mouseenter="isHovering = true"
    @mouseleave="isHovering = false"
  >
    <canvas
      ref="canvasEl"
      class="absolute inset-0 w-full h-full"
    />
    <!-- Hover time tooltip -->
    <div
      v-if="isHovering && playerStore.videoDuration > 0"
      class="absolute top-1 pointer-events-none text-[10px] font-mono text-white/70 bg-black/60 px-1.5 py-0.5 rounded"
      :style="{ left: Math.min(hoverX, (timelineEl?.clientWidth ?? 0) - 60) + 'px' }"
    >{{ formatTime(hoverTime) }}</div>
  </div>
</template>
