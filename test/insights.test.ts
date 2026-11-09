import type { InsightInput, VideoInfo } from '../src/lib/insights'
import type { SessionHistory, SessionLog } from '../src/lib/sessionLog'
import type { DayStat, VideoStat } from '../src/stores/statsStore'
import { describe, expect, it } from 'vitest'
import { buildInsights, completedSessions, median, oneIn, pickWeighted, preferenceScore, quantile, sample } from '../src/lib/insights'
import { SESSION_GAP_MS } from '../src/lib/sessionLog'
import { dayKey } from '../src/lib/time'

const MIN = 60_000
const DAY = 86_400_000
/** A Wednesday, mid-afternoon local time. */
const NOW = new Date(2026, 10, 11, 15, 0, 0).getTime()

function video(name: string, over: Partial<VideoStat> = {}): VideoStat {
  return { videoName: name, totalPlays: 0, totalWatchedMs: 0, finishEvents: [], edgeEvents: [], lastPlayedAt: 0, ...over }
}

function session(start: number, lengthMin: number, over: Partial<SessionLog> = {}): SessionLog {
  return { start, end: start + lengthMin * MIN, plays: [], edges: [], finishes: [], ...over }
}

function input(over: Partial<InsightInput> = {}): InsightInput {
  return {
    now: NOW,
    videos: [],
    daily: {},
    history: { since: NOW - 30 * DAY, sessions: [] },
    ...over,
  }
}

const ids = (r: ReturnType<typeof buildInsights>) => r.insights.map(i => i.id)
const find = (r: ReturnType<typeof buildInsights>, id: string) => r.insights.find(i => i.id === id)
const pendingIds = (r: ReturnType<typeof buildInsights>) => r.pending.map(p => p.id)

describe('helpers', () => {
  it('median and quantiles', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBeNaN()
    expect(quantile([0, 10, 20, 30, 40], 0.25)).toBe(10)
  })

  it('says small samples out loud', () => {
    expect(sample(3, 'session')).toBe('only 3 sessions so far')
    expect(sample(1, 'finish', 'finishes')).toBe('only 1 finish so far')
    expect(sample(12, 'session')).toBe('12 sessions')
  })

  it('turns rates into words', () => {
    expect(oneIn(0.25)).toBe('1 in 4')
    expect(oneIn(0.6)).toBe('6 in 10')
    expect(oneIn(0)).toBe('never')
    expect(oneIn(1)).toBe('nearly every time')
  })

  it('counts a session as over after the gap, or once a newer one began', () => {
    const h: SessionHistory = { since: 0, sessions: [session(NOW - 3 * 3600_000, 20), session(NOW - 10 * MIN, 5)] }
    expect(completedSessions(h, NOW, false)).toHaveLength(1)
    expect(completedSessions(h, NOW + SESSION_GAP_MS, false)).toHaveLength(2)
    expect(completedSessions(h, NOW + SESSION_GAP_MS, true)).toHaveLength(1)
  })
})

describe('with nothing logged', () => {
  it('finds nothing and lists what each finding still needs', () => {
    const r = buildInsights(input())
    expect(r.insights).toEqual([])
    expect(pendingIds(r)).toEqual(expect.arrayContaining(['time-to-finish', 'edging', 'finish-point', 'enders', 'time-of-day', 'weekday', 'heart', 'pace']))
    expect(r.pending.find(p => p.id === 'time-to-finish')?.need).toMatch(/0 so far/)
  })
})

describe('this week', () => {
  it('compares with the week before', () => {
    const daily: Record<string, DayStat> = {}
    daily[dayKey(NOW)] = { ms: 60 * MIN, plays: 2 }
    daily[dayKey(NOW - 2 * DAY)] = { ms: 60 * MIN, plays: 2 }
    daily[dayKey(NOW - 8 * DAY)] = { ms: 60 * MIN, plays: 1 }
    const v = video('a.mp4', { finishEvents: [{ at: 300, ts: NOW - DAY }], edgeEvents: [{ at: 100, ts: NOW - 9 * DAY }] })
    const w = find(buildInsights(input({ daily, videos: [v] })), 'week')!
    expect(w.text).toBe('2h 0m over 2 days, up 100% on the week before (1h 0m).')
    expect(w.more).toBe('1 finish and 0 edges this week; 0 and 1 the week before.')
  })

  it('has nothing to compare with in a first week', () => {
    const daily = { [dayKey(NOW)]: { ms: 30 * MIN, plays: 1 } }
    expect(find(buildInsights(input({ daily })), 'week')!.text).toMatch(/nothing the week before/)
  })

  it('counts the running video', () => {
    const w = find(buildInsights(input({ liveMs: 10 * MIN })), 'week')!
    expect(w.text).toMatch(/^10m over 1 day,/)
  })
})

