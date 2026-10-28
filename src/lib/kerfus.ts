import type { FaceExpression } from '~/lib/faceState'

/**
 * Kerfus: the cat robot face (Pudu's BellaBot, "Kerfuś" in Polish shops, the
 * Kerfur in Voices of the Void), as the second face style.
 *
 * Line art in one colour on black: ring eyes with a dark pupil that slides
 * around inside them, bean brows, a dot nose over an ω mouth and two whiskers
 * a side. The expressions are the ones the robot is known for: `> <`, the
 * wink, sad bars with a tear, sleepy lines, hearts.
 *
 * Geometry is in CYD screen pixels (320×240, the face kept within y 32-168 so
 * the status line sits above it and the control bar below). The screen face
 * shows the same box scaled up. firmware/cyd-face/kerfus.cpp draws from the
 * same numbers and the same pose table; keep the two in step by hand.
 */

export const KERFUS_BOX = { x: 0, y: 30, w: 320, h: 140 } as const

export const KERFUS = {
  eyeL: 84,
  eyeR: 236,
  eyeY: 100,
  /** Outer radius of the ring eye, and of the pupil inside it. */
  eyeR0: 46,
  pupilR: 35,
  /** The focused eye's flat top, as a fraction of the radius above centre. */
  lidCut: 0.3,

  browL: 124,
  browR: 196,
  browY: 42,
  browRx: 14,
  browRy: 5.5,

  noseY: 118,
  noseRx: 8,
  noseRy: 5.5,

  /** ω: two half rings side by side. */
  mouthY: 128,
  mouthGap: 13,
  mouthR: 13,
  mouthT: 6,

  /** Whiskers: capsules at the outer edges, fanned. */
  whiskerX: 16,
  whiskerY: [136, 154],
  whiskerLen: 24,
  whiskerT: 8,
  whiskerTilt: 12,

  /** Line weight of the chevrons and bars. */
  lineT: 11,
} as const

export type KerfusEyes
  = | 'ring' // O O, the pupil follows the gaze
    | 'lid' // ring with a flat top: intent
    | 'wink' // O <
    | 'squeeze' // > <
    | 'hearts'
    | 'sad' // drooping bars with a tear at the outer end
    | 'sleep' // flat lines
    | 'shut' // thin lines, after a panic

export type KerfusMouth = 'w' | 'm' | 'o' | 'flat'

export interface KerfusPose {
  eyes: KerfusEyes
  /** Pupil radius as a fraction of KERFUS.pupilR: small is startled. */
  pupil: number
  /** Brow offset in px, negative is up, and tilt in degrees, positive drops the inner end. */
  browDy: number
  browTilt: number
  mouth: KerfusMouth
  /** Pink dashes under the eyes. */
  blush: boolean
  /** Everything dimmed: panic. */
  dim: boolean
  /** Gaze rides the stroke rather than wandering. */
  followStroke: boolean
  /** Eyes blink. Lines and chevrons do not. */
  blinks: boolean
}

export interface KerfusInput {
  expr: FaceExpression | null
  panicked: boolean
  /** An edge is holding things back. */
  edging: boolean
  intensity: number
  /** Heart eyes: 'auto' for the standalone heart look, 'always', or 'never' (the default). */
  hearts?: 'auto' | 'always' | 'never'
}

/**
 * The look for this moment. Without an expression from the app (the CYD's
 * standalone modes) intensity picks one off the same ladder the app uses.
 */
export function kerfusPose(i: KerfusInput): KerfusPose {
  const base: KerfusPose = { eyes: 'ring', pupil: 1, browDy: 0, browTilt: 0, mouth: 'w', blush: false, dim: false, followStroke: false, blinks: true }
  if (i.panicked)
    return { ...base, eyes: 'shut', mouth: 'flat', dim: true, blinks: false, browDy: 4 }
  if (i.edging)
    return { ...base, eyes: 'sad', mouth: 'm', browDy: -2, browTilt: -16, blinks: false }

  const expr = i.expr ?? ladder(i.intensity)
  const hearts = i.hearts === 'always' || (i.hearts === 'auto' && i.expr === null && i.intensity > 0.72)
  if (hearts && expr !== 'sleepy' && expr !== 'shocked')
    return { ...base, eyes: 'hearts', blush: true, blinks: false }

  switch (expr) {
    case 'sleepy':
      return { ...base, eyes: 'sleep', browDy: 6, blinks: false }
    case 'focused':
      return { ...base, eyes: 'lid', browDy: 4, browTilt: 14, followStroke: true }
    case 'excited':
      return { ...base, eyes: 'wink', browDy: -3, followStroke: true, blinks: false } // a winking eye blinking reads oddly
    case 'flustered':
      return { ...base, eyes: 'squeeze', blush: true, blinks: false }
    case 'shocked':
      return { ...base, pupil: 0.5, browDy: -7, mouth: 'o' }
    default:
      return base
  }
}

function ladder(x: number): FaceExpression {
  return x >= 0.82 ? 'flustered' : x >= 0.6 ? 'excited' : x >= 0.35 ? 'focused' : 'calm'
}

/** Colours the robots come in. */
export const KERFUS_COLORS = {
  blue: '#3da5ff',
  cyan: '#22e3e8',
  pink: '#ff6fb8',
  green: '#34d24c',
} as const
export type KerfusColor = keyof typeof KERFUS_COLORS
export const KERFUS_BLUSH = '#ff6fb8'
