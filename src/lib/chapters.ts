/**
 * Chapters: a script cut into the few sections a person would name.
 *
 * A funscript has no markers, but its intensity has shape — a slow opening, a
 * long steady middle, a burst near the end, a pause. This finds that shape and
 * names it, so the timeline can show it and the player can skip and loop by it.
 *
 * How:
 * 1. Movement per second, measured straight from the actions. (The analysis
 *    envelope trails its window by three seconds, which would put every
 *    boundary late, so it is not reused here.)
 * 2. Stretches with no real movement become breaks.
 * 3. Each stretch in between is split where its smoothed speed changes the
 *    most, recursively, but only into pieces at least `minChapterMs` long and
 *    only where the two sides genuinely differ. Change-point splitting cannot
 *    flicker the way per-sample thresholds do, because a boundary needs a
 *    sustained difference on both sides of it.
 * 4. Neighbours are merged back with hysteresis: crossing a tier (slow,
 *    steady, fast) needs a smaller change than splitting within one.
 * 5. If it is still too many, the most similar neighbours are merged until it
 *    is not.
 *
 * A script can also carry its author's own chapters (`metadata.chapters`, the
 * funscript schema EroScripts' funlib uses). Those win: someone who watched
 * the video knows better than a speed curve does. See `authorChapters`.
 *
 * Vue-free and side-effect-free so it can be unit tested directly.
 */
import type { Action, Peak } from './funscriptAnalysis'
import { detectPeaks } from './funscriptAnalysis'

export type ChapterKind = 'break' | 'slow' | 'medium' | 'fast' | 'peak'

export interface Chapter {
  index: number
  /** milliseconds */
  start: number
  /** milliseconds */
  end: number
  kind: ChapterKind
  name: string
  /** Mean speed, position-units (0-1) per second. ×100 for the usual funscript "speed". */
  avgSpeed: number
  /** Stroke cycles per minute, 0 when there are too few strokes to say. */
  avgSpm: number
  /** Detected from the actions, or written into the script by its author. */
  source: 'auto' | 'author'
}

export interface ChapterOptions {
  /** Length of the video in ms. Time past the last action becomes an outro. */
  durationMs?: number
  /** Precomputed peaks, if the caller already has them. */
  peaks?: Peak[]
  /** Shortest chapter worth having. Defaults to a share of the length. */
  minChapterMs?: number
  maxChapters?: number
}

const BIN_MS = 1000
/** Slower than this (units/s) is not movement: holds, drifts, a resting position. */
const IDLE_SPEED = 0.12
/** A blip of movement shorter than this inside a break does not end it. */
const ABSORB_MS = 4000
/** Tier edges, units/s: under 130 "speed" is slow, 250 and up is fast. */
const SLOW_MAX = 1.3
const FAST_MIN = 2.5
/** Two sides of a boundary must differ by this share of the faster one… */
const SPLIT_REL = 0.15
/** …and by this much in absolute terms, so near-idle noise does not split. */
const SPLIT_ABS = 0.25
/** Inside one tier a boundary needs a bigger change to survive. */
const SAME_TIER_REL = 0.3

type Tier = 'slow' | 'medium' | 'fast'

interface Seg {
  /** bin index, inclusive */
  lo: number
  /** bin index, exclusive */
  hi: number
  brk: boolean
}

function tierOf(speed: number): Tier {
  if (speed < SLOW_MAX)
    return 'slow'
  return speed < FAST_MIN ? 'medium' : 'fast'
}

const TIER_RANK: Record<Tier, number> = { slow: 0, medium: 1, fast: 2 }

/** Position travelled within each one-second bin, spreading each segment over the bins it spans. */
function movementBins(actions: Action[], bins: number): Float64Array {
  const out = new Float64Array(bins)
  for (let i = 0; i < actions.length - 1; i++) {
    const a = actions[i]
    const b = actions[i + 1]
    const d = Math.abs(b.pos - a.pos)
    if (d === 0)
      continue
    const t0 = Math.max(0, a.at)
    const t1 = b.at
    if (t1 <= t0) {
      const k = Math.floor(t0 / BIN_MS)
      if (k < bins)
        out[k] += d
      continue
    }
    const last = Math.min(bins - 1, Math.floor((t1 - 1) / BIN_MS))
    for (let k = Math.floor(t0 / BIN_MS); k <= last; k++) {
      const s = Math.max(t0, k * BIN_MS)
      const e = Math.min(t1, (k + 1) * BIN_MS)
      if (e > s)
        out[k] += d * (e - s) / (t1 - t0)
    }
  }
  return out
}

