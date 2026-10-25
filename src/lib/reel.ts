/**
 * Highlight reels: a programme played as a run of chapters from many videos,
 * picked so their intensity follows the programme's arc — gentle sections
 * while it warms up, the hardest ones at the peak — rather than whole videos
 * chosen once per phase.
 *
 * Planning walks programme time from the start. At each step it asks what the
 * arc wants over the next slot, scores every unused chapter in the pool
 * against that, and takes the best (with a seeded jitter so a reshuffle gives
 * a different but equally fitting reel). Then:
 *
 * - **Length.** A slot runs to the next change in the arc (a phase or an edge
 *   pass boundary), within the clip bounds. A chapter that fits plays whole;
 *   a longer one is trimmed to the window that best matches the target,
 *   which for a peak is its densest stretch.
 * - **Clean cuts.** Both ends snap to the script's stroke bottoms or pauses,
 *   so a switch never happens mid-stroke and both sides of it are low: the
 *   device makes a short move instead of a lurch.
 * - **Variety.** No chapter twice, no video again within `spacing` clips, and
 *   a nudge away from the creator and tags that just played.
 * - **Locks.** Clips the user locked stay, in order, re-timed to wherever the
 *   plan has got to; everything around them is planned fresh.
 *
 * Pure and deterministic for a given seed, so it can be tested and replanned
 * freely (an edge, a skip, "keep this longer" all just replan the rest).
 */
import type { ChapterIndexRecord, IndexedChapter } from './chapterIndex'
import { CURVE_MS } from './chapterIndex'
import { meanSpeedToIntensity } from './scriptIntensity'

/** One video the reel may draw from: an index record plus who made it. */
export interface ReelSource extends Pick<ChapterIndexRecord, 'durationMs' | 'chapters' | 'cuts' | 'curve' | 'tags'> {
  video: string
  creator: string | null
}

export interface ReelClip {
  /** Unique within a reel. */
  id: string
  video: string
  /** Index of the chapter in its source. */
  chapter: number
  /** `${video}#${chapter}`: what "no clip twice" compares. */
  key: string
  name: string
  source: 'auto' | 'author'
  /** Video seconds. */
  start: number
  end: number
  /** Programme seconds it is due to start at. */
  at: number
  /** How hard this window goes, 0–1. */
  intensity: number
  /** What the arc asked for over its slot. */
  target: number
  creator: string | null
  locked: boolean
}

export interface ReelRequest {
  /** Programme seconds to plan from. */
  from: number
  /** Programme seconds to plan to (the end). */
  to: number
  /** Target intensity at programme time t. */
  target: (t: number) => number
  /** Programme times where the arc changes character; a clip tries not to straddle one. */
  breaks?: number[]
}

export interface ReelOptions {
  seed: number
  /** Shortest clip, seconds. */
  minSec?: number
  /** Longest clip, seconds. */
  maxSec?: number
  /** What a long chapter is trimmed to, seconds (within min–max). */
  prefSec?: number
  /** No video twice within this many clips. */
  spacing?: number
  /** Chapter keys not to use: played already, or skipped by hand. */
  exclude?: Iterable<string>
  /** Locked clips still to come, in order. Kept and re-timed. */
  fixed?: ReelClip[]
  /** Clips already played (latest last), so variety carries over a replan. */
  history?: ReelClip[]
}

export interface ReelPlan {
  clips: ReelClip[]
  /** True when the pool ran dry and the plan had to repeat itself or leave a gap. */
  shortfall: boolean
}

export const DEFAULT_MIN_SEC = 20
export const DEFAULT_MAX_SEC = 180
export const DEFAULT_PREF_SEC = 90
export const DEFAULT_SPACING = 6

/** How far a cut may move to land on a stroke bottom, seconds: back / forward. */
const SNAP_BACK = 3
const SNAP_FORWARD = 6
/** Never cut this close to a video's end: its `ended` would race the switch. */
const END_GUARD_MS = 1500
/** How many candidates get the (costlier) window search after a rough sort. */
const SHORTLIST = 40

// ─── Small helpers ────────────────────────────────────────────────────────────

/** Mulberry32: tiny, fast, good enough to shuffle a reel. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Who made a video, from its file name when nothing better is known: this
 * kind of library is usually named "(Creator) Title" or "[Creator] Title".
 */
