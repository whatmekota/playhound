import type { ScriptSnapshot } from './types'
import type { ScriptFile } from '~/stores/scriptStore'
import { AXIS_MAP } from '~/lib/axisMap'

/**
 * The script side of the plugin API (ctx.scripts): copies of what is loaded,
 * and scripts a plugin hands in. Positions are 0–100 here, as in a
 * .funscript file, since that is what plugin authors know scripts as; the
 * app keeps them 0–1 inside.
 */

/** The funscript suffix for an axis a plugin names ("L0", "twist", "vib"); stroke when absent; null if unknown. */
export function axisKeyFor(axis: unknown): string | null {
  if (axis === undefined || axis === null || axis === '')
    return 'default'
  if (typeof axis !== 'string')
    return null
  const k = axis.trim().toLowerCase()
  return AXIS_MAP[k] ? k : null
}

/** A plugin's actions as a funscript's: numbers only, `at` ≥ 0 and whole, `pos` 0–100, in time order. */
export function cleanActions(actions: unknown): { at: number, pos: number }[] {
  if (!Array.isArray(actions))
    return []
  return actions
    .filter((a): a is { at: number, pos: number } => !!a && Number.isFinite(a.at) && Number.isFinite(a.pos))
    .map(a => ({ at: Math.max(0, Math.round(a.at)), pos: Math.max(0, Math.min(100, a.pos)) }))
    .sort((a, b) => a.at - b.at)
}

/** A copy of the scripts that play, for the video `video` (a file name). */
export function snapshotOf(scripts: ScriptFile[], video: string | null): ScriptSnapshot {
  return {
    video,
    axes: scripts.filter(s => s.enabled).map(s => ({
      axis: s.channel,
      label: s.label,
      name: s.filename,
      actions: s.parsed.actions.map(a => ({ at: a.at, pos: Math.round(a.pos * 1000) / 10 })),
      offsetMs: s.offsetMs ?? 0,
    })),
  }
}
