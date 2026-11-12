/**
 * What counts as something to play, and which scripts go with it.
 *
 * Videos and audio files (scripted ASMR, JOI audio, music with a script) pair
 * with their funscripts by name in the same way: `Track.mp3` takes
 * `Track.funscript`, `Track.roll.funscript` and `Track (soft).funscript`.
 *
 * An audio file is only worth listing with a script: a library folder that
 * also holds someone's music collection should not fill up with every song
 * in it. A video is listed either way, as it always was.
 *
 * Vue-free so it is unit tested directly.
 */
import type { ScriptMatch } from '~/stores/libraryStore'
import { AXIS_MAP } from './axisMap'

export type MediaKind = 'video' | 'audio'

export const VIDEO_EXTS = ['mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v', 'wmv', 'flv'] as const
export const AUDIO_EXTS = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav'] as const

export const VIDEO_EXT = new RegExp(`\\.(?:${VIDEO_EXTS.join('|')})$`, 'i')
export const AUDIO_EXT = new RegExp(`\\.(?:${AUDIO_EXTS.join('|')})$`, 'i')
export const MEDIA_EXT = new RegExp(`\\.(?:${[...VIDEO_EXTS, ...AUDIO_EXTS].join('|')})$`, 'i')

export const isVideoName = (name: string) => VIDEO_EXT.test(name)
export const isAudioName = (name: string) => AUDIO_EXT.test(name)
export const isMediaName = (name: string) => MEDIA_EXT.test(name)

/** 'video', 'audio', or null for anything else (a script, a subtitle, a picture). */
export function mediaKindOf(name: string | null | undefined): MediaKind | null {
  if (!name)
    return null
  if (VIDEO_EXT.test(name))
    return 'video'
  if (AUDIO_EXT.test(name))
    return 'audio'
  return null
}

/** For a file picker's `accept`. */
export const MEDIA_ACCEPT = [...VIDEO_EXTS, ...AUDIO_EXTS].map(e => `.${e}`)

const SCRIPT_SUFFIX = '.funscript'

/** "Clip.MP4" → "clip": what scripts are matched against. */
export function pairingBase(name: string): string {
  return name.replace(/\.[^.]+$/, '').toLowerCase()
}

/**
 * The scripts for one file, from a map of lower-cased script file name →
 * file. A name that adds a known axis (`.roll`, `.twist`, `.r0`) is that
 * axis; anything else added (`(bounce)`, ` soft`) is an alternate take.
 * Main scripts first, then the takes by name.
 */
export function matchScripts(name: string, scripts: ReadonlyMap<string, File>): ScriptMatch[] {
  const base = pairingBase(name)
  const matches: ScriptMatch[] = []
  for (const key of keysStartingWith(scripts, base)) {
    if (!key.endsWith(SCRIPT_SUFFIX))
      continue
    const file = scripts.get(key)!
    // "video (bounce)" or "video.twist" → " (bounce)" / ".twist" / ""
    const suffix = key.slice(base.length, -SCRIPT_SUFFIX.length).trim()
    // Strip the parens, dots, spaces and dashes around it: "bounce", "twist", "r0".
    const altName = suffix.replace(/^[\s\-_.(]+|[\s\-_.)]+$/g, '').trim()
    const isAxis = altName.length > 0 && altName.toLowerCase() in AXIS_MAP
    const isAlt = suffix.length > 0 && !isAxis
    matches.push({ file, isAlt, altName: isAlt ? altName : '' })
  }
  matches.sort((a, b) => {
    if (a.isAlt !== b.isAlt)
      return a.isAlt ? 1 : -1
    return a.altName.localeCompare(b.altName)
  })
  return matches
}

/** Lower-cased name → file, for every funscript among `files`. */
export function scriptMapOf(files: readonly File[]): Map<string, File> {
  const map = new Map<string, File>()
  for (const f of files) {
    const key = f.name.toLowerCase()
    if (key.endsWith(SCRIPT_SUFFIX))
      map.set(key, f)
  }
  return map
}

/** Whether a scan lists this file: every video, and audio files that have a script. */
export function isListed(name: string, scripts: ReadonlyMap<string, File>): boolean {
  const kind = mediaKindOf(name)
  if (kind === 'video')
    return true
  if (kind !== 'audio')
    return false
  return keysStartingWith(scripts, pairingBase(name)).some(key => key.endsWith(SCRIPT_SUFFIX))
}

/** A script map's keys, sorted, and where each stood in the map, worked out once per map. */
const sortedKeys = new WeakMap<ReadonlyMap<string, File>, { size: number, keys: string[], order: Map<string, number> }>()

/**
 * The keys of `scripts` that start with `prefix`, in the map's own order.
 *
 * Looking at every script for every video made a scan quadratic: a library
 * of 10,000 videos and as many scripts compared names 100 million times.
 * Sorted, the keys sharing a prefix sit together, and a binary search finds
 * where they start.
 */
export function keysStartingWith(scripts: ReadonlyMap<string, File>, prefix: string): string[] {
  let index = sortedKeys.get(scripts)
  if (!index || index.size !== scripts.size) {
    const order = new Map<string, number>()
    for (const k of scripts.keys())
      order.set(k, order.size)
    index = { size: scripts.size, keys: [...order.keys()].sort(), order }
    sortedKeys.set(scripts, index)
  }
  const { keys, order } = index
  let lo = 0
  let hi = keys.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (keys[mid] < prefix)
      lo = mid + 1
    else
      hi = mid
  }
  const out: string[] = []
  for (let i = lo; i < keys.length && keys[i].startsWith(prefix); i++)
    out.push(keys[i])
  return out.length > 1 ? out.sort((a, b) => order.get(a)! - order.get(b)!) : out
}

/**
 * Put entries of the same kind as `name` (what is playing) first. For picking
 * the next thing on its own: a video session should not wander into an audio
 * track, nor the other way round, while there is anything else to play.
 * With nothing playing, or nothing of that kind, the list as it is.
 */
export function sameKindAs<T extends { name: string }>(list: T[], name: string | null | undefined): T[] {
  const kind = mediaKindOf(name)
  if (!kind)
    return list
  const same = list.filter(v => (mediaKindOf(v.name) ?? 'video') === kind)
  return same.length ? same : list
}
