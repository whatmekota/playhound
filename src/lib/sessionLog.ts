/**
 * A log of sessions: when each started and ended, what played, the edges
 * and finishes in it, and the heart rate and pace around them.
 *
 * Per-video totals (statsStore) cannot say how long a session ran before a
 * finish, whether edging made it longer, or what was on when it ended, so
 * this keeps one record per session. A session is everything from the first
 * video, edge or finish until nothing has happened for SESSION_GAP_MS; a
 * video that is still open keeps its session going however long it runs.
 *
 * Logging started with storage schema 4 (see persist.ts), which stamped
 * `since`, so Stats can say which findings only cover sessions since then.
 *
 * Vue-free so it is unit tested directly; the stats store holds the state.
 */

export interface SessionPlay {
  video: string
  /** Wall clock, ms. */
  from: number
  /** How long it stayed open, ms; 0 while it still is. */
  ms: number
}

export interface SessionEdge {
  ts: number
  video: string | null
  /** Seconds into the video, when one was playing. */
  at: number | null
  /** Heart rate at the moment, when a monitor was on. */
  bpm?: number
  /** Who called it: key, heart, programme, rule… */
  source?: string
}

export interface SessionFinish {
  ts: number
  video: string
  at: number
  /** The script's stroke rate right there, strokes a minute. */
  spm?: number
  /** How hard the script was going right there against the rest of it, 0–1. */
  moment?: number
  bpm?: number
  /** Highest heart rate over the two minutes before. */
  peakBpm?: number
}

export interface SessionHeart {
  min: number
  max: number
  mean: number
  /** Readings, about one a second. */
  n: number
}

export interface SessionLog {
  start: number
  /** Last thing that happened; for an open video, when it was last written. */
  end: number
  plays: SessionPlay[]
  edges: SessionEdge[]
  finishes: SessionFinish[]
  heart?: SessionHeart
}

export interface SessionHistory {
  /** When logging began. */
  since: number
  sessions: SessionLog[]
}

/** Half an hour with nothing playing and nothing called ends a session. */
export const SESSION_GAP_MS = 30 * 60_000
export const MAX_SESSIONS = 500
/** Per session, so one marathon cannot grow without bound. */
export const MAX_ITEMS = 300

export function emptyHistory(now = Date.now()): SessionHistory {
  return { since: now, sessions: [] }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Whatever storage holds, as a history that is safe to read. */
export function normaliseHistory(raw: unknown, now = Date.now()): SessionHistory {
  const r = raw as Partial<SessionHistory> | null
  if (!r || typeof r !== 'object' || !Array.isArray(r.sessions))
    return emptyHistory(now)
  const sessions = r.sessions.filter((s): s is SessionLog =>
    !!s && isNum(s.start) && isNum(s.end) && Array.isArray(s.plays) && Array.isArray(s.edges) && Array.isArray(s.finishes))
  return { since: isNum(r.since) ? r.since : now, sessions: sessions.slice(-MAX_SESSIONS) }
}

/**
 * The session something happening at `now` belongs to: the last one, if it
 * is still going (a video open, or the last thing within the gap), else a
 * new one. Mutates `h`.
 */
export function sessionAt(h: SessionHistory, now: number, open: boolean): SessionLog {
  const last = h.sessions[h.sessions.length - 1]
  if (last && (open || now - last.end < SESSION_GAP_MS)) {
    last.end = Math.max(last.end, now)
    return last
  }
  const s: SessionLog = { start: now, end: now, plays: [], edges: [], finishes: [] }
  h.sessions.push(s)
  if (h.sessions.length > MAX_SESSIONS)
    h.sessions.splice(0, h.sessions.length - MAX_SESSIONS)
  return s
}

/** The running session's start, or null when there is none. */
export function currentSessionStart(h: SessionHistory, now: number, open: boolean): number | null {
  const last = h.sessions[h.sessions.length - 1]
  if (!last)
    return null
  return open || now - last.end < SESSION_GAP_MS ? last.start : null
}

export function pushCapped<T>(list: T[], item: T) {
  list.push(item)
  if (list.length > MAX_ITEMS)
    list.splice(0, list.length - MAX_ITEMS)
}

/** Running heart-rate figures, folded into a session when it is written. */
export interface HeartAcc { sum: number, n: number, min: number, max: number }

export function emptyHeartAcc(): HeartAcc {
  return { sum: 0, n: 0, min: Number.POSITIVE_INFINITY, max: 0 }
}

export function addHeart(acc: HeartAcc, bpm: number) {
  acc.sum += bpm
  acc.n++
  acc.min = Math.min(acc.min, bpm)
  acc.max = Math.max(acc.max, bpm)
}

/** Fold readings into a session's heart summary, and empty the accumulator. */
export function foldHeart(s: SessionLog, acc: HeartAcc) {
  if (!acc.n)
    return
  const h = s.heart
  const n = (h?.n ?? 0) + acc.n
  const mean = ((h ? h.mean * h.n : 0) + acc.sum) / n
  s.heart = {
    min: Math.min(h?.min ?? Number.POSITIVE_INFINITY, acc.min),
    max: Math.max(h?.max ?? 0, acc.max),
    mean: Math.round(mean * 10) / 10,
    n,
  }
  Object.assign(acc, emptyHeartAcc())
}

/** How long a session ran, ms. */
export function sessionLength(s: SessionLog): number {
  return Math.max(0, s.end - s.start)
}
