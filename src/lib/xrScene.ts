import type { XrDeskState, XrView } from './xrProtocol'
import * as THREE from 'three'
import { vrFormat } from './vrFormat'
import { eyeRect, VR_FRAG, VR_VERT } from './vrSphere'

/**
 * The headset player's VR: the video around you (one sphere per eye, each
 * drawing its half of the frame) or, for a flat video, on a big screen in
 * front; and a small panel at chest height, pointed at with a controller:
 * play and pause, seek, the intensity knob, an edge, panic and leaving VR.
 * The squeeze button hides and shows the panel.
 *
 * The <video> stays the page's (pages/xr.vue): this only draws it, and plays,
 * pauses and seeks it from the panel.
 */

export type XrAction = 'knobUp' | 'knobDown' | 'edge' | 'panic'

export interface XrSceneOptions {
  video: HTMLVideoElement
  view: XrView
  title: string
  onAction: (a: XrAction) => void
  /** VR is over (left from the panel, the headset's own menu, or the session lost). */
  onEnd: () => void
}

export interface XrScene {
  end: () => Promise<void>
  /** The computer's side, for the panel's status line. */
  setDesk: (s: XrDeskState | null) => void
}

/** Whether this browser can do immersive VR (a headset's, with WebXR). */
export async function supportsVr(): Promise<boolean> {
  try {
    return !!(navigator as any).xr && await (navigator as any).xr.isSessionSupported('immersive-vr')
  }
  catch {
    return false
  }
}

const SPHERE_R = 50
/** The flat screen: this wide, this far in front. */
const SCREEN_W = 3.2
const SCREEN_Z = -3

interface Button {
  mesh: THREE.Mesh
  /** Pressed, with where along it (0–1), for the seek bar. */
  press: (u: number) => void
  draw: (hot: boolean) => void
}