describe('time to finish', () => {
  function sessionsWith(times: number[]): SessionLog[] {
    return times.map((t, i) => {
      const start = NOW - (times.length - i) * DAY
      return session(start, t + 5, { finishes: [{ ts: start + t * MIN, video: 'a.mp4', at: 100 }] })
    })
  }

  it('waits for three sessions with a finish', () => {
    const r = buildInsights(input({ history: { since: 0, sessions: sessionsWith([20, 30]) } }))
    expect(ids(r)).not.toContain('time-to-finish')
    expect(r.pending.find(p => p.id === 'time-to-finish')?.need).toMatch(/2 so far/)
  })

  it('gives the median, and says the sample is small', () => {
    const t = find(buildInsights(input({ history: { since: 0, sessions: sessionsWith([20, 30, 40]) } })), 'time-to-finish')!
    expect(t.text).toMatch(/about 30 min/)
    expect(t.note).toBe('From only 3 sessions with a finish so far.')
    expect(t.more).toBeUndefined()
    expect(t.newOnly).toBe(true)
  })

  it('spots a trend once there are enough', () => {
    const t = find(buildInsights(input({ history: { since: 0, sessions: sessionsWith([40, 42, 38, 20, 18, 22]) } })), 'time-to-finish')!
    expect(t.more).toBe('Getting quicker: 20 min in your last 3, against 40 min before.')
    const steady = find(buildInsights(input({ history: { since: 0, sessions: sessionsWith([30, 31, 29, 30, 31, 29]) } })), 'time-to-finish')!
    expect(steady.more).toMatch(/^Steady/)
  })

  it('a session without a finish does not count', () => {
    const s = [...sessionsWith([20, 30]), session(NOW - 10 * DAY, 60)]
    expect(ids(buildInsights(input({ history: { since: 0, sessions: s } })))).not.toContain('time-to-finish')
  })
})

describe('where in a video', () => {
  it('uses every finish ever logged', () => {
    const v = video('a.mp4', { finishEvents: [300, 420, 480, 500, 600].map((at, i) => ({ at, ts: NOW - (10 - i) * DAY })) })
    const f = find(buildInsights(input({ videos: [v] })), 'finish-point')!
    expect(f.text).toBe('Usually about 8:00 in (median), half of them between 7:00 and 8:20.')
    expect(f.newOnly).toBeUndefined()
  })

  it('notices finishes moving later', () => {
    const at = [200, 210, 190, 205, 195, 600, 610, 590, 605, 620]
    const v = video('a.mp4', { finishEvents: at.map((a, i) => ({ at: a, ts: NOW - (20 - i) * DAY })) })
    expect(find(buildInsights(input({ videos: [v] })), 'finish-point')!.more).toMatch(/^Later than you used to/)
  })
})

describe('by intensity band and tag', () => {
  const info = (map: Record<string, VideoInfo>) => (name: string) => map[name] ?? null

  it('needs enough plays in two bands', () => {
    const videos = [video('g.mp4', { totalPlays: 20, finishEvents: [{ at: 1, ts: 1 }, { at: 1, ts: 2 }] })]
    const r = buildInsights(input({ videos, info: info({ 'g.mp4': { tags: [], band: 'gentle' } }) }))
    expect(ids(r)).not.toContain('band')
    expect(pendingIds(r)).toContain('band')
  })

  it('names the band that ends in a finish most often', () => {
    const fin = (n: number) => Array.from({ length: n }, (_, i) => ({ at: 100, ts: i }))
    const videos = [
      video('g.mp4', { totalPlays: 20, finishEvents: fin(2) }),
      video('i.mp4', { totalPlays: 8, finishEvents: fin(4) }),
      video('m.mp4', { totalPlays: 2, finishEvents: fin(1) }),
    ]
    const b = find(buildInsights(input({ videos, info: info({
      'g.mp4': { tags: [], band: 'gentle' },
      'i.mp4': { tags: [], band: 'intense' },
      'm.mp4': { tags: [], band: 'medium' },
    }) })), 'band')!
    expect(b.text).toBe('Intense scripts end in a finish most often: 1 in 2 plays, against 1 in 10 for gentle ones.')
    expect(b.bars!.find(x => x.label === 'Medium')!.display).toBe('too few')
    expect(b.bars!.find(x => x.label === 'Intense')!.highlight).toBe(true)
  })

  it('finds a tag well above the usual rate, and skips band tags', () => {
    const fin = (n: number) => Array.from({ length: n }, (_, i) => ({ at: 100, ts: i }))
    const videos = [
      video('a.mp4', { totalPlays: 4, finishEvents: fin(2) }),
      video('b.mp4', { totalPlays: 4, finishEvents: fin(2) }),
      video('c.mp4', { totalPlays: 20, finishEvents: fin(1) }),
      video('d.mp4', { totalPlays: 20, finishEvents: fin(0) }),
    ]
    const t = find(buildInsights(input({ videos, info: info({
      'a.mp4': { tags: ['pov', 'intense'], band: 'intense' },
      'b.mp4': { tags: ['pov', 'intense'], band: 'intense' },
      'c.mp4': { tags: ['solo'], band: 'gentle' },
      'd.mp4': { tags: ['solo'], band: 'gentle' },
    }) })), 'tags')!
    expect(t.text).toBe('Videos tagged "pov" end in a finish 1 in 2 plays, about 5 times your usual 1 in 10.')
    expect(t.bars!.map(b => b.label)).toEqual(['pov', 'solo', 'All videos'])
  })

  it('a tag on one video only is not a pattern', () => {
    const videos = [video('a.mp4', { totalPlays: 10, finishEvents: [{ at: 1, ts: 1 }, { at: 1, ts: 2 }, { at: 1, ts: 3 }] })]
    const r = buildInsights(input({ videos, info: info({ 'a.mp4': { tags: ['pov'], band: null } }) }))
    expect(ids(r)).not.toContain('tags')
  })
})

