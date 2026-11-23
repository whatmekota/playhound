import type { XrDeskState } from './xrProtocol'

/**
 * The control panel in VR, drawn on one canvas (pages/xr.vue's scene puts it
 * on a plane at chest height): the title and what the computer is doing, a
 * seek bar, play and skip, the intensity knob, an edge, panic and leaving VR.
 *
 * Laid out in canvas pixels; a controller's ray gives a point on the plane
 * (its uv) and regionAt says what's there.
 */

export const PANEL_W = 1500
export const PANEL_H = 600
/** The panel's width in VR, in metres: 0.66 × 0.264 at 75 cm, big enough to read and point at. */
export const PANEL_METRES = 0.66

export type PanelId = 'seek' | 'back' | 'play' | 'forward' | 'knobDown' | 'knobUp' | 'edge' | 'panic' | 'exit'

interface Region { id: PanelId, x: number, y: number, w: number, h: number }

const M = 56
const TRACK = { x: 210, w: 1080, y: 168 }
const ROW = { y: 250, h: 150 }
const LAST = { y: 444, h: 104 }

const REGIONS: Region[] = [
  // The seek bar answers a little above and below the line, so it's easy to hit.
  { id: 'seek', x: TRACK.x - 20, y: TRACK.y - 46, w: TRACK.w + 40, h: 92 },
  { id: 'back', x: M, y: ROW.y, w: 150, h: ROW.h },
  { id: 'play', x: 222, y: ROW.y, w: 200, h: ROW.h },
  { id: 'forward', x: 438, y: ROW.y, w: 150, h: ROW.h },
  { id: 'knobDown', x: 640, y: ROW.y, w: 120, h: ROW.h },
  { id: 'knobUp', x: 960, y: ROW.y, w: 120, h: ROW.h },
  { id: 'edge', x: 1124, y: ROW.y, w: 152, h: ROW.h },
  { id: 'panic', x: 1292, y: ROW.y, w: 152, h: ROW.h },
  { id: 'exit', x: PANEL_W - M - 240, y: LAST.y, w: 240, h: LAST.h },
]

/** The intensity readout between − and +. */
const KNOB_VALUE = { x: 772, w: 176 }

/** What's at a point of the plane (three's uv: 0–1, y up), and how far along it (for seeking). */
export function regionAt(u: number, v: number): { id: PanelId, along: number } | null {
  const x = u * PANEL_W
  const y = (1 - v) * PANEL_H
  const r = REGIONS.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
  if (!r)
    return null
  return { id: r.id, along: Math.max(0, Math.min(1, (x - TRACK.x) / TRACK.w)) }
}

export interface PanelState {
  title: string
  time: number
  duration: number
  paused: boolean
  desk: XrDeskState | null
  /** Under a ray. */
  hot: PanelId | null
  /** Just pressed: flashes. */
  pressed: PanelId | null
}

/** Whether a button does anything now (edges off on the computer: no Edge). */
export function isLive(id: PanelId, s: Pick<PanelState, 'desk' | 'duration'>): boolean {
  if (id === 'edge')
    return !!s.desk && s.desk.edge !== null
  if (id === 'knobDown' || id === 'knobUp')
    return !!s.desk
  if (id === 'seek')
    return Number.isFinite(s.duration) && s.duration > 0
  return true
}

const progress = (s: Pick<PanelState, 'time' | 'duration'>) => (s.duration > 0 ? Math.max(0, Math.min(1, s.time / s.duration)) : 0)

/** Changes when the drawing would: redraw (and upload the texture) only then. */
export function panelKey(s: PanelState): string {
  const d = s.desk
  return [
    s.title,
    Math.floor(s.time),
    Math.round(progress(s) * TRACK.w),
    Math.floor(s.duration || 0),
    s.paused,
    s.hot,
    s.pressed,
    d ? `${d.knob.toFixed(2)}|${d.edge}|${d.panicked}|${d.scripts}|${d.device}` : '-',
  ].join('·')
}

const C = {
  panel: 'rgba(15, 15, 20, 0.94)',
  edge: 'rgba(255, 255, 255, 0.09)',
  button: '#25252e',
  buttonHot: '#34343f',
  text: '#f4f4f6',
  muted: '#9a9aa8',
  accent: '#d946ef',
  accentHot: '#e879f9',
  danger: '#be123c',
  dangerHot: '#e11d48',
  amber: '#b45309',
  ok: '#22c55e',
  warn: '#f59e0b',
  off: '#6b6b78',
}
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0)
    return '0:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(Math.floor(s % 60)).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** The line under the title: what the computer does with this video. */
