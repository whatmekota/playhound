// TCode protocol encoder
// Spec: https://github.com/multiaxis/tcode-spec

export interface TCodeCommand {
  channel: string
  position: number   // 0–1 normalized
  interval: number   // milliseconds
}

export interface AxisLimits {
  min: number
  max: number
  invert: boolean
}

/**
 * Encode a single TCode command string.
 * Respects tcodeVersion: 'v2' = 3-digit (000-999), 'v3' = 4-digit (0000-9999)
 */
export function encodeTCode(
  cmd: TCodeCommand,
  limits?: AxisLimits,
  version: 'v2' | 'v3' = 'v3'
): string {
  let pos = cmd.position

  if (limits) {
    if (limits.invert) pos = 1 - pos
    pos = limits.min + pos * (limits.max - limits.min)
  }

  pos = Math.max(0, Math.min(1, pos))

  let rawStr: string
  if (version === 'v2') {
    rawStr = Math.round(pos * 999).toString().padStart(3, '0')
  } else {
    rawStr = Math.round(pos * 9999).toString().padStart(4, '0')
  }

  const interval = Math.max(1, Math.min(9999, Math.round(cmd.interval)))
  return `${cmd.channel}${rawStr}I${interval}\n`
}

export function encodeHome(channel: string, defaultPos: number, interval = 500, version: 'v2' | 'v3' = 'v3'): string {
  return encodeTCode({ channel, position: defaultPos, interval }, undefined, version)
}

export function encodeBatch(cmds: TCodeCommand[], limitsMap?: Record<string, AxisLimits>, version: 'v2' | 'v3' = 'v3'): string {
  return cmds.map(cmd => encodeTCode(cmd, limitsMap?.[cmd.channel], version)).join('')
}

export function calcInterval(nextActionMs: number | null, currentMs: number, speed: number): number {
  if (nextActionMs === null) return 500
  const raw = (nextActionMs - currentMs) / speed
  return Math.max(10, Math.min(5000, Math.round(raw)))
}
