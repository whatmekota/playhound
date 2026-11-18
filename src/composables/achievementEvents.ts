import { reactive, watch } from 'vue'
import { KEYS } from '~/lib/persist'

/**
 * Moments the achievements count that nothing else keeps: an edit saved, a
 * share card made, panic pressed, a device connected. A plain module with no
 * store behind it, so anything can count one without importing half the app.
 * Read by useAchievements.
 */

function load(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEYS.achievementCounts.key) ?? '{}')
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v))
        out[k] = v
    }
    return out
  }
  catch {
    return {}
  }
}

export const achievementCounts = reactive<Record<string, number>>(load())

let saveTimer: ReturnType<typeof setTimeout> | undefined
watch(achievementCounts, () => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEYS.achievementCounts.key, JSON.stringify(achievementCounts))
    }
    catch {}
  }, 500)
}, { deep: true })

/** It happened (again): `n` more. */
export function countMoment(event: string, n = 1) {
  achievementCounts[event] = (achievementCounts[event] ?? 0) + n
}

/** It has happened at least once: a yes-or-no one, counted once a session at most. */
const markedThisRun = new Set<string>()
export function markMoment(event: string) {
  if (markedThisRun.has(event))
    return
  markedThisRun.add(event)
  countMoment(event)
}

/** The most so far: devices at once, say. */
export function bestMoment(event: string, value: number) {
  if (value > (achievementCounts[event] ?? 0))
    achievementCounts[event] = value
}
