/**
 * Pieces of plugin API 5 that need no store: a music script with the strokes
 * it is made of, and library videos' stroke profiles, kept between runs.
 */
import type { MusicStroke, StrokeProfile } from './types'
import type { SoundtrackAnalysis } from '~/lib/beatTrack'
import type { MusicScriptOptions as CoreMusicOptions } from '~/lib/musicScript'
import type { ScriptMatch } from '~/stores/libraryStore'
import { extractSuffix, suffixToAxis } from '~/lib/axisMap'
import { metaDb } from '~/lib/idb'
import { musicScript, planStrokes } from '~/lib/musicScript'
import { strokeProfile } from '~/lib/strokeProfile'
import { readLibraryScripts } from './api4'

/** A beat within this of a stroke's bottom is the beat it is on. */
const ON_BEAT_S = 0.04

/** Index of the beat at `t` (seconds), or -1 when none is that close. */
function beatAt(beats: number[], t: number): number {
  let lo = 0
  let hi = beats.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (beats[mid] < t)
      lo = mid + 1
    else
      hi = mid
  }
  let best = -1
  for (const i of [lo - 1, lo]) {
    if (i >= 0 && i < beats.length && Math.abs(beats[i] - t) <= ON_BEAT_S && (best < 0 || Math.abs(beats[i] - t) < Math.abs(beats[best] - t)))
      best = i
  }
  return best
}

/** musicScript, and the strokes it was made from. */
export function musicPlan(a: SoundtrackAnalysis, o: CoreMusicOptions): { actions: { at: number, pos: number }[], strokes: MusicStroke[] } {
  const planned = planStrokes(a, o)
  const actions = musicScript(a, o, planned).map(x => ({ at: Math.round(x.at), pos: Math.round(x.pos) }))
  const strokes: MusicStroke[] = []
  for (const s of planned) {
    if (s.rest)
      continue
    strokes.push({
      at: Math.round(s.start * 1000),
      top: Math.round(((s.start + s.end) / 2) * 1000),
      end: Math.round(s.end * 1000),
      beat: beatAt(a.beats, s.start),
      depth: Math.round(s.depth * 1000) / 1000,
    })
  }
  return { actions, strokes }
}

const PROFILE_VERSION = 1
const profileKey = (videoName: string) => `strokes:${videoName}`

interface KeptProfile { v: number, sig: string, profile: StrokeProfile }

/** The stroke script: the main (not alternate) file whose axis is L0. */
function strokeFile(videoName: string, matches: ScriptMatch[]): ScriptMatch | null {
  return matches.find(m => !m.isAlt && suffixToAxis(m.suffix ?? extractSuffix(videoName, m.file.name)).channel === 'L0') ?? null
}

/**
 * A library video's stroke profile, from the cache while its script is the
 * same file (name, size, date), else worked out and kept. Null without a
 * stroke script.
 */
export async function libraryStrokeProfile(videoName: string, matches: ScriptMatch[]): Promise<StrokeProfile | null> {
  const m = strokeFile(videoName, matches)
  if (!m)
    return null
  const sig = `${m.file.name}|${m.file.size}|${m.file.lastModified}`
  try {
    const kept = await metaDb.get<KeptProfile>(profileKey(videoName))
    if (kept && kept.v === PROFILE_VERSION && kept.sig === sig)
      return kept.profile
  }
  catch {}
  const scripts = await readLibraryScripts(videoName, [m])
  const stroke = scripts.find(s => s.axis === 'L0' && !s.alt)
  if (!stroke)
    return null
  const profile = strokeProfile(stroke.actions)
  try {
    await metaDb.set(profileKey(videoName), { v: PROFILE_VERSION, sig, profile } satisfies KeptProfile)
  }
  catch {}
  return profile
}
