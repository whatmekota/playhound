import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export interface FinishEvent {
  at: number // seconds into video
  ts: number // unix timestamp
}

export interface VideoStat {
  videoName: string
  totalPlays: number
  totalWatchedMs: number
  finishEvents: FinishEvent[]
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

  function recordFinish(videoName: string, atSeconds: number) {
    const entry = ensureEntry(videoName)
    entry.finishEvents.push({ at: atSeconds, ts: Date.now() })
  }

  function allStats(): VideoStat[] {
    return Object.values(stats.value).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
  }

  function clearAll() {
    stats.value = {}
    daily.value = {}
  }

  return { stats, daily, live, startSession, endSession, recordFinish, allStats, clearAll }
})
