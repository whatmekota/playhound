import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useSessionControlStore } from './sessionControlStore'

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

const STORAGE_KEY = 'ph:stats'
const DAILY_KEY = 'ph:stats.daily'

/** Watch time and plays for one local calendar day, keyed `YYYY-MM-DD`. */
export interface DayStat {
  ms: number
  plays: number
}

export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
    sessionKey = videoName
    sessionStart = Date.now()
    const entry = ensureEntry(videoName)
    entry.totalPlays++
    entry.lastPlayedAt = Date.now()
    ensureDay(dayKey(Date.now())).plays++
    live.value = { videoName, since: sessionStart }
  }

  function endSession() {
    if (sessionKey && sessionStart) {
      const entry = ensureEntry(sessionKey)
      entry.totalWatchedMs += Date.now() - sessionStart
      logWatched(sessionStart, Date.now())
    }
    sessionKey = null
    sessionStart = null
    live.value = null
  }

  function recordFinish(videoName: string, atSeconds: number): FinishEvent {
    const entry = ensureEntry(videoName)
    const event = { at: atSeconds, ts: Date.now() }
    entry.finishEvents.push(event)
    return event
  }

  /** Take back a finish marked by mistake. */
  function removeFinish(videoName: string, ts: number) {
    const entry = stats.value[videoName]
    if (entry)
      entry.finishEvents = entry.finishEvents.filter(f => f.ts !== ts)
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
  }

  return { stats, daily, live, sessionEdges, startSession, endSession, recordFinish, removeFinish, edgesFor, allStats, clearAll }
})