/** Centred moving average. */
function smooth(src: Float64Array, radius: number): Float64Array {
  const n = src.length
  const out = new Float64Array(n)
  let sum = 0
  let lo = 0
  let hi = 0
  for (let i = 0; i < n; i++) {
    while (hi < n && hi <= i + radius) sum += src[hi++]
    while (lo < i - radius) sum -= src[lo++]
    out[i] = sum / (hi - lo)
  }
  return out
}

function prefix(src: Float64Array, squared = false): Float64Array {
  const out = new Float64Array(src.length + 1)
  for (let i = 0; i < src.length; i++)
    out[i + 1] = out[i] + (squared ? src[i] * src[i] : src[i])
  return out
}

function differs(a: number, b: number, rel: number) {
  const hi = Math.max(a, b)
  const d = Math.abs(a - b)
  return d >= SPLIT_ABS && d >= hi * rel
}

/**
 * Split the script into chapters. Returns an empty list for anything too
 * short or too sparse to have a shape.
 */
export function buildChapters(actions: Action[], opts: ChapterOptions = {}): Chapter[] {
  if (actions.length < 2)
    return []
  const scriptEnd = actions[actions.length - 1].at
  const durationMs = Math.max(scriptEnd, opts.durationMs ?? 0)
  const bins = Math.ceil(durationMs / BIN_MS)
  if (bins < 4)
    return []

  const minChapterMs = opts.minChapterMs ?? Math.min(60_000, Math.max(12_000, durationMs / 25))
  const minBins = Math.max(2, Math.round(minChapterMs / BIN_MS))
  const minBreakBins = Math.round(Math.min(15_000, Math.max(5_000, minChapterMs * 0.4)) / BIN_MS)
  const maxChapters = Math.max(1, opts.maxChapters ?? 15)

  const raw = movementBins(actions, bins)
  const rawSum = prefix(raw)
  const meanOf = (lo: number, hi: number) => (hi > lo ? (rawSum[hi] - rawSum[lo]) / (hi - lo) : 0)

  // ── Breaks ──
  // A light smooth so the gap between two slow strokes does not read as idle.
  const near = smooth(raw, 1)
  const segs: Seg[] = []
  {
    let i = 0
    while (i < bins) {
      const idle = near[i] < IDLE_SPEED
      let j = i
      while (j < bins && (near[j] < IDLE_SPEED) === idle) j++
      segs.push({ lo: i, hi: j, brk: idle })
      i = j
    }
  }
  // Idle runs too short to be a break are just part of the movement around them.
  for (const s of segs) {
    if (s.brk && s.hi - s.lo < minBreakBins)
      s.brk = false
  }
  // A twitch inside a long pause does not end the pause.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s.brk || segs.length < 2 || s.hi - s.lo >= ABSORB_MS / BIN_MS || meanOf(s.lo, s.hi) >= SLOW_MAX)
      continue
    if ((i === 0 || segs[i - 1].brk) && (i === segs.length - 1 || segs[i + 1].brk))
      s.brk = true
  }
  const coarse = coalesce(segs, true)

  // ── Split each stretch of movement where its speed changes ──
  const radius = Math.max(2, Math.round(Math.min(10, durationMs / 120_000)))
  const sm = smooth(raw, radius)
  const s1 = prefix(sm)
  const s2 = prefix(sm, true)
  const sse = (lo: number, hi: number) => {
    const n = hi - lo
    if (n <= 0)
      return 0
    const s = s1[hi] - s1[lo]
    return s2[hi] - s2[lo] - (s * s) / n
  }
  const smMean = (lo: number, hi: number) => (s1[hi] - s1[lo]) / (hi - lo)

  function split(lo: number, hi: number, out: Seg[]) {
    if (hi - lo >= minBins * 2) {
      const whole = sse(lo, hi)
      let best = -1
      let bestGain = 0
      for (let k = lo + minBins; k <= hi - minBins; k++) {
        const gain = whole - sse(lo, k) - sse(k, hi)
        if (gain > bestGain) {
          bestGain = gain
          best = k
        }
      }
      if (best > 0 && differs(smMean(lo, best), smMean(best, hi), SPLIT_REL)) {
        split(lo, best, out)
        split(best, hi, out)
        return
      }
    }
    out.push({ lo, hi, brk: false })
  }

  let parts: Seg[] = []
  for (const s of coarse) {
    if (s.brk)
      parts.push(s)
    else
      split(s.lo, s.hi, parts)
  }

  // ── Hysteresis: merge neighbours that are not really different ──
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < parts.length - 1; i++) {
      const a = parts[i]
      const b = parts[i + 1]
      if (a.brk || b.brk)
        continue
      const ma = meanOf(a.lo, a.hi)
      const mb = meanOf(b.lo, b.hi)
      const rel = tierOf(ma) === tierOf(mb) ? SAME_TIER_REL : SPLIT_REL
      if (!differs(ma, mb, rel)) {
        parts.splice(i, 2, { lo: a.lo, hi: b.hi, brk: false })
        changed = true
        break
      }
    }
  }

  // ── Too many: fold the least distinct neighbours together ──
  while (parts.length > maxChapters) {
    let best = 0
    let bestCost = Number.POSITIVE_INFINITY
    for (let i = 0; i < parts.length - 1; i++) {
      const a = parts[i]
      const b = parts[i + 1]
      const cost = Math.abs(meanOf(a.lo, a.hi) - meanOf(b.lo, b.hi)) * Math.min(a.hi - a.lo, b.hi - b.lo)
      if (cost < bestCost) {
        bestCost = cost
        best = i
      }
    }
    const a = parts[best]
    const b = parts[best + 1]
    const merged = { lo: a.lo, hi: b.hi, brk: false }
    merged.brk = meanOf(merged.lo, merged.hi) < IDLE_SPEED
    parts.splice(best, 2, merged)
    parts = coalesce(parts)
  }

  return label(parts, meanOf, opts.peaks ?? detectPeaks(actions), durationMs)
}