function canvasTexture(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return { canvas, ctx: canvas.getContext('2d')!, tex }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function fmt(s: number) {
  if (!Number.isFinite(s) || s < 0)
    return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export async function startXrScene(o: XrSceneOptions): Promise<XrScene> {
  const xr = (navigator as any).xr
  const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] })

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.xr.enabled = true
  renderer.xr.setReferenceSpaceType('local')
  renderer.domElement.style.display = 'none'
  document.body.appendChild(renderer.domElement)
  await renderer.xr.setSession(session)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x050507)
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 1000)
  const disposables: { dispose: () => void }[] = []
  const keep = <T extends { dispose: () => void }>(x: T) => {
    disposables.push(x)
    return x
  }

  // ── The video ────────────────────────────────────────────────────────────
  const texture = keep(new THREE.VideoTexture(o.video))
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false

  if (o.view.on) {
    const format = vrFormat(o.view.format)
    // One sphere per eye, each seen only by its eye (three's XR cameras: layer 1 left, 2 right).
    const eyes: [number, 'left' | 'right'][] = o.view.layout === 'mono' ? [[0, 'left']] : [[1, 'left'], [2, 'right']]
    const geo = keep(new THREE.SphereGeometry(SPHERE_R, 96, 64))
    for (const [layer, eye] of eyes) {
      const mat = keep(new THREE.ShaderMaterial({
        uniforms: {
          map: { value: texture },
          halfFov: { value: THREE.MathUtils.degToRad(format.fov / 2) },
          fisheye: { value: format.projection === 'fisheye' },
          eyeRect: { value: new THREE.Vector4(...eyeRect(o.view.layout, eye)) },
        },
        vertexShader: VR_VERT,
        fragmentShader: VR_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
      }))
      const sphere = new THREE.Mesh(geo, mat)
      sphere.layers.set(layer)
      sphere.renderOrder = -1
      scene.add(sphere)
    }
  }
  else {
    const aspect = o.video.videoWidth && o.video.videoHeight ? o.video.videoWidth / o.video.videoHeight : 16 / 9
    const screen = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(SCREEN_W, SCREEN_W / aspect)),
      keep(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })),
    )
    screen.position.set(0, 0, SCREEN_Z)
    scene.add(screen)
  }

  // ── The panel ────────────────────────────────────────────────────────────
  const panel = new THREE.Group()
  panel.position.set(0, -0.42, -0.75)
  panel.rotation.x = -0.55
  scene.add(panel)
  const back = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(0.66, 0.27)),
    keep(new THREE.MeshBasicMaterial({ color: 0x0E0E12, transparent: true, opacity: 0.86 })),
  )
  back.position.z = -0.002
  panel.add(back)

  const buttons: Button[] = []
  let desk: XrDeskState | null = null

  /** A drawn rectangle on the panel; `label` is redrawn whenever asked. */
  function addButton(x: number, y: number, w: number, h: number, label: () => string, press: (u: number) => void, tone: () => string = () => '#2a2a33') {
    const { canvas, ctx, tex } = canvasTexture(Math.round(w * 1600), Math.round(h * 1600))
    keep(tex)
    const mesh = new THREE.Mesh(keep(new THREE.PlaneGeometry(w, h)), keep(new THREE.MeshBasicMaterial({ map: tex, transparent: true })))
    mesh.position.set(x, y, 0)
    panel.add(mesh)
    const b: Button = {
      mesh,
      press,
      draw(hot) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, Math.min(28, canvas.height / 3))
        ctx.fillStyle = hot ? '#d946ef' : tone()
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.font = `600 ${Math.round(canvas.height * 0.36)}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(label(), canvas.width / 2, canvas.height / 2)
        tex.needsUpdate = true
      },
    }
    b.draw(false)
    buttons.push(b)
    return b
  }

  const v = o.video
  const row1 = 0.05
  const bw = 0.07
  const gap = 0.074
  const x0 = -0.296
  addButton(x0, row1, bw, 0.06, () => (v.paused ? 'Play' : 'Pause'), () => (v.paused ? void v.play().catch(() => {}) : v.pause()))
  addButton(x0 + gap, row1, bw, 0.06, () => '−15 s', () => (v.currentTime = Math.max(0, v.currentTime - 15)))
  addButton(x0 + gap * 2, row1, bw, 0.06, () => '+15 s', () => (v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 15)))
  addButton(x0 + gap * 3, row1, bw, 0.06, () => 'Int −', () => o.onAction('knobDown'))
  addButton(x0 + gap * 4, row1, bw, 0.06, () => 'Int +', () => o.onAction('knobUp'))
  const edgeBtn = addButton(x0 + gap * 5, row1, bw, 0.06, () => (desk?.edge && desk.edge !== 'idle' ? 'Edging' : 'Edge'), () => o.onAction('edge'), () => (desk?.edge && desk.edge !== 'idle' ? '#b45309' : '#2a2a33'))
  addButton(x0 + gap * 6, row1, bw, 0.06, () => 'Panic', () => {
    v.pause()
    o.onAction('panic')
  }, () => '#be123c')
  addButton(x0 + gap * 7, row1, bw, 0.06, () => 'Exit', () => void endSession())

  // The seek bar: where along it is where in the video.
  const seek = addButton(0, -0.03, 0.6, 0.045, () => `${fmt(v.currentTime)} / ${fmt(v.duration)}`, (u) => {
    if (Number.isFinite(v.duration))
      v.currentTime = Math.max(0, Math.min(v.duration, u * v.duration))
  })
  const seekFill = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.6, 0.008)), keep(new THREE.MeshBasicMaterial({ color: 0xD946EF })))
  seekFill.position.set(0, -0.058, 0.001)
  panel.add(seekFill)

  // The status line: what plays and what the computer is doing.
  const status = addButton(0, -0.095, 0.62, 0.04, () => {
    const parts = [o.title]
    if (desk) {
      parts.push(`intensity ${Math.round(desk.knob * 100)}%`)
      parts.push(desk.scripts ? `${desk.scripts} script${desk.scripts === 1 ? '' : 's'}` : 'no script')
      if (desk.panicked)
        parts.push('PANIC on the computer')
    }
    return parts.join(' · ')
  }, () => {}, () => (desk?.panicked ? '#7f1d1d' : '#16161c'))

  // ── Controllers ──────────────────────────────────────────────────────────
  const raycaster = new THREE.Raycaster()
  const controllers: THREE.XRTargetRaySpace[] = []
  const rayGeo = keep(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]))
  const rayMat = keep(new THREE.LineBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.5 }))
  function hit(c: THREE.XRTargetRaySpace) {
    if (!panel.visible)
      return null
    raycaster.setFromXRController(c)
    const found = raycaster.intersectObjects(buttons.map(b => b.mesh), false)[0]
    return found ? { button: buttons.find(b => b.mesh === found.object)!, u: found.uv?.x ?? 0.5 } : null
  }
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i)
    c.add(new THREE.Line(rayGeo, rayMat))
    c.addEventListener('selectstart', () => {
      const h = hit(c)
      if (h && h.button !== status)
        h.button.press(h.u)
    })
    c.addEventListener('squeezestart', () => (panel.visible = !panel.visible))
    scene.add(c)
    controllers.push(c)
  }

  // ── Every frame ──────────────────────────────────────────────────────────
  let hot: Button | null = null
  let lastLabelAt = 0
  renderer.setAnimationLoop((t: number) => {
    // The button under a ray lights up.
    let now: Button | null = null
    for (const c of controllers) {
      const h = hit(c)
      if (h && h.button !== status) {
        now = h.button
        break
      }
    }
    if (now !== hot) {
      hot?.draw(false)
      now?.draw(true)
      hot = now
    }
    // Time and play state, a few times a second.
    if (t - lastLabelAt > 250) {
      lastLabelAt = t
      buttons[0].draw(hot === buttons[0])
      seek.draw(hot === seek)
      const u = v.duration ? v.currentTime / v.duration : 0
      seekFill.scale.x = Math.max(0.001, u)
      seekFill.position.x = -0.3 + 0.3 * u
    }
    renderer.render(scene, camera)
  })

  let ended = false
  function cleanup() {
    if (ended)
      return
    ended = true
    renderer.setAnimationLoop(null)
    for (const d of disposables)
      d.dispose()
    renderer.dispose()
    renderer.domElement.remove()
    o.onEnd()
  }
  session.addEventListener('end', cleanup)

  async function endSession() {
    if (ended)
      return
    try {
      await session.end()
    }
    catch {
      cleanup()
    }
  }

  return {
    end: endSession,
    setDesk(s) {
      desk = s
      edgeBtn.draw(hot === edgeBtn)
      status.draw(false)
    },
  }
}
