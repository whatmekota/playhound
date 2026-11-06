/**
 * Writing funscripts: the other half of funscriptParser.
 *
 * Saving an edited axis goes back into the file it came from, in whatever
 * layout that file uses (single axis, merged `metadata.axes`, a top-level
 * `axes` array, or Funscript 2.0 `channels`), keeping everything else in it
 * (metadata, chapters, the author's own fields) as it was. Positions are
 * 0–1 inside the app and whole 0–100 in a file.
 */

import { suffixToAxis } from './axisMap'

export interface WritablePoint {
  at: number
  pos: number
}

export interface FileAction {
  at: number
  pos: number
}

/**
 * App points (pos 0–1) as file actions: whole ms, whole positions 0–100, in
 * time order, one per millisecond (the last one wins, as when played).
 */
export function toFileActions(points: readonly WritablePoint[]): FileAction[] {
  const out: FileAction[] = []
  const sorted = points.every((p, i) => i === 0 || points[i - 1].at <= p.at)
    ? points
    : [...points].sort((a, b) => a.at - b.at)
  for (const p of sorted) {
    if (!Number.isFinite(p.at) || !Number.isFinite(p.pos))
      continue
    const at = Math.max(0, Math.round(p.at))
    const pos = Math.max(0, Math.min(100, Math.round(p.pos * 100)))
    if (out.length && out[out.length - 1].at === at)
      out[out.length - 1].pos = pos
    else
      out.push({ at, pos })
  }
  return out
}

/** A fresh single-axis funscript. `metadata` is copied in when given. */
export function newFunscript(points: readonly WritablePoint[], metadata?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { version: '1.0', inverted: false, range: 100, actions: toFileActions(points) }
  if (metadata && Object.keys(metadata).length)
    out.metadata = metadata
  return out
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The file `raw` (as parsed JSON) with the axes in `axes` replaced: keys are
 * the axis keys the parser gave them (`ParsedAxis.axisKey`: "default" for the
 * main stroke of a single or merged file, otherwise the name the file uses).
 * The input is left alone.
 */
export function writeAxes(raw: unknown, axes: ReadonlyMap<string, readonly WritablePoint[]>): Record<string, unknown> {
  const out: Record<string, any> = isObj(raw) ? JSON.parse(JSON.stringify(raw)) : { version: '1.0' }
  for (const [key, points] of axes)
    writeOne(out, key, toFileActions(points))
  return out
}

function writeOne(out: Record<string, any>, key: string, actions: FileAction[]) {
  // The layouts in the order the parser tries them, so an axis is written
  // where it was read from.
  if (isObj(out.metadata) && Array.isArray(out.metadata.axes)) {
    const hit = out.metadata.axes.find((a: any) => isObj(a) && (a.id ?? a.name ?? 'default') === key)
    if (hit)
      hit.actions = actions
    else if (key === 'default')
      out.actions = actions
    else
      out.metadata.axes.push({ id: key, actions })
    return
  }
  if (isObj(out.channels) && Object.values(out.channels).some((c: any) => Array.isArray(c?.actions) && c.actions.length)) {
    const name = Object.keys(out.channels).find(n => n.toLowerCase() === key)
    if (name && isObj(out.channels[name])) {
      out.channels[name].actions = actions
      // The stroke is in two places in such a file: single-axis players read
      // the top-level list, so keep it the same.
      if (suffixToAxis(key).channel === 'L0' && Array.isArray(out.actions))
        out.actions = actions
    }
    else if (key === 'default') {
      out.actions = actions
    }
    else {
      out.channels[key] = { actions }
    }
    return
  }
  if (Array.isArray(out.axes) && out.axes.length) {
    if (key === 'default') {
      out.actions = actions
      return
    }
    const hit = out.axes.find((a: any) => isObj(a) && String(a.id ?? a.name ?? '').toLowerCase() === key)
    if (hit)
      hit.actions = actions
    else
      out.axes.push({ id: key, actions })
    return
  }
  // A single-axis file: its one axis is the top-level list, whatever the
  // file's name says it drives.
  out.actions = actions
}

/** As written to disk: compact, like nearly every funscript out there. */
export function stringifyFunscript(script: unknown): string {
  return JSON.stringify(script)
}