export function deskStatus(d: XrDeskState | null): { text: string, tone: 'ok' | 'warn' | 'danger' | 'off' } {
  if (!d)
    return { text: 'Waiting for the computer', tone: 'off' }
  if (d.panicked)
    return { text: 'Panic is on: resume it on the computer', tone: 'danger' }
  if (!d.scripts)
    return { text: 'No script for this video', tone: 'off' }
  if (!d.device)
    return { text: 'No device connected on the computer', tone: 'warn' }
  return { text: `${d.scripts} script${d.scripts === 1 ? '' : 's'} on the device`, tone: 'ok' }
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

/** Cut to fit, with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max)
    return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max)
      lo = mid
    else
      hi = mid - 1
  }
  return `${text.slice(0, lo).trimEnd()}…`
}

export function drawPanel(ctx: CanvasRenderingContext2D, s: PanelState): void {
  const { desk } = s
  ctx.clearRect(0, 0, PANEL_W, PANEL_H)
  ctx.textBaseline = 'middle'

  // The panel.
  roundRect(ctx, 3, 3, PANEL_W - 6, PANEL_H - 6, 56)
  ctx.fillStyle = C.panel
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = C.edge
  ctx.stroke()

  // ── The title, and what the computer does ──────────────────────────────
  const status = deskStatus(desk)
  ctx.font = `500 30px ${FONT}`
  const statusW = Math.min(620, ctx.measureText(status.text).width) + 34
  ctx.textAlign = 'left'
  ctx.font = `650 42px ${FONT}`
  ctx.fillStyle = C.text
  ctx.fillText(fit(ctx, s.title, PANEL_W - M * 2 - statusW - 40), M, 76)

  const sx = PANEL_W - M - statusW
  ctx.beginPath()
  ctx.arc(sx + 9, 76, 9, 0, Math.PI * 2)
  ctx.fillStyle = { ok: C.ok, warn: C.warn, danger: C.dangerHot, off: C.off }[status.tone]
  ctx.fill()
  ctx.font = `500 30px ${FONT}`
  ctx.fillStyle = status.tone === 'danger' ? '#fda4af' : C.muted
  ctx.fillText(fit(ctx, status.text, 620), sx + 34, 77)

  // ── Seek ───────────────────────────────────────────────────────────────
  const seekLive = isLive('seek', s)
  const hotSeek = s.hot === 'seek' && seekLive
  ctx.font = `600 32px ui-monospace, "SF Mono", Menlo, Consolas, monospace`
  ctx.fillStyle = C.text
  ctx.textAlign = 'left'
  ctx.fillText(fmtTime(s.time), M, TRACK.y + 2)
  ctx.textAlign = 'right'
  ctx.fillStyle = C.muted
  ctx.fillText(seekLive ? fmtTime(s.duration) : '–:––', PANEL_W - M, TRACK.y + 2)

  const th = hotSeek ? 22 : 14
  roundRect(ctx, TRACK.x, TRACK.y - th / 2, TRACK.w, th, th / 2)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)'
  ctx.fill()
  const p = progress(s)
  if (p > 0) {
    roundRect(ctx, TRACK.x, TRACK.y - th / 2, Math.max(th, TRACK.w * p), th, th / 2)
    ctx.fillStyle = C.accent
    ctx.fill()
  }
  ctx.beginPath()
  ctx.arc(TRACK.x + TRACK.w * p, TRACK.y, hotSeek ? 22 : 16, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()

  // ── Buttons ────────────────────────────────────────────────────────────
  const edging = !!desk?.edge && desk.edge !== 'idle'
  for (const r of REGIONS) {
    if (r.id === 'seek')
      continue
    const live = isLive(r.id, s)
    const hot = live && s.hot === r.id
    const pressed = live && s.pressed === r.id
    let fill = hot ? C.buttonHot : C.button
    if (r.id === 'play')
      fill = hot ? C.accentHot : C.accent
    else if (r.id === 'panic')
      fill = hot ? C.dangerHot : C.danger
    else if (r.id === 'edge' && edging)
      fill = C.amber
    if (pressed)
      fill = '#ffffff'
    ctx.globalAlpha = live ? 1 : 0.35
    roundRect(ctx, r.x, r.y, r.w, r.h, 30)
    ctx.fillStyle = fill
    ctx.fill()
    if (hot && r.id !== 'play' && r.id !== 'panic') {
      ctx.lineWidth = 5
      ctx.strokeStyle = C.accent
      ctx.stroke()
    }
    const ink = pressed ? '#111114' : C.text
    drawFace(ctx, r, ink, s, edging)
    ctx.globalAlpha = 1
  }

  // The intensity between its − and +.
  const kx = KNOB_VALUE.x + KNOB_VALUE.w / 2
  ctx.textAlign = 'center'
  ctx.fillStyle = desk ? C.text : C.muted
  ctx.font = `700 50px ${FONT}`
  ctx.fillText(desk ? `${Math.round(desk.knob * 100)}%` : '–', kx, ROW.y + 64)
  ctx.font = `500 26px ${FONT}`
  ctx.fillStyle = C.muted
  ctx.fillText('intensity', kx, ROW.y + 112)

  // ── The last row ───────────────────────────────────────────────────────
  ctx.textAlign = 'left'
  ctx.font = `500 27px ${FONT}`
  ctx.fillStyle = C.muted
  ctx.fillText('Look down or press a trigger to bring this back · grip keeps it up', M, LAST.y + LAST.h / 2)
}

function drawFace(ctx: CanvasRenderingContext2D, r: Region, ink: string, s: PanelState, edging: boolean) {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  ctx.fillStyle = ink
  ctx.strokeStyle = ink
  ctx.textAlign = 'center'
  switch (r.id) {
    case 'play':
      if (s.paused) {
        ctx.beginPath()
        ctx.moveTo(cx - 20, cy - 32)
        ctx.lineTo(cx + 32, cy)
        ctx.lineTo(cx - 20, cy + 32)
        ctx.closePath()
        ctx.fill()
      }
      else {
        roundRect(ctx, cx - 26, cy - 30, 18, 60, 5)
        ctx.fill()
        roundRect(ctx, cx + 8, cy - 30, 18, 60, 5)
        ctx.fill()
      }
      break
    case 'back':
    case 'forward':
      skipIcon(ctx, cx, cy, r.id === 'forward')
      break
    case 'knobDown':
    case 'knobUp':
      ctx.lineWidth = 9
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(cx - 22, cy)
      ctx.lineTo(cx + 22, cy)
      if (r.id === 'knobUp') {
        ctx.moveTo(cx, cy - 22)
        ctx.lineTo(cx, cy + 22)
      }
      ctx.stroke()
      break
    case 'edge':
      ctx.font = `650 36px ${FONT}`
      ctx.fillText(edging ? 'Edging' : 'Edge', cx, cy - 10)
      ctx.font = `500 22px ${FONT}`
      ctx.globalAlpha *= 0.75
      ctx.fillText(s.desk?.edge === null ? 'off' : edging ? s.desk!.edge! : 'back off', cx, cy + 30)
      ctx.globalAlpha /= 0.75
      break
    case 'panic':
      ctx.font = `750 38px ${FONT}`
      ctx.fillText('Panic', cx, cy - 10)
      ctx.font = `500 22px ${FONT}`
      ctx.fillText('stop all', cx, cy + 30)
      break
    case 'exit':
      ctx.font = `600 34px ${FONT}`
      ctx.fillText('Exit VR', cx, cy + 1)
      break
  }
}

/** A circling arrow with 15 in it: back (anticlockwise) or forward. */
function skipIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, forward: boolean) {
  const R = 40
  ctx.lineWidth = 7
  ctx.lineCap = 'round'
  ctx.save()
  ctx.translate(cx, cy)
  if (!forward)
    ctx.scale(-1, 1)
  // Clockwise from the upper right round to the upper left, the gap at the top.
  const a0 = -Math.PI / 3
  const a1 = Math.PI * 4 / 3
  ctx.beginPath()
  ctx.arc(0, 0, R, a0, a1)
  ctx.stroke()
  // The arrowhead where it ends, pointing on round.
  const ex = R * Math.cos(a1)
  const ey = R * Math.sin(a1)
  const tx = -Math.sin(a1)
  const ty = Math.cos(a1)
  const nx = Math.cos(a1)
  const ny = Math.sin(a1)
  ctx.beginPath()
  ctx.moveTo(ex + tx * 18, ey + ty * 18)
  ctx.lineTo(ex - tx * 6 + nx * 15, ey - ty * 6 + ny * 15)
  ctx.lineTo(ex - tx * 6 - nx * 15, ey - ty * 6 - ny * 15)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
  ctx.font = `700 30px ${FONT}`
  ctx.textAlign = 'center'
  ctx.fillText('15', cx, cy + 2)
}
