/**
 * The shape of a song from its analysis: where it builds, drops, breaks down,
 * and how sure the bar lines are. For plugins (music.analyse, API 5) that cut
 * or change things with the music, so they don't each guess drops from the
 * loudness themselves.
 *
 * Sections are made of four-bar phrases, since that is how dance music is
 * built and where a listener feels a change land: each phrase is rated by
 * its loudness against the rest of the song, then runs of the same kind are
 * joined.
 *
 * Pure: an analysis in, sections out.
 */

import type { SoundtrackAnalysis } from './beatTrack'
import { beatsInGaps, percentile, phaseMargin } from './beatTrack'

export type MusicSectionKind = 'intro' | 'verse' | 'build' | 'drop' | 'breakdown' | 'outro'

export interface MusicSection {
  /** Seconds. A section starts on its first beat (the first at 0). */
  start: number
  end: number
  kind: MusicSectionKind
  /** How loud it is against the rest of the song, 0–1. */
  level: number
  /** Index of its first beat in `beats`; -1 when it has none. */
  beat: number
}

type Analysis = Pick<SoundtrackAnalysis, 'duration' | 'beats' | 'energy' | 'barPos' | 'gaps'>

/** Beats per phrase: four bars of four. */
const PHRASE = 16
/** Below this spread between the song's loud and quiet phrases, it has no sections worth telling apart. */
const FLAT_DB = 3
const DROP_LEVEL = 0.66
const LOW_LEVEL = 0.33
/** How much louder a phrase's second half must be to count as rising into what follows. */
const RISE_DB = 1

interface Phrase {
  from: number
  to: number
  rest: boolean
  db: number
  rise: number
  level: number
  kind: MusicSectionKind
}

const mean = (xs: number[]) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0

/** Phrases: runs of up to sixteen beats starting on downbeats, broken where a gap starts or ends. */
function phrases(a: Analysis, inGap: boolean[]): Phrase[] {
  const out: Phrase[] = []
  const n = a.beats.length
  let i = 0
  while (i < n) {
    const rest = inGap[i]
    let j = i + 1
    // Music ends a phrase on the first downbeat once it is long enough (so
    // beats before the first full bar join the first phrase).
    for (; j < n && inGap[j] === rest; j++) {
      if (!rest && j - i >= PHRASE && a.barPos[j] === 0)
        break
    }
    const e = a.energy.slice(i, j)
    const half = Math.max(1, Math.floor(e.length / 2))
    out.push({ from: i, to: j, rest, db: mean(e), rise: mean(e.slice(half)) - mean(e.slice(0, half)), level: 0, kind: 'verse' })
    i = j
  }
  return out
}

export function musicSections(a: Analysis): MusicSection[] {
  const n = a.beats.length
  const whole = (kind: MusicSectionKind): MusicSection[] => a.duration > 0 ? [{ start: 0, end: a.duration, kind, level: 0.5, beat: n ? 0 : -1 }] : []
  if (n < 8)
    return whole(n ? 'verse' : 'breakdown')

  const inGap = beatsInGaps(a)
  const ps = phrases(a, inGap)
  const music = ps.filter(p => !p.rest)
  if (!music.length)
    return whole('breakdown')

  const dbs = music.map(p => p.db)
  const lo = percentile(dbs, 0.1)
  const hi = percentile(dbs, 0.9)
  const flat = hi - lo < FLAT_DB
  for (const p of ps) {
    p.level = p.rest ? 0 : flat ? 0.5 : Math.max(0, Math.min(1, (p.db - lo) / (hi - lo)))
    p.kind = p.rest || (!flat && p.level <= LOW_LEVEL) ? 'breakdown' : !flat && p.level >= DROP_LEVEL ? 'drop' : 'verse'
  }

  // A phrase leading into a drop that rises, or sits between quiet and
  // loud, is the build.
  for (let k = 0; k + 1 < ps.length; k++) {
    const p = ps[k]
    if (ps[k + 1].kind === 'drop' && p.kind !== 'drop' && !p.rest && (p.rise >= RISE_DB || p.kind === 'verse'))
      p.kind = 'build'
  }

  // Before the first drop and after the last, quieter phrases are the intro
  // and the outro. A song with no drop keeps its verses and breakdowns.
  const first = ps.findIndex(p => p.kind === 'drop')
  if (first >= 0) {
    let last = first
    for (let k = ps.length - 1; k > first; k--) {
      if (ps[k].kind === 'drop') {
        last = k
        break
      }
    }
    for (let k = 0; k < first && ps[k].kind !== 'build'; k++)
      ps[k].kind = 'intro'
    for (let k = last + 1; k < ps.length; k++)
      ps[k].kind = 'outro'
  }

  const out: MusicSection[] = []
  const weight: number[] = []
  for (const p of ps) {
    const len = p.to - p.from
    const prev = out[out.length - 1]
    if (prev && prev.kind === p.kind) {
      const w = weight[weight.length - 1]
      prev.level = (prev.level * w + p.level * len) / (w + len)
      weight[weight.length - 1] = w + len
      continue
    }
    const start = out.length ? a.beats[p.from] : 0
    if (prev)
      prev.end = start
    out.push({ start, end: a.duration, kind: p.kind, level: p.level, beat: p.from })
    weight.push(len)
  }
  for (const s of out)
    s.level = Math.round(s.level * 100) / 100
  return out
}

/**
 * How sure the bar placement is at each beat, 0–1. Analyses keep this since
 * plugin API 5; for older cached ones it is worked out from the onset
 * strengths, which tell a downbeat less surely than the kick did.
 */
export function barConfidenceOf(a: Pick<SoundtrackAnalysis, 'beats' | 'gaps' | 'barPos' | 'strength' | 'barConfidence'>): number[] {
  const n = a.beats.length
  if (a.barConfidence?.length === n)
    return a.barConfidence
  const out = Array.from<number>({ length: n }).fill(0)
  const inGap = beatsInGaps(a)
  for (let i = 0; i < n;) {
    let j = i
    while (j < n && inGap[j] === inGap[i])
      j++
    if (!inGap[i] && j - i >= 8) {
      const sums = [0, 0, 0, 0]
      const counts = [0, 0, 0, 0]
      for (let k = i; k < j; k++) {
        sums[a.barPos[k]] += a.strength[k] ?? 0
        counts[a.barPos[k]]++
      }
      const sure = phaseMargin(sums.map((v, p) => counts[p] ? v / counts[p] : 0), 0) * Math.min(1, (j - i) / 32) * 0.8
      for (let k = i; k < j; k++)
        out[k] = sure
    }
    i = j
  }
  return out
}
