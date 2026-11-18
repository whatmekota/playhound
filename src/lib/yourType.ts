/**
 * "Your type": how much a video looks like the ones you finish to.
 *
 * Every video is a bag of features: the tags it was given (by you or its
 * script), its creator, the automatic tags for pace, intensity, length and
 * format, and the folder it sits in. Your history weighs the videos you
 * finished to most, starred ones next, then ones you came back to. A feature
 * counts for as much as it is over-represented in that weighted set against
 * the whole library: a tag every video has says nothing, one most of your
 * finishes share says a lot. A video's score adds up its features.
 */
import type { ScriptSummary } from './idb'
import type { VideoEntry } from '~/stores/libraryStore'
import { effectiveMeta } from './entryInfo'
import { autoTags, manualTags } from './tags'

export interface TasteSignal {
  finishes: number
  plays: number
  starred: boolean
}

export interface TasteProfile {
  weights: Map<string, number>
  /** Videos it rests on: finished to or starred. */
  basis: number
}

/** It says nothing until this many videos were finished to or starred. */
export const TASTE_MIN = 3

const KIND_WEIGHT: Record<string, number> = { creator: 1.5, tag: 1, auto: 0.6, dir: 0.5 }

type FeatureSource = Pick<VideoEntry, 'name' | 'path' | 'hasScript' | 'scriptCount' | 'scriptType' | 'duration' | 'kind' | 'scriptMeta' | 'userMeta'>

/** A video's features, prefixed by kind: `tag:pov`, `auto:fast`, `creator:someone`, `dir:folder/sub`. */
export function tasteFeatures(v: FeatureSource, summary: ScriptSummary | null): string[] {
  const out = new Set<string>()
  for (const t of manualTags(v))
    out.add(`tag:${t}`)
  for (const t of autoTags(v, summary))
    out.add(`auto:${t}`)
  const creator = effectiveMeta(v as VideoEntry).creator?.trim().toLowerCase()
  if (creator)
    out.add(`creator:${creator}`)
  const path = v.path ?? v.name
  const slash = path.lastIndexOf('/')
  if (slash > 0)
    out.add(`dir:${path.slice(0, slash).toLowerCase()}`)
  return [...out]
}

/** How much one video says about your taste: a finish most, a star next, coming back a little. */
export function tasteWeight(s: TasteSignal): number {
  return 3 * s.finishes + (s.starred ? 2 : 0) + 0.5 * Math.min(6, Math.max(0, s.plays - 1))
}

export function tasteProfile(rows: readonly { features: readonly string[], signal: TasteSignal }[]): TasteProfile | null {
  const inLibrary = new Map<string, number>()
  const liked = new Map<string, number>()
  let total = 0
  let basis = 0
  for (const r of rows) {
    for (const f of r.features)
      inLibrary.set(f, (inLibrary.get(f) ?? 0) + 1)
    const w = tasteWeight(r.signal)
    if (w <= 0)
      continue
    total += w
    if (r.signal.finishes > 0 || r.signal.starred)
      basis++
    for (const f of r.features)
      liked.set(f, (liked.get(f) ?? 0) + w)
  }
  if (basis < TASTE_MIN || total <= 0)
    return null
  const weights = new Map<string, number>()
  for (const [f, w] of liked) {
    const share = w / total
    const base = (inLibrary.get(f) ?? 1) / rows.length
    const lift = Math.log2(share / base)
    if (lift > 0)
      weights.set(f, (KIND_WEIGHT[f.slice(0, f.indexOf(':'))] ?? 1) * share * lift)
  }
  return { weights, basis }
}

export function tasteScore(p: TasteProfile, features: readonly string[]): number {
  let s = 0
  for (const f of features)
    s += p.weights.get(f) ?? 0
  return s
}

/** The features that count most for a video, as words ("pov", "by someone"), for a hint. */
export function tasteReasons(p: TasteProfile, features: readonly string[], n = 3): string[] {
  return features
    .map(f => ({ f, w: p.weights.get(f) ?? 0 }))
    .filter(x => x.w > 0)
    .sort((a, b) => b.w - a.w)
    .slice(0, n)
    .map(({ f }) => {
      const [kind, ...rest] = f.split(':')
      const value = rest.join(':')
      if (kind === 'creator')
        return `by ${value}`
      if (kind === 'dir')
        return `in ${value.split('/').pop()}`
      return value
    })
}