/**
 * Join neighbouring breaks, and with `moving` neighbouring stretches of
 * movement too (before splitting; after it, splitting decides those).
 */
function coalesce(segs: Seg[], moving = false): Seg[] {
  const out: Seg[] = []
  for (const s of segs) {
    const last = out[out.length - 1]
    if (last && last.brk === s.brk && (s.brk || moving))
      last.hi = s.hi
    else
      out.push({ ...s })
  }
  return out
}

function spmIn(peaks: Peak[], start: number, end: number): number {
  let first = -1
  let last = -1
  let n = 0
  for (const p of peaks) {
    if (p.at < start)
      continue
    if (p.at >= end)
      break
    if (first < 0)
      first = p.at
    last = p.at
    n++
  }
  return n >= 2 && last > first ? ((n - 1) / (last - first)) * 60_000 : 0
}

function label(
  parts: Seg[],
  meanOf: (lo: number, hi: number) => number,
  peaks: Peak[],
  durationMs: number,
): Chapter[] {
  const chapters: Chapter[] = parts.map((s, index) => {
    const avgSpeed = meanOf(s.lo, s.hi)
    const start = s.lo * BIN_MS
    const end = Math.min(durationMs, s.hi * BIN_MS)
    return {
      index,
      start,
      end,
      kind: s.brk ? 'break' : tierOf(avgSpeed),
      name: '',
      avgSpeed,
      avgSpm: s.brk ? 0 : spmIn(peaks, start, end),
      source: 'auto' as const,
    }
  })

  const moving = chapters.filter(c => c.kind !== 'break')
  // The most intense section earns the name, if it stands out from the rest.
  if (moving.length >= 2) {
    const total = moving.reduce((n, c) => n + (c.end - c.start), 0)
    const mean = moving.reduce((n, c) => n + c.avgSpeed * (c.end - c.start), 0) / (total || 1)
    const top = moving.reduce((a, b) => (b.avgSpeed > a.avgSpeed ? b : a))
    if (top.avgSpeed >= mean * 1.15 && top.avgSpeed >= SLOW_MAX)
      top.kind = 'peak'
  }

  const rank = (c: Chapter) => (c.kind === 'peak' ? 3 : c.kind === 'break' ? -1 : TIER_RANK[c.kind as Tier])
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i]
    const prev = moving[moving.indexOf(c) - 1]
    const next = moving[moving.indexOf(c) + 1]
    switch (c.kind) {
      case 'break':
        c.name = i === 0 ? 'Intro' : i === chapters.length - 1 ? 'Outro' : 'Break'
        break
      case 'peak':
        c.name = 'Peak'
        break
      case 'slow':
        if (next && rank(next) > 0)
          c.name = 'Slow build'
        else if (prev && prev.kind === 'slow')
          c.name = c.avgSpeed > prev.avgSpeed ? 'Building' : 'Easing off'
        else if (prev && rank(prev) > 0)
          c.name = 'Cool-down'
        else
          c.name = 'Slow'
        break
      default:
        // Same tier as the one before but still distinct enough to be its own
        // chapter: say which way it went rather than repeat the name.
        if (prev && prev.kind === c.kind)
          c.name = c.avgSpeed > prev.avgSpeed ? (c.kind === 'fast' ? 'Faster' : 'Building') : 'Easing off'
        else
          c.name = c.kind === 'fast' ? 'Fast' : 'Steady'
    }
  }
  return chapters
}

