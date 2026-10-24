import { AXIS_MAP, suffixToAxis } from './axisMap'

/**
 * Working out what a funscript actually contains, without loading it into the
 * player.
 *
 * Two shapes exist in the wild and the library has to tell them apart:
 *
 * - **multi-file**: `clip.funscript` alongside `clip.roll.funscript`,
 *   `clip.twist.funscript` and so on, one axis per file
 * - **merged**: a single `clip.funscript` holding every axis, either as
 *   `metadata.axes` or a top-level `axes` array
 *
 * A merged file is one file, so counting files calls a six-axis script
 * "single". That is what this exists to fix.
 */

export interface ScriptInfo {
  /** One file holding more than one axis. */
  merged: boolean
  /** TCode channels present, e.g. ['L0', 'R0', 'R1']. */
  channels: string[]
}

/**
 * Cheap test for the merged shape.
 *
 * Only the key matters — a single-axis script never contains one.
 */
export function looksMerged(text: string): boolean {
  // `axes` for the 1.1-style layouts, `channels` for funscript 2.0. A 2.0
  // single-axis file may carry `"channel": "stroke"` (singular), which the
  // colon-anchored plural does not match.
  return /"(?:axes|channels)"\s*:/.test(text)
}

/**
 * Channels present in a merged script.
 *
 * Mirrors what the parser does with the same two layouts, but stops at the axis
 * identifiers instead of building action arrays, so nothing large is retained.
 */
export function parseAxisChannels(text: string): string[] {
  let raw: any
  try {
    raw = JSON.parse(text)
  }
  catch {
    return []
  }

  const channels = new Set<string>()
  const addFrom = (list: unknown) => {
    if (!Array.isArray(list))
      return
    for (const axis of list) {
      const key = String(axis?.id ?? axis?.name ?? '').toLowerCase()
      if (!key)
        continue
      // Unknown suffixes fall back to L0 in the parser; do not let that
      // masquerade as a real extra axis here.
      if (!(key in AXIS_MAP))
        continue
      channels.add(suffixToAxis(key).channel)
    }
  }

  addFrom(raw?.metadata?.axes)
  addFrom(raw?.axes)
  // Funscript 2.0 names its channels as object keys instead of a list.
  if (raw?.channels && typeof raw.channels === 'object' && !Array.isArray(raw.channels)) {
    addFrom(Object.entries(raw.channels)
      .filter(([, v]) => Array.isArray((v as any)?.actions) && (v as any).actions.length > 0)
      .map(([name]) => ({ id: name })))
  }

  // Top-level actions are the stroke axis in both layouts.
  if (Array.isArray(raw?.actions) && raw.actions.length > 0)
    channels.add('L0')

  return [...channels]
}

/** Largest span we are willing to read looking for the axes key. */
const MAX_HEAD_BYTES = 8 * 1024 * 1024
const CHUNK_BYTES = 512 * 1024
/** Overlap between chunks so the key is never split across a boundary. */
const OVERLAP = 32
/** Some writers put metadata last, so check the end too. */
const TAIL_BYTES = 256 * 1024

/**
 * Scan a file for the merged marker without reading all of it when it is large.
 *
 * The previous check read only the first and last kilobyte. In a merged file
 * the axes key sits after the first actions array, which is usually hundreds of
 * kilobytes in — so it was missed, and every merged script was filed as single
 * axis.
 */
export async function sniffMergedMarker(file: File): Promise<boolean> {
  const head = Math.min(file.size, MAX_HEAD_BYTES)

  for (let start = 0; start < head; start += CHUNK_BYTES - OVERLAP) {
    const end = Math.min(head, start + CHUNK_BYTES)
    const text = await file.slice(start, end).text()
    if (looksMerged(text))
      return true
    if (end >= head)
      break
  }

  if (file.size > head + TAIL_BYTES) {
    const tail = await file.slice(file.size - TAIL_BYTES).text()
    if (looksMerged(tail))
      return true
  }

  return false
}

/**
 * Full description of one script file.
 *
 * Only files that look merged are read in full and parsed for their axis list;
 * everything else is a single stroke axis and costs nothing beyond the scan.
 */
export async function sniffScript(file: File): Promise<ScriptInfo> {
  try {
    if (!(await sniffMergedMarker(file)))
      return { merged: false, channels: ['L0'] }

    const channels = parseAxisChannels(await file.text())
    return {
      merged: channels.length > 1,
      channels: channels.length ? channels : ['L0'],
    }
  }
  catch {
    return { merged: false, channels: ['L0'] }
  }
}
