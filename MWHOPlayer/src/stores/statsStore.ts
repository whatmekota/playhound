import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export interface FinishEvent {
  at: number      // seconds into video
  ts: number      // unix timestamp
}

export interface VideoStat {
  videoName: string
  totalPlays: number
  totalWatchedMs: number
  finishEvents: FinishEvent[]
  lastPlayedAt: number
}

const STORAGE_KEY = 'mwhoplayer:stats'

function load(): Record<string, VideoStat> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') } catch { return {} }
}

export const useStatsStore = defineStore('stats', () => {
  const stats = ref<Record<string, VideoStat>>(load())
  let sessionStart: number | null = null
  let sessionKey: string | null = null

  watch(stats, v => localStorage.setItem(STORAGE_KEY, JSON.stringify(v)), { deep: true })

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
  }

  function endSession() {
    if (sessionKey && sessionStart) {
      const entry = ensureEntry(sessionKey)
      entry.totalWatchedMs += Date.now() - sessionStart
    }
    sessionKey = null
    sessionStart = null
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
  }

  return { stats, startSession, endSession, recordFinish, allStats, clearAll }
})