export function guessCreator(name: string): string | null {
  const m = /^\s*[([]([^)\]]{2,60})[)\]]/.exec(name)
  return m ? m[1].trim().toLowerCase() : null
}

function lowerBound(sorted: number[], v: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < v)
      lo = mid + 1
    else
      hi = mid
  }
  return lo
}

/**
 * The cut point nearest `ms` within [ms − back, ms + forward], or `ms` itself
 * when there is none. Ties go forward: a little longer is better than a stub.
 */
export function snapCut(cuts: number[], ms: number, back = SNAP_BACK * 1000, forward = SNAP_FORWARD * 1000): number {
  if (!cuts.length)
    return ms
  const i = lowerBound(cuts, ms - back)
  let best = ms
  let bestD = Number.POSITIVE_INFINITY
  for (let j = i; j < cuts.length && cuts[j] <= ms + forward; j++) {
    const d = Math.abs(cuts[j] - ms) - (cuts[j] >= ms ? 1 : 0)
    if (d < bestD) {
      bestD = d
      best = cuts[j]
    }
  }
  return best
}

/** Mean intensity of a source between two video times, from its speed curve. */
export function windowIntensity(src: Pick<ReelSource, 'curve'>, startMs: number, endMs: number): number {
  const c = src.curve
  if (!c.length || endMs <= startMs)
    return 0
  let sum = 0
  let w = 0
  const k0 = Math.max(0, Math.floor(startMs / CURVE_MS))
  const k1 = Math.min(c.length - 1, Math.floor((endMs - 1) / CURVE_MS))
  for (let k = k0; k <= k1; k++) {
    const s = Math.max(startMs, k * CURVE_MS)
    const e = Math.min(endMs, (k + 1) * CURVE_MS)
    if (e > s) {
      sum += c[k] * (e - s)
      w += e - s
    }
  }
  return w ? meanSpeedToIntensity(sum / w) : 0
}

/** Mean of `f` over [a, b], by a few samples; plenty for a smooth arc. */
function meanOver(f: (t: number) => number, a: number, b: number, n = 6): number {
  if (b <= a)
    return f(a)
  let s = 0
  for (let i = 0; i < n; i++)
    s += f(a + ((i + 0.5) / n) * (b - a))
  return s / n
}

// ─── Windows ──────────────────────────────────────────────────────────────────

interface Window {
  startMs: number
  endMs: number
  intensity: number
}

/**
 * Where to cut a chapter for a slot of up to `capMs` aiming at `target`: the
 * whole chapter when it fits; a short one stretched into what follows up to
 * the minimum; a longer one trimmed to its best-matching `trimMs` stretch.
 * Ends snapped.
 */
export function chooseWindow(
  src: ReelSource,
  ch: IndexedChapter,
  capMs: number,
  minMs: number,
  target: number,
  trimMs = capMs,
): Window | null {
  const limit = Math.max(0, src.durationMs - END_GUARD_MS)
  let a = ch.start
  let b = Math.min(ch.end, limit)
  const lenMs = Math.min(capMs, Math.max(minMs, trimMs))
  if (b - a > capMs) {
    // Slide a slot-long window across the chapter a curve step at a time.
    let bestA = a
    let bestScore = Number.POSITIVE_INFINITY
    for (let s = a; s + lenMs <= b + 1; s += CURVE_MS) {
      const v = windowIntensity(src, s, s + lenMs)
      // Equal fit: the busier one, since a peak is what a highlight is.
      const score = Math.abs(v - target) - v * 0.01
      if (score < bestScore) {
        bestScore = score
        bestA = s
      }
    }
    a = bestA
    b = a + lenMs
  }
  else if (b - a < minMs) {
    b = Math.min(limit, a + minMs)
    if (b - a < minMs)
      a = Math.max(0, b - minMs)
  }
  // Snap the start back towards the chapter's own boundary rather than past it,
  // and keep whatever we snap to inside the video.
  const sa = a === ch.start ? snapCut(src.cuts, a, 1500, SNAP_FORWARD * 1000) : snapCut(src.cuts, a)
  let sb = snapCut(src.cuts, b)
  if (sb > limit)
    sb = snapCut(src.cuts, limit, SNAP_BACK * 1000 * 2, 0)
  if (sb > limit)
    sb = limit
  if (sb - sa < Math.min(minMs, ch.end - ch.start) * 0.75)
    return null
  return { startMs: sa, endMs: sb, intensity: windowIntensity(src, sa, sb) }
}