describe('edging and session length', () => {
  function sessions(withEdges: number[], without: number[]): SessionLog[] {
    const out: SessionLog[] = []
    let t = NOW - 60 * DAY
    for (const m of withEdges) {
      out.push(session(t, m, { edges: [{ ts: t + MIN, video: null, at: null }], finishes: [{ ts: t + m * MIN, video: 'a.mp4', at: 1 }] }))
      t += DAY
    }
    for (const m of without) {
      out.push(session(t, m))
      t += DAY
    }
    return out
  }

  it('compares sessions with and without edges', () => {
    const e = find(buildInsights(input({ history: { since: 0, sessions: sessions([40, 45, 50], [20, 25, 15]) } })), 'edging')!
    expect(e.text).toBe('Yes: sessions with edges run 45 min (median), about 2.3× the 20 min of those without.')
    expect(e.more).toBe('3 of 3 sessions with edges ended in a finish; 0 of 3 without.')
    expect(e.note).toMatch(/^Early days/)
  })

  it('says so when it makes no difference', () => {
    const e = find(buildInsights(input({ history: { since: 0, sessions: sessions([30, 31, 29], [30, 29, 31]) } })), 'edging')!
    expect(e.text).toMatch(/^Not by much/)
  })

  it('leaves out the running session and anything under a minute', () => {
    const list = sessions([40, 45], [20, 25, 15])
    list.push(session(NOW - 5 * MIN, 0.5, { edges: [{ ts: NOW, video: null, at: null }] }))
    list.push(session(NOW - 10 * MIN, 10, { edges: [{ ts: NOW, video: null, at: null }] }))
    expect(ids(buildInsights(input({ history: { since: 0, sessions: list } })))).not.toContain('edging')
  })
})

describe('what ends a session', () => {
  it('names the video that most often ends one', () => {
    const list: SessionLog[] = []
    const last = ['x.mp4', 'x.mp4', 'x.mp4', 'y.mp4', 'z.mp4']
    last.forEach((name, i) => {
      const t = NOW - (10 - i) * DAY
      list.push(session(t, 30, {
        plays: [{ video: 'warmup.mp4', from: t, ms: 10 * MIN }, { video: name, from: t + 10 * MIN, ms: 20 * MIN }],
        finishes: name === 'x.mp4' ? [{ ts: t + 29 * MIN, video: name, at: 600 }] : [],
      }))
    })
    const e = find(buildInsights(input({ history: { since: 0, sessions: list } })), 'enders')!
    expect(e.text).toBe('"x" ended 3 of your 5 sessions, each time with a finish.')
    expect(e.bars!.map(b => b.label)).toEqual(['x'])
  })
})

