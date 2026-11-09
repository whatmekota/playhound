/**
 * Insights: what the stats add up to, in sentences worth reading.
 *
 * Built from what is actually logged: per-video totals (plays, watch time,
 * finishes and edges with their timestamps), watch time per day, and, for
 * sessions since the session log began (see ./sessionLog), when each session
 * started and ended, what played, and the heart rate and pace around edges
 * and finishes.
 *
 * Every finding has a minimum sample below which it is not shown at all, and
 * says how many it is based on. Below the bar it goes into `pending` with
 * what it still needs, so the Stats view can say "after 3 sessions with a
 * finish" rather than draw a chart of noise.
 *
 * Pure: the view hands in the stores' data and a lookup for what the library
 * knows about a video (its tags and script intensity band).
 */

import type { SessionHistory, SessionLog } from './sessionLog'
import type { DayStat, VideoStat } from '~/stores/statsStore'
import { SESSION_GAP_MS, sessionLength } from './sessionLog'
import { dayKey, formatDuration, formatTime } from './time'

export type Band = 'gentle' | 'medium' | 'intense'

export interface VideoInfo {
  tags: readonly string[]
  band: Band | null
}

export interface InsightInput {
  now: number
  videos: readonly VideoStat[]
  daily: Readonly<Record<string, DayStat>>
  history: SessionHistory
  /** The running video's watch time not yet folded into the totals, ms. */
  liveMs?: number
  info?: (videoName: string) => VideoInfo | null
}

export interface InsightBar {
  label: string
  /** 0–1, the bar's length. */
  value: number
  display: string
  highlight?: boolean
  /** Small print after the label: "12 plays". */
  sub?: string
}

export type InsightId
  = | 'week' | 'time-to-finish' | 'finish-point' | 'band' | 'tags'
    | 'edging' | 'enders' | 'time-of-day' | 'weekday' | 'heart' | 'pace'

export interface Insight {
  id: InsightId
  icon: string
  title: string
  /** The finding. */
  text: string
  /** A second finding, or a suggestion. */
  more?: string
  /** What it is based on, and how much to trust it. */
  note: string
  bars?: InsightBar[]
  /** Only covers sessions since the session log began. */
  newOnly?: boolean
}

export interface PendingInsight {
  id: InsightId
  title: string
  /** What it still needs: "3 sessions with a finish (1 so far)". */
  need: string
  newOnly?: boolean
}

export interface InsightReport {
  insights: Insight[]
  pending: PendingInsight[]
  /** When the session log began. */
  since: number
  /** Sessions logged so far, the running one included. */
  sessions: number
}

// ─── Thresholds ──────────────────────────────────────────────────────────────────

export const MIN = {
  timeToFinish: 3,
  trend: 6,
  finishPoint: 5,
  pointTrend: 10,
  bandPlays: 5,
  bandTotal: 15,
  tagPlays: 5,
  tagFinishes: 3,
  edgingEach: 3,
  enderSessions: 5,
  timeOfDay: 5,
  weekdayDays: 8,
  weekdaySpanDays: 21,
  heartEdges: 3,
  heartFinishes: 2,
  pace: 3,
} as const

/** Below this many, a finding says outright that it is early days. */
const SOLID = 10
const DAY = 86_400_000
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

// ─── Small helpers ───────────────────────────────────────────────────────────────

export function median(xs: readonly number[]): number {
  if (!xs.length)
    return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length)
    return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, (s.length - 1) * q))
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "only 3 sessions so far" for small samples, "12 sessions" otherwise. */
export function sample(n: number, one: string, many = `${one}s`): string {
  return n < SOLID ? `only ${plural(n, one, many)} so far` : plural(n, one, many)
}

/** "1 in 4" for a rate, rounded to something sayable. */
export function oneIn(rate: number): string {
  if (rate <= 0)
    return 'never'
  if (rate >= 0.95)
    return 'nearly every time'
  if (rate > 0.5)
    return `${Math.round(rate * 10)} in 10`
  return `1 in ${Math.round(1 / rate)}`
}

const minutes = (ms: number) => `${Math.round(ms / 60000)} min`

function change(now: number, before: number): string {
  if (before <= 0)
    return ''
  const r = now / before - 1
  if (Math.abs(r) < 0.1)
    return 'about the same as'
  return `${r > 0 ? 'up' : 'down'} ${Math.round(Math.abs(r) * 100)}% on`
}