// ─── Planning ────────────────────────────────────────────────────────────────

interface Candidate {
  src: ReelSource
  ci: number
  ch: IndexedChapter
  key: string
}

/** Every chapter worth playing on its own. Breaks and stubs are not. */
export function candidates(pool: ReelSource[], minSec = DEFAULT_MIN_SEC): Candidate[] {
  const out: Candidate[] = []
  for (const src of pool) {
    src.chapters.forEach((ch, ci) => {
      if (ch.kind === 'break' || ch.end - ch.start < minSec * 500)
        return
      out.push({ src, ci, ch, key: `${src.video}#${ci}` })
    })
  }
  return out
}

/** How many usable chapters and videos a pool holds. */
export function poolSize(pool: ReelSource[], minSec = DEFAULT_MIN_SEC): { chapters: number, videos: number } {
  const c = candidates(pool, minSec)
  return { chapters: c.length, videos: new Set(c.map(x => x.src.video)).size }
}

let clipSeq = 0

function makeClip(c: Candidate, w: Window, at: number, target: number): ReelClip {
  clipSeq = (clipSeq + 1) % 1e9
  return {
    id: `${c.key}@${Math.round(w.startMs)}~${clipSeq.toString(36)}`,
    video: c.src.video,
    chapter: c.ci,
    key: c.key,
    name: c.ch.name,
    source: c.ch.source,
    start: w.startMs / 1000,
    end: w.endMs / 1000,
    at,
    intensity: w.intensity,
    target,
    creator: c.src.creator,
    locked: false,
  }
}

export function clipSeconds(c: Pick<ReelClip, 'start' | 'end'>): number {
  return Math.max(0, c.end - c.start)
}

/**
 * Plan clips from `req.from` to `req.to`. See the file comment for how.
 * Returns fewer clips than would fill the time only when the pool is empty.
 */
export function planReel(pool: ReelSource[], req: ReelRequest, opts: ReelOptions): ReelPlan {
  const minSec = Math.max(5, opts.minSec ?? DEFAULT_MIN_SEC)
  const maxSec = Math.max(minSec, opts.maxSec ?? DEFAULT_MAX_SEC)
  const prefSec = Math.min(maxSec, Math.max(minSec, opts.prefSec ?? DEFAULT_PREF_SEC))
  const spacing = Math.max(0, opts.spacing ?? DEFAULT_SPACING)
  const random = rng(opts.seed)
  const all = candidates(pool, minSec)
  const breaks = [...(req.breaks ?? [])].sort((a, b) => a - b)
  const fixed = [...(opts.fixed ?? [])]
  const history = [...(opts.history ?? [])]
  const used = new Set<string>(opts.exclude ?? [])
  for (const c of [...history, ...fixed])
    used.add(c.key)

  const clips: ReelClip[] = []
  let shortfall = false
  let t = req.from
  // A sliver left at the end is not worth a clip; the stop eases down over it.
  const tail = Math.min(minSec * 0.5, 10)

  while (req.to - t > tail) {
    const recent = [...history, ...clips].slice(-Math.max(1, spacing))
    const last = recent[recent.length - 1]

    // A locked clip due now (or that would be squeezed out) goes in here.
    if (fixed.length && fixed[0].at <= t + minSec * 0.5) {
      const f = fixed.shift()!
      const clip = { ...f, at: t, target: meanOver(req.target, t, t + clipSeconds(f)) }
      clips.push(clip)
      t += Math.max(1, clipSeconds(f))
      continue
    }

    // The slot: up to the next change in the arc, within bounds.
    const nextBreak = breaks.find(b => b > t + minSec * 0.75) ?? req.to
    let slot = Math.min(maxSec, Math.max(minSec, nextBreak - t))
    if (fixed.length)
      slot = Math.min(slot, Math.max(minSec, fixed[0].at - t))
    slot = Math.min(slot, Math.max(minSec, req.to - t))
    const target = meanOver(req.target, t, t + slot)

    const pick = choose(all, { used, recent, last, spacing, slot, prefSec, minSec, target, random })
      ?? (() => {
        // Ran dry: let videos come round again sooner, then let chapters repeat.
        shortfall = true
        return choose(all, { used, recent: [], last, spacing: 0, slot, prefSec, minSec, target, random })
          ?? choose(all, { used: new Set(), recent: last ? [last] : [], last, spacing: 1, slot, prefSec, minSec, target, random })
      })()
    if (!pick)
      break
    const clip = makeClip(pick.c, pick.w, t, target)
    clips.push(clip)
    used.add(clip.key)
    t += clipSeconds(clip)
  }
  // Locked clips past the end still play: they were asked for.
  for (const f of fixed) {
    clips.push({ ...f, at: t })
    t += clipSeconds(f)
  }
  return { clips, shortfall }
}

