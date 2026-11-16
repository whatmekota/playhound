<script setup lang="ts">
import type { VrEye, VrFormat, VrLayout } from '~/lib/vrFormat'
import * as THREE from 'three'
/**
 * SbsViewer — VR viewer using Three.js
 *
 * Takes a <video> element as prop, shows one eye's part (the left or right
 * half, the top or bottom, or the whole frame for mono) on the inside of a
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

const props = defineProps<{ videoEl: HTMLVideoElement | null, format: VrFormat, eye?: VrEye, layout?: VrLayout }>()

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
/** What the last render showed, so an unchanged view isn't drawn again. */
let drawn = ''
/** When the video last handed over a new frame (performance.now()). */
let frameSeenAt = 0
let frameCb = 0
let frameCbVideo: HTMLVideoElement | null = null
/** No new-frame callback for this long while playing: the main window isn't painting (minimised, popped out), so upload by the clock. */
const FRAME_CB_STALE_MS = 150

function watchFrames(v: HTMLVideoElement | null) {
  if (frameCbVideo) {
    if (frameCb)
      frameCbVideo.cancelVideoFrameCallback(frameCb)
    frameCbVideo.removeEventListener('loadeddata', rearmFrames)
  }
  frameCb = 0
  frameCbVideo = v && 'requestVideoFrameCallback' in v ? v : null
  if (frameCbVideo) {
    frameCb = frameCbVideo.requestVideoFrameCallback(onVideoFrame)
    // A reload (the pop-out carrying the video to its window) drops the callback.
    frameCbVideo.addEventListener('loadeddata', rearmFrames)
  }
}

function onVideoFrame() {
  frameSeenAt = performance.now()
  frameCb = frameCbVideo?.requestVideoFrameCallback(onVideoFrame) ?? 0
}

function rearmFrames() {
  if (!frameCbVideo)
    return
  if (frameCb)
    frameCbVideo.cancelVideoFrameCallback(frameCb)
  frameCb = frameCbVideo.requestVideoFrameCallback(onVideoFrame)
}

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
// A click plays or pauses; a drag looks around. Anything that moved more than
// a few pixels from where it was pressed, or was held down, is a drag: a slow
// drag moves only a pixel or two between events, and counting those one by
// one made looking around pause the video.
const CLICK_SLOP_PX = 6
const CLICK_MAX_MS = 350
const dragging = ref(false)
let lastX = 0
let lastY = 0
let downX = 0
let downY = 0
let downAt = 0
let didDrag = false

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0)
    return
  dragging.value = true
  didDrag = false
  lastX = downX = e.clientX
  lastY = downY = e.clientY
  downAt = performance.now()
  canvasRef.value?.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value)
    return
  const dx = e.clientX - lastX
  const dy = e.clientY - lastY
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_SLOP_PX)
    didDrag = true
  const sensitivity = fov / 500 // slower when zoomed in
  yaw -= dx * sensitivity
  pitch += dy * sensitivity
  pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch))
  lastX = e.clientX
  lastY = e.clientY
}

function onPointerUp(e: PointerEvent) {
  if (!dragging.value)
    return
  dragging.value = false
  canvasRef.value?.releasePointerCapture(e.pointerId)
  if (e.type === 'pointerup' && !didDrag && performance.now() - downAt < CLICK_MAX_MS)
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
uniform vec4 eyeRect;
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
  gl_FragColor = texture2D(map, eyeRect.xy + uv * eyeRect.zw);
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
  watchFrames(props.videoEl)
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
      eyeRect: { value: new THREE.Vector4(0, 0, 0.5, 1) },
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
  // Texture v runs bottom to top (flipY), so the top half is 0.5–1.
  const right = props.eye === 'right'
  const rect = mat.uniforms.eyeRect.value as THREE.Vector4
  if (props.layout === 'tb')
    rect.set(0, right ? 0 : 0.5, 1, 0.5)
  else if (props.layout === 'mono')
    rect.set(0, 0, 1, 1)
  else
    rect.set(right ? 0.5 : 0, 0, 0.5, 1)
  drawn = ''
}

function startLoop() {
  function loop() {
    rafId = requestFrame(loop)
    if (!renderer || !scene || !camera)
      return

    // The texture uploads each new video frame by itself (it listens for
    // them). Forcing it every screen frame too re-sent an 8K frame two or
    // three times over on a fast screen, which is what made big VR files
    // stutter. Forced only when those callbacks aren't coming (no support,
    // or the main window isn't painting while popped out), and once after a
    // fresh start or a seek while paused, or a paused video shows black.
    const v = props.videoEl
    if (texture && v && v.readyState >= 2 && v.currentTime !== uploadedAt) {
      const callbacks = frameCbVideo === v && performance.now() - frameSeenAt < FRAME_CB_STALE_MS
      if (v.paused || !callbacks) {
        texture.needsUpdate = true
        uploadedAt = v.currentTime
      }
    }

    // Apply yaw/pitch to camera
    const yawRad = THREE.MathUtils.degToRad(yaw)
    const pitchRad = THREE.MathUtils.degToRad(pitch)
    // Convert spherical to look-at direction
    const x = Math.sin(yawRad) * Math.cos(pitchRad)
    const y = Math.sin(pitchRad)
    const z = -Math.cos(yawRad) * Math.cos(pitchRad) // negative Z = forward
    camera.lookAt(x, y, z)

    // Nothing new to show (paused, not looking around): skip the draw.
    const state = `${texture?.version}|${yaw}|${pitch}|${fov}|${camera.aspect}`
    if (state === drawn)
      return
    drawn = state
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
  drawn = ''
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
  watchFrames(null)
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
watch(() => [props.format, props.eye, props.layout], applyFormat)
</script>

<template>
  <canvas
    ref="canvasRef"
    class="h-full w-full block"
    style="touch-action: none;"
    :style="{ cursor: dragging ? 'grabbing' : 'grab' }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel.prevent="onWheel"
    @dblclick.prevent="emit('dblclick')"
  />
</template>