// ─── Author chapters ──────────────────────────────────────────────────────────

/** Name given to a stretch between author chapters that the author left unnamed. */
export const GAP_NAME = '—'

/**
 * A funscript timespan in ms: "HH:MM:SS.mmm" as the schema writes it, but
 * also "MM:SS", "H:MM:SS", bare seconds and missing or short fractions, since
 * hand-edited files have all of them. A number is taken as ms. Null if it is
 * not a time.
 */
export function parseTimespan(v: unknown): number | null {
  if (typeof v === 'number')
    return Number.isFinite(v) && v >= 0 ? v : null
  if (typeof v !== 'string')
    return null
  const m = /^\s*(?:(?:(\d+):)?(\d+):)?(\d+(?:[.,]\d+)?)\s*$/.exec(v)
  if (!m)
    return null
  const h = m[1] ? Number(m[1]) : 0
  const min = m[2] ? Number(m[2]) : 0
  const sec = Number(m[3].replace(',', '.'))
  if (!Number.isFinite(sec))
    return null
  return Math.round(((h * 60 + min) * 60 + sec) * 1000)
}

interface RawSpan {
  name: string
  start: number
  end: number | null
}

/** The usable entries of `metadata.chapters`, sorted, or [] when there are none. */
function readAuthorSpans(metadata: unknown): RawSpan[] {
  const list = (metadata as { chapters?: unknown } | null | undefined)?.chapters
  if (!Array.isArray(list))
    return []
  const out: RawSpan[] = []
  for (const c of list) {
    if (!c || typeof c !== 'object')
      continue
    const o = c as Record<string, unknown>
    const start = parseTimespan(o.startTime ?? o.start)
    if (start === null)
      continue
    const end = parseTimespan(o.endTime ?? o.end)
    out.push({
      name: typeof o.name === 'string' ? o.name : '',
      start,
      end: end !== null && end > start ? end : null,
    })
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * The author's chapters from a script's `metadata`, or [] when it has none.
 *
 * Names are kept exactly as written. Times are tidied into one contiguous run
 * so skipping and lookup work the same as for detected chapters: overlaps are
 * clipped, an open end runs to the next start, and a gap is either absorbed by
 * the chapter before it or, when it is long (`gapMs`, default the larger of
 * 10 s and 3% of the length), becomes an unnamed "—" section of its own.
 */
export function authorChapters(
  actions: Action[],
  metadata: unknown,
  opts: { durationMs?: number, peaks?: Peak[], gapMs?: number } = {},
): Chapter[] {
  const spans = readAuthorSpans(metadata)
  if (!spans.length)
    return []
  const scriptEnd = actions.length ? actions[actions.length - 1].at : 0
  const lastEnd = spans.reduce((n, s) => Math.max(n, s.end ?? s.start), 0)
  const durationMs = Math.max(scriptEnd, opts.durationMs ?? 0, lastEnd)
  const gapMs = opts.gapMs ?? Math.max(10_000, durationMs * 0.03)

  const runs: { name: string, start: number, end: number, gap: boolean }[] = []
  let cursor = 0
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]
    const nextStart = spans[i + 1]?.start ?? durationMs
    const start = Math.max(s.start, cursor)
    const end = Math.min(s.end ?? nextStart, nextStart, durationMs)
    if (end <= start)
      continue
    if (start - cursor >= gapMs)
      runs.push({ name: GAP_NAME, start: cursor, end: start, gap: true })
    else if (runs.length)
      runs[runs.length - 1].end = start
    // A short lead-in before the first chapter is folded into it.
    runs.push({ name: s.name, start: runs.length ? start : (start < gapMs ? 0 : start), end, gap: false })
    cursor = end
  }
  if (!runs.length)
    return []
  if (durationMs - cursor >= gapMs)
    runs.push({ name: GAP_NAME, start: cursor, end: durationMs, gap: true })
  else
    runs[runs.length - 1].end = durationMs

  // Speed, rate and a kind (for colour) come from the actions, as for detected ones.
  const bins = Math.max(1, Math.ceil(durationMs / BIN_MS))
  const sums = prefix(movementBins(actions, bins))
  const peaks = opts.peaks ?? detectPeaks(actions)
  const chapters: Chapter[] = runs.map((r, index) => {
    const lo = Math.min(bins, Math.floor(r.start / BIN_MS))
    const hi = Math.min(bins, Math.max(lo + 1, Math.ceil(r.end / BIN_MS)))
    const avgSpeed = (sums[hi] - sums[lo]) / (hi - lo)
    return {
      index,
      start: r.start,
      end: r.end,
      kind: avgSpeed < IDLE_SPEED ? 'break' : tierOf(avgSpeed),
      name: r.name,
      avgSpeed,
      avgSpm: spmIn(peaks, r.start, r.end),
      source: 'author',
    }
  })
  const moving = chapters.filter(c => c.kind !== 'break')
  if (moving.length >= 2) {
    const top = moving.reduce((a, b) => (b.avgSpeed > a.avgSpeed ? b : a))
    const total = moving.reduce((n, c) => n + (c.end - c.start), 0)
    const mean = moving.reduce((n, c) => n + c.avgSpeed * (c.end - c.start), 0) / (total || 1)
    if (top.avgSpeed >= mean * 1.15 && top.avgSpeed >= SLOW_MAX)
      top.kind = 'peak'
  }
  return chapters
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

/** The chapter containing `ms`, or null outside them all. */
export function chapterAt(chapters: Chapter[], ms: number): Chapter | null {
  let lo = 0
  let hi = chapters.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = chapters[mid]
    if (ms < c.start)
      hi = mid - 1
    else if (ms >= c.end)
      lo = mid + 1
    else
      return c
  }
  // Past the end of the last chapter (the video runs a little long): still the last.
  const last = chapters[chapters.length - 1]
  return last && ms >= last.end ? last : null
}

