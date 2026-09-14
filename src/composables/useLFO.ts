import { reactive, ref } from 'vue'

// Singleton LFO state — shared across the app
const values = reactive({ opacity: 1, zoom: 1, panX: 0, panY: 0 })
const config = reactive({
  opacityFreq: 0.08,
  opacityDepth: 0.06,
  opacityEnabled: true,
  zoomFreq: 0.05,
  zoomDepth: 0.025,
  zoomEnabled: true,
  panFreq: 0.07,
  panDepth: 6,
  panEnabled: true,
  depthMultiplier: 1.0,
})
const active = ref(false)

let rafId: number | null = null
let startTime: number | null = null

function tick(ts: number) {
  if (startTime === null) startTime = ts
  const t = (ts - startTime) / 1000
  const dm = config.depthMultiplier

  values.opacity = config.opacityEnabled
    ? 1 - config.opacityDepth * dm + config.opacityDepth * dm * Math.sin(2 * Math.PI * config.opacityFreq * t)
    : 1

  values.zoom = config.zoomEnabled
    ? 1 + config.zoomDepth * dm * Math.sin(2 * Math.PI * config.zoomFreq * t)
    : 1

  values.panX = config.panEnabled
    ? config.panDepth * dm * Math.sin(2 * Math.PI * config.panFreq * t)
    : 0

  values.panY = config.panEnabled
    ? config.panDepth * dm * 0.7 * Math.cos(2 * Math.PI * config.panFreq * t * 1.3)
    : 0

  rafId = requestAnimationFrame(tick)
}

export function useLFO() {
  function start() {
    if (rafId !== null) return
    active.value = true
    rafId = requestAnimationFrame(tick)
  }

  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
      startTime = null
    }
    active.value = false
    values.opacity = 1
    values.zoom = 1
    values.panX = 0
    values.panY = 0
  }

  // Link LFO speed to beat frequency (maps 0–40 Hz beat delta → 0.04–0.15 Hz LFO rate)
  function syncToFreq(beatHz: number) {
    const t = Math.min(1, beatHz / 40)
    config.zoomFreq = 0.04 + t * 0.1
    config.opacityFreq = 0.05 + t * 0.09
    config.panFreq = 0.05 + t * 0.07
  }

  return { values, config, active, start, stop, syncToFreq }
}
