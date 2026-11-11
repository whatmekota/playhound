/**
 * Where the emulator sits on a phone (OsrEmulator.vue in the phone layout):
 * docked (a strip above the player bar upright, a panel beside the video
 * sideways) or floating in one of the stage's corners. Floating, it is
 * dragged anywhere and snaps to the nearest corner when let go, so it never
 * ends up half off the screen or under a thumb.
 */

export type Corner = 'tl' | 'tr' | 'bl' | 'br'

export interface PhoneEmuPlacement {
  mode: 'dock' | 'float'
  corner: Corner
  /** Floating size, CSS px. */
  w: number
  h: number
}

export const PHONE_EMU_DEFAULT: PhoneEmuPlacement = { mode: 'dock', corner: 'tr', w: 168, h: 208 }
export const PHONE_EMU_MIN_W = 132
export const PHONE_EMU_MAX_W = 420
/** Height over width, kept while pinching or dragging the corner. */
export const PHONE_EMU_ASPECT = PHONE_EMU_DEFAULT.h / PHONE_EMU_DEFAULT.w
/** Gap from the stage's edges. */
export const PHONE_EMU_MARGIN = 8

export interface Area { left: number, top: number, width: number, height: number }

/** The corner nearest to a point (the window's centre when it is let go). */
export function nearestCorner(x: number, y: number, area: Area): Corner {
  const right = x > area.left + area.width / 2
  const bottom = y > area.top + area.height / 2
  return `${bottom ? 'b' : 't'}${right ? 'r' : 'l'}` as Corner
}

/** Top-left of a w×h window in `corner` of `area`, kept inside it. */
export function cornerPosition(corner: Corner, w: number, h: number, area: Area, margin = PHONE_EMU_MARGIN): { x: number, y: number } {
  const x = corner[1] === 'r' ? area.left + area.width - w - margin : area.left + margin
  const y = corner[0] === 'b' ? area.top + area.height - h - margin : area.top + margin
  return { x: Math.max(area.left, x), y: Math.max(area.top, y) }
}

/** A floating width that fits the area, the height following the aspect. */
export function fitSize(w: number, area: Area): { w: number, h: number } {
  const maxW = Math.min(PHONE_EMU_MAX_W, area.width - PHONE_EMU_MARGIN * 2, (area.height - PHONE_EMU_MARGIN * 2) / PHONE_EMU_ASPECT)
  const fw = Math.round(Math.max(PHONE_EMU_MIN_W, Math.min(w, maxW)))
  return { w: fw, h: Math.round(fw * PHONE_EMU_ASPECT) }
}
