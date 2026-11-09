import type { SessionFinish, SessionHistory, SessionLog } from '~/lib/sessionLog'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { heartRate, heartSparkline } from '~/composables/useHeartRate'
import { KEYS } from '~/lib/persist'
import {
  addHeart,
  currentSessionStart,
  emptyHeartAcc,
  emptyHistory,
  foldHeart,
  normaliseHistory,
  pushCapped,
  sessionAt,
} from '~/lib/sessionLog'
import { dayKey } from '~/lib/time'
import { useSessionControlStore } from './sessionControlStore'

export { dayKey }

export interface FinishEvent {
  at: number // seconds into video
  ts: number // unix timestamp
}

export interface VideoStat {
  videoName: string
  totalPlays: number
  totalWatchedMs: number
  finishEvents: FinishEvent[]
  /** Edges called while this video played; absent in older data. */
  edgeEvents?: FinishEvent[]
  lastPlayedAt: number
}

const STORAGE_KEY = KEYS.stats.key
const DAILY_KEY = KEYS.statsDaily.key
const SESSIONS_KEY = KEYS.statsSessions.key

/** Watch time and plays for one local calendar day, keyed `YYYY-MM-DD`. */
export interface DayStat {
  ms: number
  plays: number
}

/** What else is known about a finish at the moment it is marked. */
export interface FinishContext {
  spm?: number
  moment?: number
}

function load<T>(key: string): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') }
  catch { return {} as T }
}