interface ChooseCtx {
  used: Set<string>
  recent: ReelClip[]
  last: ReelClip | undefined
  spacing: number
  slot: number
  prefSec: number
  minSec: number
  target: number
  random: () => number
}

function choose(all: Candidate[], x: ChooseCtx): { c: Candidate, w: Window } | null {
  const recentVideos = new Set(x.recent.slice(-x.spacing).map(c => c.video))
  const recentCreators = x.recent.slice(-3).map(c => c.creator).filter(Boolean)
  const lastTags = new Set(x.last ? tagsOf(all, x.last.video) : [])

  // Rough pass on the chapter's own rating, then the real window for the best few.
  const open = all.filter(c => !x.used.has(c.key) && !recentVideos.has(c.src.video))
  if (!open.length)
    return null
  const rough = open
    .map(c => ({ c, d: Math.abs(c.ch.intensity - x.target) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, SHORTLIST)

  let best: { c: Candidate, w: Window } | null = null
  let bestScore = Number.POSITIVE_INFINITY
  const slotMs = x.slot * 1000
  const wantMs = Math.min(slotMs, x.prefSec * 1000)
  for (const { c } of rough) {
    const w = chooseWindow(c.src, c.ch, slotMs, x.minSec * 1000, x.target, wantMs)
    if (!w)
      continue
    const len = w.endMs - w.startMs
    let score = Math.abs(w.intensity - x.target)
    // Near the preferred length beats a stub that leaves the next pick to cover it.
    score += Math.min(1, Math.abs(len - wantMs) / wantMs) * 0.05
    if (c.src.creator) {
      if (x.last?.creator === c.src.creator)
        score += 0.08
      score += recentCreators.filter(r => r === c.src.creator).length * 0.03
    }
    if (lastTags.size && c.src.tags.length) {
      const shared = c.src.tags.filter(tag => lastTags.has(tag)).length
      score += (shared / Math.max(lastTags.size, c.src.tags.length)) * 0.03
    }
    // Someone who watched the video drew these; a speed curve guessed the others.
    if (c.ch.source === 'author')
      score -= 0.02
    score += x.random() * 0.04
    if (score < bestScore) {
      bestScore = score
      best = { c, w }
    }
  }
  return best
}

function tagsOf(all: Candidate[], video: string): string[] {
  return all.find(c => c.src.video === video)?.src.tags ?? []
}

/**
 * Move clips from index `from` on so the first starts at `at`, keeping their
 * gaps. Used when a switch lands a little early or late.
 */
export function retime(clips: ReelClip[], from: number, at: number): ReelClip[] {
  if (from >= clips.length)
    return clips
  const shift = at - clips[from].at
  if (!shift)
    return clips
  return clips.map((c, i) => (i >= from ? { ...c, at: c.at + shift } : c))
}

/**
 * Stretch a clip by `seconds`, snapped to a clean cut and kept inside the
 * video. Returns the clip unchanged if there is no room.
 */
export function lengthen(clip: ReelClip, src: Pick<ReelSource, 'cuts' | 'durationMs' | 'curve'>, seconds: number): ReelClip {
  const limit = Math.max(0, src.durationMs - END_GUARD_MS)
  let end = snapCut(src.cuts, Math.min(limit, (clip.end + seconds) * 1000))
  if (end > limit)
    end = limit
  if (end <= clip.end * 1000 + 500)
    return clip
  return { ...clip, end: end / 1000, intensity: windowIntensity(src, clip.start * 1000, end) }
}

/**
 * Where to end a clip early (an edge, a phase skipped): the first clean cut
 * from `nowSec` on, within `withinSec`, or now.
 */
export function cutSoon(src: Pick<ReelSource, 'cuts'>, nowSec: number, withinSec = 4): number {
  const ms = nowSec * 1000
  const i = lowerBound(src.cuts, ms + 300)
  const c = src.cuts[i]
  return c !== undefined && c <= ms + withinSec * 1000 ? c / 1000 : nowSec
}
