// Axis suffix → TCode channel mapping
// Based on XTPlayer / buttplug-js / OSR2/SR6 conventions

export interface AxisDef {
  channel: string // TCode channel, e.g. "L0"
  label: string // human-readable name
  defaultPos: number // 0–1, default resting position
  isLinear: boolean
}

export const AXIS_MAP: Record<string, AxisDef> = {
  // Primary stroke axis (default funscript → L0)
  default: { channel: 'L0', label: 'Stroke', defaultPos: 0.5, isLinear: true },
  stroke: { channel: 'L0', label: 'Stroke', defaultPos: 0.5, isLinear: true },
  l0: { channel: 'L0', label: 'Stroke', defaultPos: 0.5, isLinear: true },
  // Additional linear axes
  surge: { channel: 'L1', label: 'Surge', defaultPos: 0.5, isLinear: true },
  l1: { channel: 'L1', label: 'Surge', defaultPos: 0.5, isLinear: true },
  sway: { channel: 'L2', label: 'Sway', defaultPos: 0.5, isLinear: true },
  l2: { channel: 'L2', label: 'Sway', defaultPos: 0.5, isLinear: true },
  // Rotational axes
  twist: { channel: 'R0', label: 'Twist', defaultPos: 0.5, isLinear: false },
  r0: { channel: 'R0', label: 'Twist', defaultPos: 0.5, isLinear: false },
  roll: { channel: 'R1', label: 'Roll', defaultPos: 0.5, isLinear: false },
  r1: { channel: 'R1', label: 'Roll', defaultPos: 0.5, isLinear: false },
  pitch: { channel: 'R2', label: 'Pitch', defaultPos: 0.5, isLinear: false },
  r2: { channel: 'R2', label: 'Pitch', defaultPos: 0.5, isLinear: false },
  // Vibration axes
  vib: { channel: 'V0', label: 'Vibrate', defaultPos: 0.0, isLinear: false },
  vibrate: { channel: 'V0', label: 'Vibrate', defaultPos: 0.0, isLinear: false },
  v0: { channel: 'V0', label: 'Vibrate', defaultPos: 0.0, isLinear: false },
  suck: { channel: 'A0', label: 'Suction', defaultPos: 0.0, isLinear: false },
  a0: { channel: 'A0', label: 'Suction', defaultPos: 0.0, isLinear: false },
  pump: { channel: 'A1', label: 'Pump', defaultPos: 0.0, isLinear: false },
  a1: { channel: 'A1', label: 'Pump', defaultPos: 0.0, isLinear: false },
}

// Priority order for display
export const AXIS_PRIORITY = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2', 'V0', 'A0', 'A1']

/**
 * Given a filename suffix (the part between the base name and .funscript),
 * return the matching AxisDef, or the default (L0 stroke) if not found.
 */
export function suffixToAxis(suffix: string): AxisDef {
  const normalized = suffix.toLowerCase().trim()
  return AXIS_MAP[normalized] ?? AXIS_MAP.default
}

/**
 * Extract suffix from a funscript filename relative to a video basename.
 * e.g. video.funscript → 'default'
 *      video.twist.funscript → 'twist'
 *      video.L0.funscript → 'l0'
 */
export function extractSuffix(videoBasename: string, scriptFilename: string): string {
  // Remove extension
  const base = scriptFilename.replace(/\.funscript$/i, '')
  const videoBase = videoBasename.replace(/\.[^.]+$/, '') // strip video extension

  if (base.toLowerCase() === videoBase.toLowerCase()) {
    return 'default'
  }

  // Check if it starts with videoBase
  const prefix = `${videoBase}.`
  if (base.toLowerCase().startsWith(prefix.toLowerCase())) {
    return base.slice(prefix.length)
  }

  return 'default'
}
