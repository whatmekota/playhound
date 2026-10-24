import type { AxisDef } from './axisMap'
import { extractSuffix, suffixToAxis } from './axisMap'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FunscriptAction {
  at: number // milliseconds
  pos: number // 0–100 (raw), stored as 0–1 internally after normalization
}

export interface ParsedAxis {
  channel: string
  axisKey: string
  label: string
  axisDef: AxisDef
  actions: FunscriptAction[] // sorted by .at, pos in 0–1 range
  filePath: string
  duration: number // ms, last action time
}

export interface ParsedFunscript {
  axes: ParsedAxis[]
  /** True if this is a merged multi-axis script */
  isMerged: boolean
  rawMetadata?: Record<string, unknown>
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a single .funscript file content.
 * Supports:
 *   - Standard single-axis: { version, actions: [{at, pos}] }
 *   - Merged multi-axis (metadata.axes style): { metadata: { axes: [...] }, ... }
 *   - Merged multi-axis (top-level axes style): { actions: [...], axes: [{ id, actions },...] }
 *   - Funscript 2.0: { actions: [...], channels: { roll: { actions }, ... } }
 */
export function parseFunscriptContent(
  content: string,
  filePath: string,
  videoBasename: string,
  explicitSuffix?: string,
): ParsedFunscript {
  let raw: any
  try {
    raw = JSON.parse(content)
  }
  catch {
    throw new Error(`Invalid JSON in funscript: ${filePath}`)
  }

  // ── Merged multi-axis format (metadata.axes style) ───────────────────────
  if (raw.metadata?.axes && Array.isArray(raw.metadata.axes)) {
    const axes: ParsedAxis[] = []
    for (const axisData of raw.metadata.axes) {
      const axisKey = axisData.id ?? axisData.name ?? 'default'
      const axisDef = suffixToAxis(axisKey)
      const actions = normalizeActions(
        Array.isArray(axisData.actions) ? axisData.actions : [],
      )
      axes.push({
        channel: axisDef.channel,
        axisKey,
        label: axisDef.label,
        axisDef,
        actions,
        filePath,
        duration: actions.length > 0 ? actions[actions.length - 1].at : 0,
      })
    }

    // Also parse top-level actions as L0 if no L0 axis in metadata
    const hasL0 = axes.some(a => a.channel === 'L0')
    if (!hasL0 && Array.isArray(raw.actions) && raw.actions.length > 0) {
      const axisDef = suffixToAxis('default')
      const actions = normalizeActions(raw.actions)
      axes.unshift({
        channel: 'L0',
        axisKey: 'default',
        label: axisDef.label,
        axisDef,
        actions,
        filePath,
        duration: actions.length > 0 ? actions[actions.length - 1].at : 0,
      })
    }

    return { axes, isMerged: true, rawMetadata: raw.metadata }
  }

  // ── Funscript 2.0 (named channels object) ────────────────────────────────
  // e.g. { version: "2.0", actions: [...], channels: { roll: { actions }, ... } }
  // What funlib's merge writes for multi-axis scripts. When both `actions` and
  // `channels.stroke` exist, the spec says multi-axis devices should prefer
  // channels.stroke — which is what this app drives.
  if (raw.channels && typeof raw.channels === 'object' && !Array.isArray(raw.channels)) {
    const axes: ParsedAxis[] = []
    const add = (axisKey: string, list: unknown) => {
      const axisDef = suffixToAxis(axisKey)
      if (axes.some(a => a.channel === axisDef.channel) || !Array.isArray(list) || !list.length)
        return
      const actions = normalizeActions(list)
      axes.push({
        channel: axisDef.channel,
        axisKey,
        label: axisDef.label,
        axisDef,
        actions,
        filePath,
        duration: actions.length > 0 ? actions[actions.length - 1].at : 0,
      })
    }
    for (const [name, data] of Object.entries(raw.channels as Record<string, { actions?: unknown }>)) {
      if (suffixToAxis(name.toLowerCase()).channel === 'L0')
        add(name.toLowerCase(), data?.actions)
    }
    add('default', raw.actions)
    for (const [name, data] of Object.entries(raw.channels as Record<string, { actions?: unknown }>))
      add(name.toLowerCase(), data?.actions)
    if (axes.length > 0)
      return { axes, isMerged: axes.length > 1, rawMetadata: raw.metadata }
  }

  // ── Merged multi-axis format (top-level axes array style) ─────────────────
  // e.g. { actions: [...L0...], axes: [{ id: "L1", actions: [...] }, ...] }
  if (Array.isArray(raw.axes) && raw.axes.length > 0) {
    const axes: ParsedAxis[] = []

    // Top-level actions = L0 stroke axis
    if (Array.isArray(raw.actions) && raw.actions.length > 0) {
      const axisDef = suffixToAxis('default')
      const actions = normalizeActions(raw.actions)
      axes.push({
        channel: 'L0',
        axisKey: 'default',
        label: axisDef.label,
        axisDef,
        actions,
        filePath,
        duration: actions.length > 0 ? actions[actions.length - 1].at : 0,
      })
    }

    // Additional axes from the top-level "axes" array
    for (const axisData of raw.axes) {
      const axisKey = ((axisData.id ?? axisData.name ?? '') as string).toLowerCase()
      if (!axisKey)
        continue
      const axisDef = suffixToAxis(axisKey)
      const actions = normalizeActions(
        Array.isArray(axisData.actions) ? axisData.actions : [],
      )
      // Skip if this channel is already present (avoid duplicate L0)
      if (axes.some(a => a.channel === axisDef.channel))
        continue
      axes.push({
        channel: axisDef.channel,
        axisKey,
        label: axisDef.label,
        axisDef,
        actions,
        filePath,
        duration: actions.length > 0 ? actions[actions.length - 1].at : 0,
      })
    }

    if (axes.length > 0) {
      return { axes, isMerged: true, rawMetadata: raw.metadata }
    }
  }

  // ── Standard single-axis format ───────────────────────────────────────────
  const suffix = explicitSuffix ?? extractSuffix(videoBasename, getFilename(filePath))
  const axisDef = suffixToAxis(suffix)
  const actions = normalizeActions(Array.isArray(raw.actions) ? raw.actions : [])

  return {
    axes: [{
      channel: axisDef.channel,
      axisKey: suffix,
      label: axisDef.label,
      axisDef,
      actions,
      filePath,
      duration: actions.length > 0 ? actions[actions.length - 1].at : 0,
    }],
    isMerged: false,
  }
}

/**
 * Normalize raw actions: sort by time, clamp pos to 0–100, convert to 0–1
 */
function normalizeActions(raw: any[]): FunscriptAction[] {
  return raw
    .filter(a => typeof a.at === 'number' && typeof a.pos === 'number')
    .map(a => ({
      at: Math.max(0, a.at),
      pos: Math.max(0, Math.min(1, a.pos / 100)),
    }))
    .sort((a, b) => a.at - b.at)
}

function getFilename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
}

// ─── Binary search interpolation ─────────────────────────────────────────────

/**
 * Get the interpolated position (0–1) for a given time (ms) from sorted actions.
 */
export function interpolatePosition(actions: FunscriptAction[], timeMs: number): number {
  if (actions.length === 0)
    return 0.5
  if (timeMs <= actions[0].at)
    return actions[0].pos
  if (timeMs >= actions[actions.length - 1].at)
    return actions[actions.length - 1].pos

  // Binary search for the surrounding pair
  let lo = 0
  let hi = actions.length - 1

  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (actions[mid].at <= timeMs)
      lo = mid
    else hi = mid
  }

  const a0 = actions[lo]
  const a1 = actions[hi]
  const t = (timeMs - a0.at) / (a1.at - a0.at)
  return a0.pos + (a1.pos - a0.pos) * t
}

/**
 * Get the next action time after the given time
 */
export function nextActionAt(actions: FunscriptAction[], timeMs: number): number | null {
  for (let i = 0; i < actions.length; i++) {
    if (actions[i].at > timeMs)
      return actions[i].at
  }
  return null
}
