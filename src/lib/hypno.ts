/**
 * Maths for the hypnotic overlay.
 *
 * Kept separate from the canvas so the timing — which word, how bright, how far
 * around — can be tested without a rendering context.
 */

/** Which word to show, given how many pulses have elapsed. */
export function wordIndex(pulseCount: number, everyN: number, total: number): number {
  if (total <= 0)
    return -1
  const step = Math.max(1, Math.floor(everyN))
  return Math.floor(pulseCount / step) % total
}

/**
 * Opacity of a flashed word across one of its showings.
 *
 * Rises quickly, holds, then falls away — a linear fade in both directions
 * reads as a blink rather than a suggestion.
 */
export function flashOpacity(phase: number, hold = 0.35): number {
  const p = ((phase % 1) + 1) % 1
  const ramp = Math.max(0.01, (1 - hold) / 2)

  if (p < ramp)
    return smooth(p / ramp)
  if (p < ramp + hold)
    return 1
  const out = (p - ramp - hold) / ramp
  return out >= 1 ? 0 : smooth(1 - out)
}

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

/**
 * Spiral rotation in radians.
 *
 * Accumulated from the pulse phase rather than wall-clock time, so the spiral
 * turns in step with everything else and slows when the session does.
 */
export function spiralAngle(turnsElapsed: number, direction: 1 | -1 = 1): number {
  return direction * turnsElapsed * Math.PI * 2
}

/**
 * Radius of the breathing ring, 0-1 of the available space.
 *
 * Follows the breath envelope: a long exhale means the ring spends longer
 * contracting than expanding, which is the part of paced breathing that has
 * evidence behind it.
 */
export function breathRadius(phase: number, inhaleRatio = 0.4): number {
  const p = ((phase % 1) + 1) % 1
  if (p < inhaleRatio)
    return 0.35 + 0.65 * smooth(p / inhaleRatio)
  const out = (p - inhaleRatio) / (1 - inhaleRatio)
  return 0.35 + 0.65 * smooth(1 - out)
}

/** Split a user's word list into usable entries. */
export function parseWords(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map(w => w.trim())
    .filter(Boolean)
    .slice(0, 200)
}
