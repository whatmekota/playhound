<script setup lang="ts">
import type { VrEye, VrFormat } from '~/lib/vrFormat'
import * as THREE from 'three'
/**
 * SbsViewer — side-by-side VR viewer using Three.js
 *
 * Takes a <video> element as prop, shows one eye's half on the inside of a
 * sphere, and lets the user pan with mouse drag and zoom with scroll wheel —
 * like desktop YouTube 360. The half is unwrapped by a shader, as
 * equirectangular or fisheye at any field of view (see lib/vrFormat).
 *
 * Colour passes through untouched: the shader samples the video and writes
 * it out as is. A colour-managed material would treat the video as linear
 * light and brighten it on the way out, which washes the picture out.
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { cancelFrame, requestFrame } from '~/lib/frames'

const props = defineProps<{ videoEl: HTMLVideoElement | null, format: VrFormat, eye?: VrEye }>()

const emit = defineEmits<{ click: [], dblclick: [] }>()

const canvasRef = ref<HTMLCanvasElement | null>(null)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let sphere: THREE.Mesh | null = null
let texture: THREE.VideoTexture | null = null
let rafId: number | null = null
/** Video time of the last frame uploaded; -1 forces the next one. */
let uploadedAt = -1

// ─── View state ───────────────────────────────────────────────────────────────
// Yaw = horizontal pan (left/right), Pitch = vertical tilt (up/down).
// 0, 0 looks at the middle of the frame.
let yaw = 0
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

/** Direction from the eye, in view space where -Z is the middle of the frame. */
const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

/**
 * Where a direction lands in one eye's half of the frame (eyeX: 0 left, 0.5 right).
 *   equirect: longitude across the field of view, latitude over 180°
 *   fisheye:  equidistant, the angle off centre grows evenly to the rim
 */
const FRAG = /* glsl */`
uniform sampler2D map;
uniform float halfFov;
uniform bool fisheye;
uniform float eyeX;
varying vec3 vDir;
const float PI = 3.14159265358979;
void main() {
  vec3 d = normalize(vDir);
  vec2 uv;
  if (fisheye) {
    float theta = acos(clamp(-d.z, -1.0, 1.0));
    if (theta > halfFov) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float r = 0.5 * theta / halfFov;
    float phi = atan(d.y, d.x);
    uv = vec2(0.5 + r * cos(phi), 0.5 + r * sin(phi));
  }
  else {
    float lon = atan(d.x, -d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    if (abs(lon) > halfFov) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    uv = vec2(0.5 + 0.5 * lon / halfFov, 0.5 + lat / PI);
  }
  gl_FragColor = texture2D(map, vec2(eyeX + uv.x * 0.5, uv.y));
}`

function buildSphere() {
  if (!props.videoEl || !scene)
    return

  // Dispose old
  if (sphere) { scene.remove(sphere); sphere.geometry.dispose(); (sphere.material as THREE.Material).dispose() }
  if (texture)
    texture.dispose()
  uploadedAt = -1

  // VideoTexture — Three.js will call texImage2D every frame automatically.
  // No colour space: the samples go straight through (see the note above).
  texture = new THREE.VideoTexture(props.videoEl)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false

  // The whole sphere, seen from inside; the shader decides what each
  // direction shows, and leaves what the video does not cover black.
  const geo = new THREE.SphereGeometry(500, 96, 64)
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      halfFov: { value: 0 },
      fisheye: { value: false },
      eyeX: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
  })
  sphere = new THREE.Mesh(geo, mat)
  applyFormat()
  scene!.add(sphere)
}

function applyFormat() {
  const mat = sphere?.material as THREE.ShaderMaterial | undefined
  if (!mat)
    return
  mat.uniforms.halfFov.value = THREE.MathUtils.degToRad(props.format.fov / 2)
  mat.uniforms.fisheye.value = props.format.projection === 'fisheye'
  mat.uniforms.eyeX.value = props.eye === 'right' ? 0.5 : 0
}

function startLoop() {
  function loop() {
    rafId = requestFrame(loop)
    if (!renderer || !scene || !camera)
      return

    // Upload the video's frame: every frame while it plays, and once after
    // a seek or a fresh start while paused, or a paused video shows black.
    const v = props.videoEl
    if (texture && v && v.readyState >= 2 && (!v.paused || v.currentTime !== uploadedAt)) {
      texture.needsUpdate = true
      uploadedAt = v.currentTime
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
  if (!w || !h)
    return
  renderer.setPixelRatio(canvasRef.value.ownerDocument.defaultView?.devicePixelRatio ?? window.devicePixelRatio)
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
// The canvas, not the window: the player can be a corner, the stage, or in
// the pop-out window.
let ro: ResizeObserver | null = null
onMounted(() => {
  initThree()
  ro = new ResizeObserver(onResize)
  if (canvasRef.value)
    ro.observe(canvasRef.value)
})

onUnmounted(() => {
  if (rafId !== null)
    cancelFrame(rafId)
  ro?.disconnect()
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
watch(() => [props.format, props.eye], applyFormat)
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
