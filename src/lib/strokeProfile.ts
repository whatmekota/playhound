/**
 * A script's strokes as data: where each bottom and top is, how deep, and
 * the stroke rate through the video. For plugins that match videos by their
 * motion (library.strokes, API 5), worked out once and kept, so a plugin
 * looking over a whole library doesn't read every script each time.
 *
 * Pure: actions in, a profile out.
 */

/** One stroke: from a bottom up to the top and back down to the next bottom. */
export interface ProfileStroke {
  /** ms: the bottom it starts from. */
  at: number
  /** ms: its top. */
  top: number
  /** ms: the next bottom. */
  end: number
  /** How far it travels, 0–100. */
  depth: number
}

export interface StrokeProfile {
  /** ms: the script's last action. */
  duration: number
  /** The typical stroke rate, strokes/min (the median over strokes); 0 with none. */
  spm: number
  strokes: ProfileStroke[]
  /** The stroke rate through the video, per `TEMPO_STEP_MS`: strokes/min, 0 where it holds still. */
  tempo: number[]
  tempoStep: number
}

export const TEMPO_STEP_MS = 5000
/** Reversals smaller than this are wobble within a stroke, not strokes of their own. */
const MIN_TRAVEL = 8
/** A "stroke" longer than this is a pause with a move in it. */
const MAX_STROKE_MS = 4000

interface Action { at: number, pos: number }

/** The turning points that matter: alternating lows and highs, wobble of less than MIN_TRAVEL left out. */
export function extremes(actions: readonly Action[], minTravel = MIN_TRAVEL): { at: number, pos: number, low: boolean }[] {
  const out: { at: number, pos: number, low: boolean }[] = []
  if (actions.length < 2)
    return out
  // Until the script has moved MIN_TRAVEL, the lowest and highest so far;
  // whichever came first is the first extreme.
  let lo = actions[0]
  let hi = actions[0]
  let cand = actions[0]
  let dir = 0
  for (let i = 1; i < actions.length; i++) {
    const a = actions[i]
    if (dir === 0) {
      if (a.pos < lo.pos)
        lo = a
      if (a.pos > hi.pos)
        hi = a
      if (hi.pos - lo.pos >= minTravel) {
        const lowFirst = lo.at < hi.at
        out.push({ at: (lowFirst ? lo : hi).at, pos: (lowFirst ? lo : hi).pos, low: lowFirst })
        dir = lowFirst ? 1 : -1
        cand = lowFirst ? hi : lo
      }
      continue
    }
    if ((dir > 0 && a.pos >= cand.pos) || (dir < 0 && a.pos <= cand.pos)) {
      // Further the same way: a better candidate. On a hold, the extreme is where it arrives.
      if (a.pos !== cand.pos)
        cand = a
    }
    else if (Math.abs(a.pos - cand.pos) >= minTravel) {
      out.push({ at: cand.at, pos: cand.pos, low: dir < 0 })
      dir = -dir
      cand = a
    }
  }
  if (dir !== 0)
    out.push({ at: cand.at, pos: cand.pos, low: dir < 0 })
  return out
}

export function strokeProfile(actions: readonly Action[]): StrokeProfile {
  const sorted = [...actions].sort((x, y) => x.at - y.at)
  const duration = sorted.length ? Math.round(sorted[sorted.length - 1].at) : 0
  const ex = extremes(sorted)
  const strokes: ProfileStroke[] = []
  for (let i = 0; i + 2 < ex.length; i++) {
    const lo = ex[i]
    if (!lo.low)
      continue
    const hi = ex[i + 1]
    const next = ex[i + 2]
    if (next.at - lo.at > MAX_STROKE_MS)
      continue
    strokes.push({
      at: Math.round(lo.at),
      top: Math.round(hi.at),
      end: Math.round(next.at),
      depth: Math.round(Math.max(hi.pos - lo.pos, hi.pos - next.pos)),
    })
  }

  const periods = strokes.map(s => s.end - s.at).sort((x, y) => x - y)
  const mid = periods.length >> 1
  const typical = !periods.length ? 0 : periods.length % 2 ? periods[mid] : (periods[mid - 1] + periods[mid]) / 2
  const spm = typical > 0 ? Math.round(60000 / typical) : 0

  // Stroke rate per window: the strokes whose middle falls in it, by the time they span.
  const windows = Math.max(0, Math.ceil(duration / TEMPO_STEP_MS))
  const count = Array.from<number>({ length: windows }).fill(0)
  const span = Array.from<number>({ length: windows }).fill(0)
  for (const s of strokes) {
    const w = Math.min(windows - 1, Math.floor((s.at + s.end) / 2 / TEMPO_STEP_MS))
    if (w < 0)
      continue
    count[w]++
    span[w] += s.end - s.at
  }
  const tempo = count.map((c, w) => c && span[w] > 0 ? Math.round((60000 * c) / span[w]) : 0)

  return { duration, spm, strokes, tempo, tempoStep: TEMPO_STEP_MS }
}