/** Where "next chapter" goes from `ms`, or null in the last one. */
export function nextChapter(chapters: Chapter[], ms: number): Chapter | null {
  // A little slack, so pressing it right after a jump does not land on the same start.
  return chapters.find(c => c.start > ms + 500) ?? null
}

/**
 * Where "previous chapter" goes from `ms`: the start of this one if we are
 * more than `restartMs` into it, otherwise the one before — like a track list.
 */
export function prevChapter(chapters: Chapter[], ms: number, restartMs = 3000): Chapter | null {
  const cur = chapterAt(chapters, ms)
  if (!cur)
    return null
  if (ms - cur.start > restartMs)
    return cur
  return chapters[cur.index - 1] ?? cur
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, Chapter[]>()
const MAX_CACHED = 16

/**
 * `buildChapters`, remembered by `key` (script identity) and duration, so the
 * timeline, the dock and the player share one result.
 */
export function chaptersFor(key: string, actions: Action[], opts: ChapterOptions = {}): Chapter[] {
  const full = `${key}|${Math.round((opts.durationMs ?? 0) / 1000)}`
  const hit = cache.get(full)
  if (hit)
    return hit
  const result = buildChapters(actions, opts)
  if (cache.size >= MAX_CACHED)
    cache.delete(cache.keys().next().value!)
  cache.set(full, result)
  return result
}

/** The bits of a loaded script this needs; a scriptStore ScriptFile is one. */
export interface ChapterSource {
  filename: string
  channel: string
  parsed: { actions: Action[] }
}

/**
 * Chapters for a loaded script, for components: `durationSec` is the video's
 * length (0 while unknown), `peaks` the analysis's, when it has them, and
 * `metadata` the script's metadata block — its author's chapters win when it
 * has any usable ones.
 */
export function chaptersForScript(
  script: ChapterSource | null | undefined,
  durationSec = 0,
  peaks?: Peak[],
  metadata?: unknown,
): Chapter[] {
  if (!script || script.parsed.actions.length < 2)
    return []
  const key = `${script.filename}:${script.channel}:${script.parsed.actions.length}`
  const durationMs = durationSec * 1000
  const written = (metadata as { chapters?: unknown } | null | undefined)?.chapters
  if (Array.isArray(written) && written.length) {
    const authorKey = `${key}|author|${JSON.stringify(written)}|${Math.round(durationSec)}`
    let hit = cache.get(authorKey)
    if (!hit) {
      hit = authorChapters(script.parsed.actions, metadata, { durationMs, peaks })
      if (cache.size >= MAX_CACHED)
        cache.delete(cache.keys().next().value!)
      cache.set(authorKey, hit)
    }
    if (hit.length)
      return hit
  }
  return chaptersFor(key, script.parsed.actions, { durationMs, peaks })
}
