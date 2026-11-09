/**
 * Session control for plugins (ctx.session), the parts that need no clock:
 * where an intensity a plugin asks for ends up, and how fast it gets there.
 *
 * The user owns the limit: "Plugins may set intensity up to N%" in
 * Settings → Plugins. A plugin never sets more than that, and never jumps:
 * the knob moves a little at a time, and the user turning it themselves, or
 * panic, stops the move where it is.
 */

/** The limit until the user picks one. */
export const DEFAULT_PLUGIN_INTENSITY_MAX = 0.8
/** Up: 10% a second, so a plugin takes the knob from 30% to 80% in five seconds. */
export const RAMP_UP_PER_SEC = 0.1
/** Down is safe, so quicker. */
export const RAMP_DOWN_PER_SEC = 0.25
/** The knob's own range. */
export const KNOB_MIN = 0.1
export const KNOB_MAX = 1

/** The user's limit, kept within the knob's range. */
export function clampLimit(max: unknown): number {
  const m = typeof max === 'number' && Number.isFinite(max) ? max : DEFAULT_PLUGIN_INTENSITY_MAX
  return Math.round(Math.max(KNOB_MIN, Math.min(KNOB_MAX, m)) * 100) / 100
}

/** Where a plugin's 0–1 ends up: within the knob's range and the user's limit, to the percent. Null for nonsense. */
export function pluginTarget(want: unknown, max: number): number | null {
  if (typeof want !== 'number' || !Number.isFinite(want))
    return null
  return Math.round(Math.max(KNOB_MIN, Math.min(clampLimit(max), want)) * 100) / 100
}

/**
 * One step of a ramp from `current` toward `target`, `dtMs` later. Not
 * rounded: the caller keeps the exact value and rounds what it shows, so
 * short steps still add up.
 */
export function rampStep(current: number, target: number, dtMs: number): number {
  const up = target > current
  const most = (up ? RAMP_UP_PER_SEC : RAMP_DOWN_PER_SEC) * Math.max(0, dtMs) / 1000
  return up ? Math.min(target, current + most) : Math.max(target, current - most)
}