describe('time of day and weekday', () => {
  it('finds a three-hour window that wraps past midnight', () => {
    const at = (h: number, d: number) => new Date(2026, 9, d, h, 30).getTime()
    const v = video('a.mp4', { finishEvents: [at(23, 1), at(23, 2), at(0, 3), at(1, 4), at(14, 5)].map(ts => ({ at: 100, ts })) })
    expect(find(buildInsights(input({ videos: [v] })), 'time-of-day')!.text).toBe('Most finishes come between 23:00 and 02:00: 4 of 5.')
  })

  it('weekday needs three weeks of history', () => {
    const daily: Record<string, DayStat> = {}
    for (let i = 0; i < 10; i++)
      daily[dayKey(NOW - i * DAY)] = { ms: 20 * MIN, plays: 1 }
    const r = buildInsights(input({ daily }))
    expect(ids(r)).not.toContain('weekday')
    expect(r.pending.find(p => p.id === 'weekday')!.need).toMatch(/10 watched over 10 days/)
  })

  it('picks out the long weekday', () => {
    const daily: Record<string, DayStat> = {}
    for (let i = 0; i < 28; i++) {
      const ts = NOW - i * DAY
      const sat = new Date(ts).getDay() === 6
      daily[dayKey(ts)] = { ms: (sat ? 120 : 10) * MIN, plays: 1 }
    }
    const w = find(buildInsights(input({ daily })), 'weekday')!
    expect(w.text).toMatch(/^Saturdays are your longest days: 2h 0m on average/)
    expect(w.bars!.find(b => b.highlight)!.label).toBe('Sat')
  })
})

describe('heart rate and pace', () => {
  it('reports heart rate at edges and finishes, with a rule suggestion', () => {
    const s = session(NOW - DAY, 40, {
      edges: [120, 124, 126, 130, 132].map((bpm, i) => ({ ts: NOW - DAY + i * MIN, video: null, at: null, bpm })),
      finishes: [{ ts: NOW - DAY + 30 * MIN, video: 'a.mp4', at: 1, bpm: 140 }, { ts: NOW - DAY + 31 * MIN, video: 'a.mp4', at: 1, bpm: 136 }],
    })
    const h = find(buildInsights(input({ history: { since: 0, sessions: [s] } })), 'heart')!
    expect(h.text).toBe('Edges come at about 126 bpm and finishes at about 138 bpm.')
    expect(h.more).toBe('A rule at 120 bpm (Rules panel) would step in before about three quarters of your edges.')
    expect(h.note).toMatch(/only a few so far/)
  })

  it('stays quiet without a monitor', () => {
    const s = session(NOW - DAY, 40, { edges: [{ ts: NOW, video: null, at: null }] })
    const r = buildInsights(input({ history: { since: 0, sessions: [s] } }))
    expect(ids(r)).not.toContain('heart')
    expect(r.pending.find(p => p.id === 'heart')!.newOnly).toBe(true)
  })

  it('reports the pace at a finish', () => {
    const s = session(NOW - DAY, 40, {
      finishes: [140, 150, 160, 170].map((spm, i) => ({ ts: NOW - DAY + i, video: 'a.mp4', at: 1, spm, moment: 0.8 })),
    })
    const p = find(buildInsights(input({ history: { since: 0, sessions: [s] } })), 'pace')!
    expect(p.text).toBe('You finish with the script at about 155 strokes a minute (half of them between 148 and 163).')
    expect(p.more).toBe('Mostly in the busiest stretch of the script.')
  })
})

describe('weighted pick', () => {
  it('follows the weights and never rules anything out', () => {
    const w = (x: string) => (x === 'a' ? 1 : 0)
    // a: 1.25, b: 0.25 of 1.5 total
    expect(pickWeighted(['a', 'b'], w, 0)).toBe('a')
    expect(pickWeighted(['a', 'b'], w, 0.8)).toBe('a')
    expect(pickWeighted(['a', 'b'], w, 0.9)).toBe('b')
    expect(pickWeighted(['a', 'b'], w, 1)).toBe('b')
    expect(pickWeighted([], w, 0.5)).toBeNull()
  })
})

describe('preference score', () => {
  it('is neutral with no history', () => {
    expect(preferenceScore(null)).toBe(0.5)
    expect(preferenceScore(video('a', { totalPlays: 0 }))).toBe(0.5)
  })

  it('rises with finishes per play, and one lucky play does not max it out', () => {
    const fin = (n: number) => Array.from({ length: n }, (_, i) => ({ at: 1, ts: i }))
    const often = preferenceScore(video('a', { totalPlays: 10, finishEvents: fin(5) }))
    const rarely = preferenceScore(video('b', { totalPlays: 10, finishEvents: fin(0) }))
    const once = preferenceScore(video('c', { totalPlays: 1, finishEvents: fin(1) }))
    expect(often).toBeGreaterThan(rarely)
    expect(often).toBeGreaterThan(once)
    for (const s of [often, rarely, once]) {
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })
})