const hh = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`
const stripExt = (n: string) => n.replace(/\.[^.]+$/, '')

/** Sessions that are over: nothing has happened for the gap, or a newer one began. */
export function completedSessions(h: SessionHistory, now: number, open: boolean): SessionLog[] {
  const list = h.sessions
  return list.filter((s, i) => i < list.length - 1 || (!open && now - s.end >= SESSION_GAP_MS))
}

// ─── The findings ────────────────────────────────────────────────────────────────

function weekCompare(input: InsightInput): Insight | null {
  const { now, daily, videos } = input
  const dayMs = (i: number) => {
    const k = dayKey(now - i * DAY)
    return (daily[k]?.ms ?? 0) + (i === 0 ? input.liveMs ?? 0 : 0)
  }
  let thisMs = 0
  let lastMs = 0
  let thisDays = 0
  for (let i = 0; i < 7; i++) {
    const ms = dayMs(i)
    thisMs += ms
    if (ms > 0)
      thisDays++
    lastMs += dayMs(i + 7)
  }
  // Midnight six days ago: the same seven calendar days as the chart.
  const d = new Date(now)
  const weekStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime()
  const prevStart = weekStart - 7 * DAY
  let fThis = 0
  let fLast = 0
  let eThis = 0
  let eLast = 0
  for (const v of videos) {
    for (const f of v.finishEvents) {
      if (f.ts >= weekStart)
        fThis++
      else if (f.ts >= prevStart)
        fLast++
    }
    for (const e of v.edgeEvents ?? []) {
      if (e.ts >= weekStart)
        eThis++
      else if (e.ts >= prevStart)
        eLast++
    }
  }
  if (thisMs <= 0 && lastMs <= 0 && !fThis && !fLast)
    return null

  const delta = change(thisMs, lastMs)
  const text = thisMs > 0
    ? `${formatDuration(thisMs)} over ${plural(thisDays, 'day')}${lastMs > 0 ? `, ${delta} the week before (${formatDuration(lastMs)})` : ', with nothing the week before to compare it with'}.`
    : `Nothing watched yet this week, after ${formatDuration(lastMs)} the week before.`
  const max = Math.max(thisMs, lastMs, 1)
  return {
    id: 'week',
    icon: 'i-carbon-calendar',
    title: 'This week',
    text,
    more: `${plural(fThis, 'finish', 'finishes')} and ${plural(eThis, 'edge')} this week; ${fLast} and ${eLast} the week before.`,
    note: 'The last 7 days against the 7 before them.',
    bars: [
      { label: 'Last 7 days', value: thisMs / max, display: formatDuration(thisMs), highlight: true },
      { label: 'The 7 before', value: lastMs / max, display: formatDuration(lastMs) },
    ],
  }
}

function timeToFinish(sessions: readonly SessionLog[], out: PendingInsight[]): Insight | null {
  const times = sessions
    .filter(s => s.finishes.length)
    .map(s => Math.max(0, Math.min(...s.finishes.map(f => f.ts)) - s.start))
  if (times.length < MIN.timeToFinish) {
    out.push({ id: 'time-to-finish', title: 'Time to finish', need: `${MIN.timeToFinish} sessions with a finish (${times.length} so far)`, newOnly: true })
    return null
  }
  const m = median(times)
  let more: string | undefined
  if (times.length >= MIN.trend) {
    const half = times.length >> 1
    const before = median(times.slice(0, times.length - half))
    const recent = median(times.slice(times.length - half))
    const r = recent / Math.max(1, before) - 1
    more = Math.abs(r) < 0.15
      ? `Steady: about ${minutes(recent)} in your last ${half}, much as before.`
      : `${r < 0 ? 'Getting quicker' : 'Taking longer'}: ${minutes(recent)} in your last ${half}, against ${minutes(before)} before.`
  }
  return {
    id: 'time-to-finish',
    icon: 'i-carbon-timer',
    title: 'Time to finish',
    text: `A session takes about ${minutes(m)} from the first video to a finish (median; quickest ${minutes(Math.min(...times))}, longest ${minutes(Math.max(...times))}).`,
    more,
    note: `From ${sample(times.length, 'session with a finish', 'sessions with a finish')}.`,
    newOnly: true,
  }
}

function finishPoint(videos: readonly VideoStat[], out: PendingInsight[]): Insight | null {
  const all = videos.flatMap(v => v.finishEvents).filter(f => Number.isFinite(f.at) && f.at > 0).sort((a, b) => a.ts - b.ts)
  if (all.length < MIN.finishPoint) {
    out.push({ id: 'finish-point', title: 'Where in a video you finish', need: `${MIN.finishPoint} finishes (${all.length} so far)` })
    return null
  }
  const at = all.map(f => f.at)
  let more: string | undefined
  if (all.length >= MIN.pointTrend) {
    const half = all.length >> 1
    const before = median(at.slice(0, all.length - half))
    const recent = median(at.slice(all.length - half))
    const r = recent / Math.max(1, before) - 1
    if (Math.abs(r) >= 0.2)
      more = `${r > 0 ? 'Later' : 'Sooner'} than you used to: around ${formatTime(recent)} in your last ${half}, ${formatTime(before)} before that.`
  }
  const early = at.filter(t => t < 120).length
  return {
    id: 'finish-point',
    icon: 'i-carbon-flag-filled',
    title: 'Where in a video you finish',
    text: `Usually about ${formatTime(median(at))} in (median), half of them between ${formatTime(quantile(at, 0.25))} and ${formatTime(quantile(at, 0.75))}.`,
    more: more ?? (early / at.length >= 0.3 ? `${early} of ${at.length} came in the first two minutes of a video: often after skipping ahead.` : undefined),
    note: `From ${sample(at.length, 'finish', 'finishes')}, all of them, not only new sessions.`,
  }
}

interface Rate { plays: number, finishes: number, videos: number }

function rateOf(r: Rate) {
  return r.plays ? r.finishes / r.plays : 0
}

const NEEDS_LIBRARY = 'your library open, to know each video\'s tags and script'

function byBand(input: InsightInput, out: PendingInsight[]): Insight | null {
  if (!input.info) {
    out.push({ id: 'band', title: 'Finishes by script intensity', need: NEEDS_LIBRARY })
    return null
  }
  const bands: Record<Band, Rate> = {
    gentle: { plays: 0, finishes: 0, videos: 0 },
    medium: { plays: 0, finishes: 0, videos: 0 },
    intense: { plays: 0, finishes: 0, videos: 0 },
  }
  for (const v of input.videos) {
    const b = input.info(v.videoName)?.band
    if (!b || !v.totalPlays)
      continue
    bands[b].plays += v.totalPlays
    bands[b].finishes += v.finishEvents.length
    bands[b].videos++
  }
  const total = Object.values(bands).reduce((s, r) => s + r.plays, 0)
  const enough = (Object.keys(bands) as Band[]).filter(b => bands[b].plays >= MIN.bandPlays)
  const finishes = Object.values(bands).reduce((s, r) => s + r.finishes, 0)
  if (total < MIN.bandTotal || enough.length < 2 || finishes < 2) {
    out.push({ id: 'band', title: 'Finishes by script intensity', need: `${MIN.bandTotal} plays of analysed scripts across two intensity bands (${total} so far)` })
    return null
  }
  const ranked = [...enough].sort((a, b) => rateOf(bands[b]) - rateOf(bands[a]))
  const top = ranked[0]
  const low = ranked[ranked.length - 1]
  const maxRate = Math.max(...enough.map(b => rateOf(bands[b])), 0.0001)
  const label: Record<Band, string> = { gentle: 'Gentle', medium: 'Medium', intense: 'Intense' }
  const same = rateOf(bands[top]) - rateOf(bands[low]) < 0.03
  return {
    id: 'band',
    icon: 'i-carbon-fire',
    title: 'Finishes by script intensity',
    text: same
      ? `No band stands out: ${label[top].toLowerCase()} and ${label[low].toLowerCase()} scripts end in a finish about as often (${oneIn(rateOf(bands[top]))} plays).`
      : `${label[top]} scripts end in a finish most often: ${oneIn(rateOf(bands[top]))} plays, against ${oneIn(rateOf(bands[low]))} for ${label[low].toLowerCase()} ones.`,
    note: `Finishes per play, ${plural(total, 'play')} of analysed scripts. Every time a video is opened counts as a play, skims too.`,
    bars: (['gentle', 'medium', 'intense'] as Band[]).map(b => ({
      label: label[b],
      value: bands[b].plays >= MIN.bandPlays ? rateOf(bands[b]) / maxRate : 0,
      display: bands[b].plays >= MIN.bandPlays ? oneIn(rateOf(bands[b])) : 'too few',
      sub: plural(bands[b].plays, 'play'),
      highlight: b === top && !same,
    })),
  }
}

/** Tags that only restate the intensity band, or say nothing useful here. */
const SKIP_TAGS = new Set(['gentle', 'medium', 'intense', 'unscripted'])

function byTag(input: InsightInput, out: PendingInsight[]): Insight | null {
  if (!input.info) {
    out.push({ id: 'tags', title: 'Finishes by tag', need: NEEDS_LIBRARY })
    return null
  }
  let plays = 0
  let finishes = 0
  const tags = new Map<string, Rate>()
  for (const v of input.videos) {
    if (!v.totalPlays)
      continue
    plays += v.totalPlays
    finishes += v.finishEvents.length
    for (const t of input.info(v.videoName)?.tags ?? []) {
      if (SKIP_TAGS.has(t))
        continue
      const r = tags.get(t) ?? { plays: 0, finishes: 0, videos: 0 }
      r.plays += v.totalPlays
      r.finishes += v.finishEvents.length
      r.videos++
      tags.set(t, r)
    }
  }
  const usable = [...tags].filter(([, r]) => r.plays >= MIN.tagPlays && r.videos >= 2)
  if (finishes < MIN.tagFinishes || !usable.length) {
    out.push({ id: 'tags', title: 'Finishes by tag', need: `${MIN.tagFinishes} finishes and a tag on two videos played ${MIN.tagPlays}+ times (${finishes} finishes so far)` })
    return null
  }
  const overall = finishes / plays
  const ranked = usable.sort((a, b) => rateOf(b[1]) - rateOf(a[1]) || b[1].plays - a[1].plays).slice(0, 5)
  const [bestTag, best] = ranked[0]
  const ratio = rateOf(best) / Math.max(overall, 0.0001)
  const maxRate = Math.max(rateOf(best), overall, 0.0001)
  const text = ratio >= 1.4
    ? `Videos tagged "${bestTag}" end in a finish ${oneIn(rateOf(best))} plays, ${ratio >= 1.9 ? `about ${Math.round(ratio)} times` : 'well above'} your usual ${oneIn(overall)}.`
    : `No tag stands out yet: the best, "${bestTag}", ends in a finish ${oneIn(rateOf(best))} plays, close to your usual ${oneIn(overall)}.`
  return {
    id: 'tags',
    icon: 'i-carbon-tag',
    title: 'Finishes by tag',
    text,
    note: `Tags on two or more videos with ${MIN.tagPlays}+ plays; your own tags and the automatic ones, as they are now.`,
    bars: [
      ...ranked.map(([t, r], i) => ({ label: t, value: rateOf(r) / maxRate, display: oneIn(rateOf(r)), sub: plural(r.plays, 'play'), highlight: i === 0 && ratio >= 1.4 })),
      { label: 'All videos', value: overall / maxRate, display: oneIn(overall), sub: plural(plays, 'play') },
    ],
  }
}

function edging(done: readonly SessionLog[], out: PendingInsight[]): Insight | null {
  const real = done.filter(s => sessionLength(s) >= 60_000)
  const withE = real.filter(s => s.edges.length)
  const without = real.filter(s => !s.edges.length)
  if (withE.length < MIN.edgingEach || without.length < MIN.edgingEach) {
    out.push({ id: 'edging', title: 'Does edging make sessions longer?', need: `${MIN.edgingEach} sessions with edges and ${MIN.edgingEach} without (${withE.length} and ${without.length} so far)`, newOnly: true })
    return null
  }
  const a = median(withE.map(sessionLength))
  const b = median(without.map(sessionLength))
  const r = a / Math.max(1, b) - 1
  const finRate = (l: SessionLog[]) => l.filter(s => s.finishes.length).length
  const text = Math.abs(r) < 0.15
    ? `Not by much: sessions with edges run ${minutes(a)} (median), those without ${minutes(b)}.`
    : r > 0
      ? `Yes: sessions with edges run ${minutes(a)} (median), ${r >= 0.9 ? `about ${(a / b).toFixed(1).replace(/\.0$/, '')}×` : `${Math.round(r * 100)}% longer than`} the ${minutes(b)} of those without.`
      : `No, the opposite: sessions with edges run ${minutes(a)} (median), shorter than the ${minutes(b)} of those without.`
  const max = Math.max(a, b, 1)
  return {
    id: 'edging',
    icon: 'i-carbon-hourglass',
    title: 'Does edging make sessions longer?',
    text,
    more: `${finRate(withE)} of ${withE.length} sessions with edges ended in a finish; ${finRate(without)} of ${without.length} without.`,
    note: `${withE.length + without.length < SOLID * 2 ? 'Early days: ' : ''}${plural(withE.length, 'session')} with edges, ${plural(without.length, 'session')} without.`,
    bars: [
      { label: 'With edges', value: a / max, display: minutes(a), sub: plural(withE.length, 'session'), highlight: r > 0.15 },
      { label: 'Without', value: b / max, display: minutes(b), sub: plural(without.length, 'session') },
    ],
    newOnly: true,
  }
}

function enders(done: readonly SessionLog[], out: PendingInsight[]): Insight | null {
  const ended = done.filter(s => s.plays.length)
  if (ended.length < MIN.enderSessions) {
    out.push({ id: 'enders', title: 'What ends a session', need: `${MIN.enderSessions} finished sessions with a video (${ended.length} so far)`, newOnly: true })
    return null
  }
  const counts = new Map<string, { n: number, finished: number }>()
  for (const s of ended) {
    const last = s.plays[s.plays.length - 1].video
    const c = counts.get(last) ?? { n: 0, finished: 0 }
    c.n++
    if (s.finishes.some(f => f.video === last))
      c.finished++
    counts.set(last, c)
  }
  const top = [...counts].filter(([, c]) => c.n >= 2).sort((a, b) => b[1].n - a[1].n).slice(0, 4)
  const finishedLast = ended.filter(s => s.finishes.length && s.finishes[s.finishes.length - 1].video === s.plays[s.plays.length - 1].video).length
  if (!top.length) {
    return {
      id: 'enders',
      icon: 'i-carbon-stop-filled-alt',
      title: 'What ends a session',
      text: `No video stands out: each of your last ${ended.length} sessions ended on a different one.`,
      more: `${finishedLast} of ${ended.length} ended on the video you finished to.`,
      note: `From ${sample(ended.length, 'session')}.`,
      newOnly: true,
    }
  }
  const [name, c] = top[0]
  return {
    id: 'enders',
    icon: 'i-carbon-stop-filled-alt',
    title: 'What ends a session',
    text: `"${stripExt(name)}" ended ${c.n} of your ${ended.length} sessions${c.finished ? `, ${c.finished === c.n ? 'each time' : `${c.finished} times`} with a finish` : ''}.`,
    more: `${finishedLast} of ${ended.length} sessions ended on the video you finished to.`,
    note: `The last video of each session; ${sample(ended.length, 'session')}.`,
    bars: top.map(([n, x], i) => ({ label: stripExt(n), value: x.n / c.n, display: `${x.n}×`, sub: x.finished ? `${x.finished} with a finish` : undefined, highlight: i === 0 })),
    newOnly: true,
  }
}

function timeOfDay(videos: readonly VideoStat[], out: PendingInsight[]): Insight | null {
  const hours = Array.from<number>({ length: 24 }).fill(0)
  let n = 0
  for (const v of videos) {
    for (const f of v.finishEvents) {
      hours[new Date(f.ts).getHours()]++
      n++
    }
  }
  if (n < MIN.timeOfDay) {
    out.push({ id: 'time-of-day', title: 'Time of day', need: `${MIN.timeOfDay} finishes (${n} so far)` })
    return null
  }
  // The busiest three-hour window, wrapping past midnight.
  let best = 0
  let bestAt = 0
  for (let h = 0; h < 24; h++) {
    const c = hours[h] + hours[(h + 1) % 24] + hours[(h + 2) % 24]
    if (c > best) {
      best = c
      bestAt = h
    }
  }
  const share = best / n
  return {
    id: 'time-of-day',
    icon: 'i-carbon-time',
    title: 'Time of day',
    text: share >= 0.4
      ? `Most finishes come between ${hh(bestAt)} and ${hh(bestAt + 3)}: ${best} of ${n}.`
      : `No one time of day: your ${n} finishes are spread out (the busiest three hours, ${hh(bestAt)}–${hh(bestAt + 3)}, have ${best}).`,
    note: `From ${sample(n, 'finish', 'finishes')}; the hour chart is below.`,
  }
}

function weekday(input: InsightInput, out: PendingInsight[]): Insight | null {
  const keys = Object.keys(input.daily).filter(k => (input.daily[k]?.ms ?? 0) > 0).sort()
  const first = keys[0]
  const span = first ? Math.round((input.now - new Date(`${first}T12:00:00`).getTime()) / DAY) + 1 : 0
  if (keys.length < MIN.weekdayDays || span < MIN.weekdaySpanDays) {
    out.push({ id: 'weekday', title: 'Day of the week', need: `${MIN.weekdaySpanDays} days of history with ${MIN.weekdayDays} days watched (${keys.length} watched over ${span} days so far)` })
    return null
  }
  // Average over every calendar day since the first, watched or not, so a
  // weekday that is usually empty shows as such.
  const sum = Array.from<number>({ length: 7 }).fill(0)
  const count = Array.from<number>({ length: 7 }).fill(0)
  for (let i = 0; i < span; i++) {
    const ts = input.now - i * DAY
    const wd = (new Date(ts).getDay() + 6) % 7
    sum[wd] += input.daily[dayKey(ts)]?.ms ?? 0
    count[wd]++
  }
  const avg = sum.map((s, i) => (count[i] ? s / count[i] : 0))
  const overall = sum.reduce((a, b) => a + b, 0) / Math.max(1, span)
  const top = avg.indexOf(Math.max(...avg))
  const max = Math.max(...avg, 1)
  return {
    id: 'weekday',
    icon: 'i-carbon-calendar',
    title: 'Day of the week',
    text: avg[top] >= overall * 1.5
      ? `${WEEKDAYS[top]}s are your longest days: ${formatDuration(avg[top])} on average, against ${formatDuration(overall)} across the week.`
      : `Fairly even through the week: ${formatDuration(overall)} a day on average, ${WEEKDAYS[top]}s a little more (${formatDuration(avg[top])}).`,
    note: `Average watch time per weekday over the last ${span} days.`,
    bars: avg.map((v, i) => ({ label: WEEKDAYS[i].slice(0, 3), value: v / max, display: formatDuration(v), highlight: i === top })),
  }
}

function heart(sessions: readonly SessionLog[], out: PendingInsight[]): Insight | null {
  const edges = sessions.flatMap(s => s.edges).map(e => e.bpm).filter((b): b is number => !!b)
  const finishes = sessions.flatMap(s => s.finishes).map(f => f.bpm).filter((b): b is number => !!b)
  if (edges.length < MIN.heartEdges && finishes.length < MIN.heartFinishes) {
    out.push({ id: 'heart', title: 'Heart rate at edges and finishes', need: `a heart-rate monitor on for ${MIN.heartEdges} edges or ${MIN.heartFinishes} finishes (${edges.length} and ${finishes.length} so far)`, newOnly: true })
    return null
  }
  const parts: string[] = []
  if (edges.length >= MIN.heartEdges)
    parts.push(`edges come at about ${Math.round(median(edges))} bpm`)
  if (finishes.length >= MIN.heartFinishes)
    parts.push(`finishes at about ${Math.round(median(finishes))} bpm`)
  const text = `${parts.join(' and ')}.`
  let more: string | undefined
  if (edges.length >= 5) {
    // A line under three quarters of your edges: a rule there steps in first.
    const line = Math.floor(quantile(edges, 0.25) / 5) * 5
    more = `A rule at ${line} bpm (Rules panel) would step in before about three quarters of your edges.`
  }
  const peaks = sessions.flatMap(s => s.finishes).map(f => f.peakBpm).filter((b): b is number => !!b)
  if (!more && peaks.length >= MIN.heartFinishes)
    more = `In the two minutes before a finish it peaks around ${Math.round(median(peaks))} bpm.`
  return {
    id: 'heart',
    icon: 'i-carbon-favorite',
    title: 'Heart rate at edges and finishes',
    text: text[0].toUpperCase() + text.slice(1),
    more,
    note: `Median, from ${plural(edges.length, 'edge')} and ${plural(finishes.length, 'finish', 'finishes')} with a monitor on${edges.length + finishes.length < SOLID ? ': only a few so far' : ''}.`,
    newOnly: true,
  }
}

function pace(sessions: readonly SessionLog[], out: PendingInsight[]): Insight | null {
  const fs = sessions.flatMap(s => s.finishes).filter(f => f.spm !== undefined && f.spm > 0)
  if (fs.length < MIN.pace) {
    out.push({ id: 'pace', title: 'Pace at a finish', need: `${MIN.pace} finishes marked with a script playing (${fs.length} so far)`, newOnly: true })
    return null
  }
  const spm = fs.map(f => f.spm!)
  const moments = fs.map(f => f.moment).filter((m): m is number => m !== undefined)
  let more: string | undefined
  if (moments.length >= MIN.pace) {
    const m = median(moments)
    more = m >= 0.7
      ? 'Mostly in the busiest stretch of the script.'
      : m <= 0.4
        ? 'Mostly in a calmer part of the script, not at its busiest.'
        : 'Somewhere in the middle of the script\'s range, not only at its busiest.'
  }
  return {
    id: 'pace',
    icon: 'i-carbon-meter-alt',
    title: 'Pace at a finish',
    text: `You finish with the script at about ${Math.round(median(spm))} strokes a minute${spm.length >= 4 ? ` (half of them between ${Math.round(quantile(spm, 0.25))} and ${Math.round(quantile(spm, 0.75))})` : ''}.`,
    more,
    note: `From ${sample(spm.length, 'finish', 'finishes')} marked with C while a script played.`,
    newOnly: true,
  }
}

// ─── The report ──────────────────────────────────────────────────────────────────

export function buildInsights(input: InsightInput, open = false): InsightReport {
  const pending: PendingInsight[] = []
  const sessions = input.history.sessions
  const done = completedSessions(input.history, input.now, open)
  const found = [
    weekCompare(input),
    timeToFinish(sessions, pending),
    edging(done, pending),
    finishPoint(input.videos, pending),
    byBand(input, pending),
    byTag(input, pending),
    enders(done, pending),
    timeOfDay(input.videos, pending),
    weekday(input, pending),
    heart(sessions, pending),
    pace(sessions, pending),
  ].filter((x): x is Insight => !!x)
  return { insights: found, pending, since: input.history.since, sessions: sessions.length }
}

// ─── Preference ──────────────────────────────────────────────────────────────────

/**
 * How much you seem to like a video, 0–1, from how it has gone: finishes per
 * play (most), plays (a little, saturating) and edges per play (a little:
 * it held you near the edge). Neutral 0.5 with no history, so a director
 * leaning on it does not shut out what you have never played.
 */
export function preferenceScore(v: Pick<VideoStat, 'totalPlays' | 'finishEvents' | 'edgeEvents'> | null | undefined): number {
  if (!v || !v.totalPlays)
    return 0.5
  const plays = v.totalPlays
  // Shrunk toward a typical rate until there are a few plays to go on.
  const prior = 0.1
  const k = 3
  const finishRate = (v.finishEvents.length + prior * k) / (plays + k)
  const edgeRate = Math.min(1, (v.edgeEvents?.length ?? 0) / plays / 3)
  const familiarity = 1 - 1 / (1 + plays / 4)
  const raw = 0.6 * Math.min(1, finishRate * 2.5) + 0.25 * familiarity + 0.15 * edgeRate
  return Math.round(Math.min(1, Math.max(0, raw)) * 1000) / 1000
}

/**
 * Draw one item, each with a chance in proportion to its weight. Every
 * weight gets a floor, so leaning on a score never rules anything out.
 * `rand` is 0–1 (Math.random), passed in for tests.
 */
export function pickWeighted<T>(items: readonly T[], weight: (t: T) => number, rand: number, floor = 0.25): T | null {
  if (!items.length)
    return null
  const w = items.map(t => floor + Math.max(0, weight(t)))
  const total = w.reduce((a, b) => a + b, 0)
  let x = Math.min(0.999999, Math.max(0, rand)) * total
  for (let i = 0; i < items.length; i++) {
    x -= w[i]
    if (x < 0)
      return items[i]
  }
  return items[items.length - 1]
}
