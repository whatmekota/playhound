/**
 * Pieces of plugin API 4 that need no store: a library video's scripts as
 * plain data, music analyses handed to and from plugins, and saving a file
 * where the user picks.
 */
import type { LibraryScript, MusicAnalysis } from './types'
import type { SoundtrackAnalysis } from '~/lib/beatTrack'
import type { ScriptMatch } from '~/stores/libraryStore'
import { extractSuffix } from '~/lib/axisMap'
import { parseFunscriptContent } from '~/lib/funscriptParser'

/** Every axis of every script file paired with a video, positions 0–100. Files that don't parse are left out. */
export async function readLibraryScripts(videoName: string, matches: ScriptMatch[]): Promise<LibraryScript[]> {
  const out: LibraryScript[] = []
  for (const m of matches) {
    const suffix = m.suffix ?? extractSuffix(videoName, m.file.name)
    try {
      const parsed = parseFunscriptContent(await m.file.text(), m.file.name, videoName, suffix)
      for (const axis of parsed.axes) {
        out.push({
          axis: axis.channel,
          label: axis.label,
          name: m.file.name,
          actions: axis.actions.map(a => ({ at: Math.round(a.at), pos: Math.round(a.pos * 1000) / 10 })),
          alt: m.isAlt,
        })
      }
    }
    catch {}
  }
  return out
}

const numbers = (v: unknown): number[] => Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []

/** A plain copy for a plugin: no internal version, nothing shared with the cache. */
export function analysisForPlugin(a: SoundtrackAnalysis): MusicAnalysis {
  return {
    duration: a.duration,
    bpm: a.bpm,
    beats: [...a.beats],
    energy: [...a.energy],
    centroid: [...a.centroid],
    strength: [...a.strength],
    barPos: [...a.barPos],
    confidence: a.confidence,
    gaps: a.gaps.map(g => ({ start: g.start, end: g.end })),
  }
}

/**
 * An analysis a plugin hands back (music.script), checked: per-beat arrays
 * as long as the beats, filled in where short. Throws when there are no beats.
 */
export function analysisFromPlugin(a: unknown, version: number): SoundtrackAnalysis {
  const x = (a ?? {}) as Record<string, unknown>
  const beats = numbers(x.beats)
  if (!beats.length)
    throw new TypeError('music.script takes an analysis from music.analyse (it has no beats)')
  const fit = (v: unknown, fill: number) => {
    const n = numbers(v)
    return beats.map((_, i) => n[i] ?? fill)
  }
  const gaps = Array.isArray(x.gaps)
    ? x.gaps.filter((g): g is { start: number, end: number } => !!g && Number.isFinite(g.start) && Number.isFinite(g.end))
    : []
  return {
    version,
    duration: Number.isFinite(x.duration) ? Number(x.duration) : beats[beats.length - 1],
    bpm: Number.isFinite(x.bpm) ? Number(x.bpm) : 120,
    beats,
    energy: fit(x.energy, -20),
    centroid: fit(x.centroid, 10),
    strength: fit(x.strength, 1),
    barPos: fit(x.barPos, 0).map(p => Math.max(0, Math.min(3, Math.round(p)))),
    confidence: Number.isFinite(x.confidence) ? Number(x.confidence) : 1,
    gaps: gaps.map(g => ({ start: g.start, end: g.end })),
  }
}

/** A file name safe on every system, keeping its extension. */
export function safeFileName(name: unknown): string {
  // eslint-disable-next-line no-control-regex -- control characters are what it strips
  const s = String(name ?? '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').trim().slice(0, 180)
  return s || 'file'
}

/** What a plugin hands files.save, as a Blob. */
export function blobOf(data: Blob | string | Uint8Array, mime?: string): Blob {
  if (data instanceof Blob)
    return mime && !data.type ? new Blob([data], { type: mime }) : data
  if (typeof data === 'string')
    return new Blob([data], { type: mime || 'text/plain' })
  if (data instanceof Uint8Array)
    return new Blob([data as Uint8Array<ArrayBuffer>], { type: mime || 'application/octet-stream' })
  throw new TypeError('files.save takes a Blob, a string or a Uint8Array')
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000)
}

/**
 * The system's save dialog, a download where there is none. Must come from a
 * click. False when the user cancelled.
 */
export async function saveWithDialog(blob: Blob, name: string): Promise<boolean> {
  const pick = (window as any).showSaveFilePicker
  if (typeof pick !== 'function') {
    download(blob, name)
    return true
  }
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]
  let handle: FileSystemFileHandle
  try {
    handle = await pick({
      suggestedName: name,
      id: 'playhound-plugin-save',
      ...(ext ? { types: [{ description: ext.toUpperCase(), accept: { [blob.type || 'application/octet-stream']: [`.${ext}`] } }] } : {}),
    })
  }
  catch (err) {
    if ((err as DOMException)?.name === 'AbortError')
      return false
    // No dialog without a click, or a type it won't take: a download instead.
    download(blob, name)
    return true
  }
  const w = await (handle as any).createWritable()
  await w.write(blob)
  await w.close()
  return true
}
