import type { PanelId, PanelState } from './xrPanel'
import type { XrDeskState, XrView } from './xrProtocol'
import * as THREE from 'three'
import { vrFormat } from './vrFormat'
import { eyeRect, VR_FRAG, VR_VERT } from './vrSphere'
import { drawPanel, isLive, PANEL_H, PANEL_METRES, PANEL_W, panelKey, regionAt } from './xrPanel'

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

function canvasTexture(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return { canvas, ctx: canvas.getContext('2d')!, tex }
}

export async function startXrScene(o: XrSceneOptions): Promise<XrScene> {
  const xr = (navigator as any).xr
  const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] })

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.xr.enabled = true
  renderer.xr.setReferenceSpaceType('local')
  // Not hidden: a headset shows the session by itself, but an emulator in a
  // desktop browser (Meta's Immersive Web Emulator) shows this canvas, moved
  // into a full-window box of its own; hidden, it showed nothing.
  renderer.domElement.style.pointerEvents = 'none'
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
  const v = o.video
  const { ctx: panelCtx, tex: panelTex } = canvasTexture(PANEL_W, PANEL_H)
  keep(panelTex)
  panelTex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  const panel = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(PANEL_METRES, PANEL_METRES * PANEL_H / PANEL_W)),
    keep(new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, toneMapped: false })),
  )
  panel.position.set(0, -0.42, -0.75)
  panel.rotation.x = -0.55
  scene.add(panel)

  let desk: XrDeskState | null = null
  let hot: PanelId | null = null
  let pressed: { id: PanelId, until: number } | null = null
  /** The time drawn: moved on a few times a second, not every frame (each redraw is a texture upload). */
  let shownTime = v.currentTime
  let drawnKey = ''
  function redraw(t: number) {
    const s: PanelState = {
      title: o.title,
      time: shownTime,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      paused: v.paused,
      desk,
      hot,
      pressed: pressed && t < pressed.until ? pressed.id : null,
    }
    const key = panelKey(s)
    if (key === drawnKey)
      return
    drawnKey = key
    drawPanel(panelCtx, s)
    panelTex.needsUpdate = true
  }

  function press(id: PanelId, along: number) {
    switch (id) {
      case 'seek':
        if (Number.isFinite(v.duration))
          v.currentTime = shownTime = along * v.duration
        break
      case 'play':
        if (v.paused)
          void v.play().catch(() => {})
        else
          v.pause()
        break
      case 'back':
        v.currentTime = shownTime = Math.max(0, v.currentTime - 15)
        break
      case 'forward':
        v.currentTime = shownTime = Math.min(v.duration || Infinity, v.currentTime + 15)
        break
      case 'knobDown':
      case 'knobUp':
      case 'edge':
        o.onAction(id)
        break
      case 'panic':
        v.pause()
        o.onAction('panic')
        break
      case 'exit':
        void endSession()
        break
    }
  }

  // ── Controllers ──────────────────────────────────────────────────────────
  const raycaster = new THREE.Raycaster()
  const rayGeo = keep(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]))
  const rayMat = keep(new THREE.LineBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.35 }))
  const rayHotMat = keep(new THREE.LineBasicMaterial({ color: 0xF0ABFC, transparent: true, opacity: 0.8 }))
  // A ring, not a dot: it shouldn't read as part of the icon under it.
  const dotGeo = keep(new THREE.RingGeometry(0.0045, 0.0068, 28))
  const dotMat = keep(new THREE.MeshBasicMaterial({ color: 0xFFFFFF, depthTest: false, transparent: true, opacity: 0.95 }))
  interface Pointer {
    c: THREE.XRTargetRaySpace
    ray: THREE.Line
    dot: THREE.Mesh
    gamepad: Gamepad | null
    hit: { id: PanelId, along: number } | null
  }
  const pointers: Pointer[] = []

  function aim(p: Pointer) {
    p.hit = null
    if (panel.visible) {
      raycaster.setFromXRController(p.c)
      const found = raycaster.intersectObject(panel, false)[0]
      if (found?.uv) {
        p.dot.visible = true
        p.dot.position.copy(panel.worldToLocal(found.point.clone()))
        p.dot.position.z = 0.002
        p.ray.scale.z = found.distance
        const r = regionAt(found.uv.x, found.uv.y)
        if (r && isLive(r.id, { desk, duration: Number.isFinite(v.duration) ? v.duration : 0 }))
          p.hit = r
        p.ray.material = p.hit ? rayHotMat : rayMat
        return
      }
    }
    p.dot.visible = false
    p.ray.scale.z = 1
    p.ray.material = rayMat
  }

  function buzz(p: Pointer, strength: number, ms: number) {
    try {
      void (p.gamepad as any)?.hapticActuators?.[0]?.pulse?.(strength, ms)
    }
    catch {}
  }

  // The panel keeps out of the picture: it shows when you look down, for a
  // few seconds after entering VR or pressing a trigger, and while a ray is
  // on it. Squeeze keeps it shown, and squeeze again lets it go back to that.
  const SHOW_MS = 4000
  /** Looking further down than this (the view's y) brings it up. */
  const LOOK_DOWN = -0.34
  let shownUntil = performance.now() + SHOW_MS
  let pinned = false
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i)
    const ray = new THREE.Line(rayGeo, rayMat)
    c.add(ray)
    const dot = new THREE.Mesh(dotGeo, dotMat)
    dot.visible = false
    dot.renderOrder = 10
    panel.add(dot)
    const p: Pointer = { c, ray, dot, gamepad: null, hit: null }
    c.addEventListener('connected', (e: any) => (p.gamepad = e.data?.gamepad ?? null))
    c.addEventListener('disconnected', () => {
      p.gamepad = null
      p.dot.visible = false
    })
    c.addEventListener('selectstart', () => {
      // Hidden: a press only brings it back, so nothing is pressed unseen.
      const wasShown = panel.visible
      shownUntil = performance.now() + SHOW_MS
      if (!wasShown)
        return
      aim(p)
      if (p.hit) {
        pressed = { id: p.hit.id, until: performance.now() + 140 }
        buzz(p, 0.5, 30)
        press(p.hit.id, p.hit.along)
      }
    })
    c.addEventListener('squeezestart', () => {
      pinned = !pinned
      shownUntil = performance.now() + SHOW_MS
    })
    scene.add(c)
    pointers.push(p)
  }

  // ── Every frame ──────────────────────────────────────────────────────────
  let lastTimeAt = 0
  const look = new THREE.Vector3()
  renderer.setAnimationLoop((t: number) => {
    renderer.xr.getCamera().getWorldDirection(look)
    panel.visible = pinned || look.y < LOOK_DOWN || t < shownUntil
    let now: PanelId | null = null
    for (const p of pointers) {
      aim(p)
      if (p.hit && !now) {
        now = p.hit.id
        if (now !== hot)
          buzz(p, 0.15, 12)
      }
    }
    hot = now
    // A ray on the panel keeps it up.
    if (hot)
      shownUntil = Math.max(shownUntil, t + 1000)
    if (t - lastTimeAt > 250) {
      lastTimeAt = t
      shownTime = v.currentTime
    }
    if (panel.visible)
      redraw(t)
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
    },
  }
}
