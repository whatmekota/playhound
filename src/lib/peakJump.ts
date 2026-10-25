import type { Chapter } from './chapters'

/**
 * "Jump to the good part", from a script's chapters.
 *
 * Next peak goes to the next chapter the script marks as fast or peak; if
 * there is none ahead it falls back to the most intense chapter ahead, and
 * past the last one it wraps to the first peak of the video. Finish goes to
 * the most intense chapter of all — where a session is meant to end.
 */

const HOT: ReadonlySet<Chapter['kind']> = new Set(['peak', 'fast'])

/** Slack after the playhead, so pressing it right after a jump moves on. */
const AHEAD_MS = 500

export interface PeakJump {
  chapter: Chapter
  /** True when it went back to the start to find one. */
  wrapped: boolean
}

export function nextPeak(chapters: readonly Chapter[], ms: number): PeakJump | null {
  if (chapters.length < 2)
    return null
  const ahead = chapters.filter(c => c.start > ms + AHEAD_MS)
  const hot = ahead.find(c => HOT.has(c.kind))
  if (hot)
    return { chapter: hot, wrapped: false }

  // Nothing marked hot ahead: the most intense of what is left, as long as
  // it is livelier than where we are.
  const here = chapters.find(c => ms >= c.start && ms < c.end)
  const best = mostIntense(ahead)
  if (best && best.avgSpeed > (here?.avgSpeed ?? 0))
    return { chapter: best, wrapped: false }

  // Past the last one: around to the first hot chapter that is not this one.
  const first = chapters.find(c => HOT.has(c.kind) && c !== here && c.start + AHEAD_MS < ms)
  return first ? { chapter: first, wrapped: true } : null
}

/** The most intense chapter in the video; the later one on a tie. */
export function finishChapter(chapters: readonly Chapter[]): Chapter | null {
  return chapters.length < 2 ? null : mostIntense(chapters)
}

function mostIntense(chapters: readonly Chapter[]): Chapter | null {
  let best: Chapter | null = null
  for (const c of chapters) {
    if (c.kind === 'break')
      continue
    if (!best || c.avgSpeed >= best.avgSpeed)
      best = c
  }
  return best
}
