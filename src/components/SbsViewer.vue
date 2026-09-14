<script setup lang="ts">
import * as THREE from 'three'
/**
 * SbsViewer — 180° SBS equirectangular viewer using Three.js
 *
 * Takes a <video> element as prop, samples only the LEFT half as texture,
 * maps it onto the inside of a sphere (180° equirect), and lets the user
 * pan with mouse drag and zoom with scroll wheel — like desktop YouTube 360.
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{ videoEl: HTMLVideoElement | null }>()

const emit = defineEmits<{ click: [], dblclick: [] }>()

const canvasRef = ref<HTMLCanvasElement | null>(null)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let sphere: THREE.Mesh | null = null
let texture: THREE.VideoTexture | null = null
let rafId: number | null = null

// ─── View state ───────────────────────────────────────────────────────────────
// Yaw = horizontal pan (left/right), Pitch = vertical tilt (up/down)
let yaw = 180
let pitch = 0
let fov = 90 // degrees — scroll to zoom

const MIN_FOV = 30
const MAX_FOV = 110
const PITCH_LIMIT = 85 // degrees

// ─── Mouse drag ──────────────────────────────────────────────────────────────
let dragging = false
let lastX = 0
let lastY = 0
let didDrag = false // true if mouse moved significantly during press

function onPointerDown(e: PointerEvent) {
  dragging = true
  didDrag = false
  lastX = e.clientX
  lastY = e.clientY
  canvasRef.value?.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!dragging)
    return
  const dx = e.clientX - lastX
  const dy = e.clientY - lastY
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3)
    didDrag = true
  const sensitivity = fov / 500 // slower when zoomed in
  yaw -= dx * sensitivity
  pitch += dy * sensitivity
  pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch))
  lastX = e.clientX
  lastY = e.clientY
}

function onPointerUp(e: PointerEvent) {
  dragging = false
  canvasRef.value?.releasePointerCapture(e.pointerId)
  // Only toggle play if user didn't drag
  if (!didDrag)
    emit('click')
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  fov += e.deltaY * 0.05
  fov = Math.max(MIN_FOV, Math.min(MAX_FOV, fov))
  if (camera)
    camera.fov = fov
  camera?.updateProjectionMatrix()
}

// ─── Three.js setup ───────────────────────────────────────────────────────────
function initThree() {
  if (!canvasRef.value)
    return
  const canvas = canvasRef.value
  const w = canvas.clientWidth || canvas.offsetWidth || 800
  const h = canvas.clientHeight || canvas.offsetHeight || 450

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(w, h, false)

  scene = new THREE.Scene()

  camera = new THREE.PerspectiveCamera(fov, w / h, 0.1, 1000)
  camera.position.set(0, 0, 0)

  buildSphere()
  startLoop()
}

function buildSphere() {
  if (!props.videoEl || !scene)
    return

  // Dispose old
  if (sphere) { scene.remove(sphere); sphere.geometry.dispose(); (sphere.material as THREE.Material).dispose() }
  if (texture)
    texture.dispose()

  // VideoTexture — Three.js will call texImage2D every frame automatically
  texture = new THREE.VideoTexture(props.videoEl)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.format = THREE.RGBAFormat

  // Offset + repeat to sample ONLY the left half of the SBS frame
  // Left eye occupies U: 0.0 → 0.5
  texture.offset.set(0, 0)
  texture.repeat.set(0.5, 1)

  // Sphere geometry — large, viewed from inside
  const geo = new THREE.SphereGeometry(
    500, // radius
    60, // widthSegments
    40, // heightSegments
    0, // phiStart  — start at 0
    Math.PI, // phiLength — only front 180° (half sphere)
    0,
    Math.PI, // thetaLength — full vertical
  )

  // Flip normals so we see the inside
  geo.scale(-1, 1, 1)

  const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide })
  sphere = new THREE.Mesh(geo, mat)
  scene!.add(sphere)
}

function startLoop() {
  function loop() {
    rafId = requestAnimationFrame(loop)
    if (!renderer || !scene || !camera)
      return

    // Update texture from video every frame
    if (texture && props.videoEl && !props.videoEl.paused) {
      texture.needsUpdate = true
    }

    // Apply yaw/pitch to camera
    const yawRad = THREE.MathUtils.degToRad(yaw)
    const pitchRad = THREE.MathUtils.degToRad(pitch)
    // Convert spherical to look-at direction
    const x = Math.sin(yawRad) * Math.cos(pitchRad)
    const y = Math.sin(pitchRad)
    const z = -Math.cos(yawRad) * Math.cos(pitchRad) // negative Z = forward
    camera.lookAt(x, y, z)

    renderer.render(scene, camera)
  }
  loop()
}

function onResize() {
  if (!canvasRef.value || !renderer || !camera)
    return
  const w = canvasRef.value.clientWidth
  const h = canvasRef.value.clientHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
onMounted(() => {
  initThree()
  window.addEventListener('resize', onResize)
})

onUnmounted(() => {
  if (rafId !== null)
    cancelAnimationFrame(rafId)
  window.removeEventListener('resize', onResize)
  texture?.dispose()
  sphere?.geometry.dispose()
  ;(sphere?.material as THREE.Material | undefined)?.dispose()
  renderer?.dispose()
})

// Rebuild sphere when video element changes
watch(() => props.videoEl, (el) => {
  if (el)
    buildSphere()
})
</script>

<template>
  <canvas
    ref="canvasRef"
    class="h-full w-full block"
    style="cursor: grab; touch-action: none;"
    :style="dragging ? 'cursor:grabbing' : 'cursor:grab'"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel.prevent="onWheel"
    @dblclick.prevent="emit('dblclick')"
  />
</template>