export const useStatsStore = defineStore('stats', () => {
  const stats = ref<Record<string, VideoStat>>(load(STORAGE_KEY))
  // Per-video totals cannot say *when* anything was watched, so the dashboard's
  // per-day chart needs its own log. It starts empty for existing data.
  const daily = ref<Record<string, DayStat>>(load(DAILY_KEY))
  let sessionStart: number | null = null
  let sessionKey: string | null = null
  /** The running session, which is only written to the totals when it ends. */
  const live = ref<{ videoName: string, since: number } | null>(null)

  watch(stats, v => localStorage.setItem(STORAGE_KEY, JSON.stringify(v)), { deep: true })
  watch(daily, v => localStorage.setItem(DAILY_KEY, JSON.stringify(v)), { deep: true })

  // ─── Sessions ──────────────────────────────────────────────────────────────
  // One record per session (see lib/sessionLog). Written when something
  // happens in it, never per frame: heart readings gather in `heartAcc` and
  // are folded in with the next write.
  const storedHistory = localStorage.getItem(SESSIONS_KEY)
  const history = ref<SessionHistory>(normaliseHistory(storedHistory ? load(SESSIONS_KEY) : null))
  if (storedHistory === null)
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(history.value))
  watch(history, v => localStorage.setItem(SESSIONS_KEY, JSON.stringify(v)), { deep: true })
  const heartAcc = emptyHeartAcc()
  /** Bumped on every finish marked, for whoever wants to react (rules). */
  const finishSeq = ref(0)

  /** The session something happening now belongs to, with heart readings folded in. */
  function sessionNow(now = Date.now()): SessionLog {
    const s = sessionAt(history.value, now, sessionKey !== null)
    foldHeart(s, heartAcc)
    return s
  }

  /** When the running session started, ms; null when there is none. */
  function sessionStartedAt(now = Date.now()): number | null {
    return currentSessionStart(history.value, now, sessionKey !== null)
  }

  watch(() => heartRate.bpm, (bpm) => {
    if (bpm && sessionStartedAt() !== null)
      addHeart(heartAcc, bpm)
  })

  function ensureDay(key: string): DayStat {
    return (daily.value[key] ??= { ms: 0, plays: 0 })
  }

  /** Split a session across the days it spans, so one late night is not all "today". */
  function logWatched(from: number, to: number) {
    let t = from
    while (t < to) {
      const d = new Date(t)
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
      const end = Math.min(to, midnight)
      ensureDay(dayKey(t)).ms += end - t
      t = end
    }
  }

  function ensureEntry(videoName: string): VideoStat {
    if (!stats.value[videoName]) {
      stats.value[videoName] = {
        videoName,
        totalPlays: 0,
        totalWatchedMs: 0,
        finishEvents: [],
        lastPlayedAt: 0,
      }
    }
    return stats.value[videoName]
  }

  function startSession(videoName: string) {
    endSession()
    // Before this video counts as open, or it would always join the last session.
    const session = sessionNow()
    sessionKey = videoName
    sessionStart = Date.now()
    const entry = ensureEntry(videoName)
    entry.totalPlays++
    entry.lastPlayedAt = Date.now()
    ensureDay(dayKey(Date.now())).plays++
    live.value = { videoName, since: sessionStart }
    pushCapped(session.plays, { video: videoName, from: sessionStart, ms: 0 })
  }

  function endSession() {
    if (sessionKey && sessionStart) {
      const entry = ensureEntry(sessionKey)
      entry.totalWatchedMs += Date.now() - sessionStart
      logWatched(sessionStart, Date.now())
      const s = sessionNow()
      const play = s.plays.findLast(p => p.video === sessionKey && p.from === sessionStart)
      if (play)
        play.ms = Date.now() - sessionStart
    }
    sessionKey = null
    sessionStart = null
    live.value = null
  }

  function recordFinish(videoName: string, atSeconds: number, ctx: FinishContext = {}): FinishEvent {
    const entry = ensureEntry(videoName)
    const event = { at: atSeconds, ts: Date.now() }
    entry.finishEvents.push(event)

    const f: SessionFinish = { ts: event.ts, video: videoName, at: atSeconds }
    if (ctx.spm !== undefined && Number.isFinite(ctx.spm))
      f.spm = Math.round(ctx.spm)
    if (ctx.moment !== undefined && Number.isFinite(ctx.moment))
      f.moment = Math.round(ctx.moment * 100) / 100
    if (heartRate.bpm) {
      f.bpm = heartRate.bpm
      const recent = heartSparkline.value
      if (recent.length)
        f.peakBpm = Math.round(Math.max(...recent))
    }
    pushCapped(sessionNow(event.ts).finishes, f)
    finishSeq.value++
    return event
  }

  /** Take back a finish marked by mistake. */
  function removeFinish(videoName: string, ts: number) {
    const entry = stats.value[videoName]
    if (entry)
      entry.finishEvents = entry.finishEvents.filter(f => f.ts !== ts)
    for (const s of history.value.sessions) {
      if (s.finishes.some(f => f.ts === ts && f.video === videoName))
        s.finishes = s.finishes.filter(f => !(f.ts === ts && f.video === videoName))
    }
  }

  // ─── Edges ─────────────────────────────────────────────────────────────────
  // Whoever calls an edge — a key, the phone, a heart-rate guard, a programme
  // — goes through the session control log, so follow that rather than ask
  // every caller to report here too.
  const control = useSessionControlStore()
  let edgesSeen = control.edges.length
  watch(() => control.edges.length, (n) => {
    if (n < edgesSeen)
      edgesSeen = 0 // the log was cleared
    for (const e of control.edges.slice(edgesSeen, n)) {
      if (e.videoName && e.videoTime !== null)
        (ensureEntry(e.videoName).edgeEvents ??= []).push({ at: e.videoTime, ts: e.at })
      pushCapped(sessionNow(e.at).edges, {
        ts: e.at,
        video: e.videoName,
        at: e.videoTime,
        source: e.source,
        ...(heartRate.bpm ? { bpm: heartRate.bpm } : {}),
      })
    }
    edgesSeen = n
  })

  /** Edges called since the app started (or the log was cleared). */
  const sessionEdges = computed(() => control.edges.length)

  /** Every edge ever logged on a video, for timeline markers and the stats view. */
  function edgesFor(videoName: string | null | undefined): FinishEvent[] {
    return videoName ? stats.value[videoName]?.edgeEvents ?? [] : []
  }

  function allStats(): VideoStat[] {
    return Object.values(stats.value).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
  }

  function clearAll() {
    stats.value = {}
    daily.value = {}
    history.value = emptyHistory()
  }

  // Closing the app with a video open would lose its watch time, and leave
  // its session looking as if it ended when the video began. Writes from
  // watchers would not get out in time, so write directly.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      const key = sessionKey
      if (key === null)
        return
      endSession()
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stats.value))
      localStorage.setItem(DAILY_KEY, JSON.stringify(daily.value))
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(history.value))
      // A page restored from the back-forward cache still has the video
      // open: carry on counting it, without calling it another play.
      sessionKey = key
      sessionStart = Date.now()
      live.value = { videoName: key, since: sessionStart }
    })
  }

  return {
    stats,
    daily,
    live,
    history,
    finishSeq,
    sessionEdges,
    startSession,
    endSession,
    recordFinish,
    removeFinish,
    edgesFor,
    allStats,
    sessionStartedAt,
    clearAll,
  }
})
