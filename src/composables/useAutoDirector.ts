import type { ScriptSummary } from '~/lib/idb'
import type { VideoEntry } from '~/stores/libraryStore'
import { useLocalStorage } from '@vueuse/core'
import { computed, ref } from 'vue'
import { parseFunscriptContent } from '~/lib/funscriptParser'
import { summaryDb } from '~/lib/idb'
import { meanSpeedToIntensity } from '~/lib/scriptIntensity'
import { useAudioStore } from '~/stores/audio'
import { useLibraryStore } from '~/stores/libraryStore'
import { useQueueStore } from '~/stores/queueStore'
import { analyseActions, analysisKey } from './useScriptAnalysis'

/** How many candidates to consider before picking, so it does not become a loop. */
const SHORTLIST = 5

/** How many of the last played videos the director avoids repeating. */
const RECENT_AVOID = 20

/** Analyse at most this many scripts at once during a library sweep. */
const SWEEP_CONCURRENCY = 3

// Shared so the toggle and the sweep progress read the same state everywhere.
const userEnabled = useLocalStorage('ph:director.enabled', false)
/**
 * Set while a programme runs: the intensity it wants right now. It turns the
 * director on for the duration without touching the user's own switch, so
 * nothing has to be put back afterwards, and it lets the pick follow the plan
 * even when the script (not the plan) is what is writing session intensity.
 */
const steer = ref<number | null>(null)
const enabled = computed({
  get: () => userEnabled.value || steer.value !== null,
  set: (v: boolean) => { userEnabled.value = v },
})
const sweeping = ref(false)
const sweepDone = ref(0)
const sweepTotal = ref(0)
const summaries = ref<Record<string, ScriptSummary>>({})
let loaded = false

/**
 * Picks what to play next by matching a script's shape to where the session
 * currently is — gentle scripts while it is building, busier ones at the peak —
 * instead of shuffling blindly.
 *
 * Summaries are cached in IndexedDB, so a library only has to be analysed once,
 * and anything not yet analysed simply does not compete rather than blocking.
 */
export function useAutoDirector() {
  const library = useLibraryStore()
  const audio = useAudioStore()
  const queue = useQueueStore()

  async function ensureLoaded() {
    if (loaded)
      return
    try {
      summaries.value = await summaryDb.all()
    }
    catch {
      summaries.value = {}
    }
    loaded = true
  }

  /** Analyse one entry's primary script and cache the result. */
  async function summarise(entry: VideoEntry): Promise<ScriptSummary | null> {
    const match = entry.scriptMatches.find(m => !m.isAlt) ?? entry.scriptMatches[0]
    if (!match)
      return null

    const cached = summaries.value[entry.name]
    if (cached)
      return cached

    try {
      const text = await match.file.text()
      const parsed = parseFunscriptContent(text, match.file.name, entry.name)
      const axis = parsed.axes.find(a => a.channel === 'L0') ?? parsed.axes[0]
      if (!axis || axis.actions.length < 4)
        return null

      const a = analyseActions(
        axis.actions,
        analysisKey(match.file.name, axis.channel, axis.actions.length),
      )
      const summary: ScriptSummary = {
        meanSpeed: a.meanSpeed,
        meanSpm: a.meanSpm,
        peakSpeed: a.peakSpeed,
        durationMs: a.durationMs,
        actionCount: axis.actions.length,
      }
      summaries.value[entry.name] = summary
      void summaryDb.set(entry.name, summary)
      return summary
    }
    catch {
      return null
    }
  }

  /** Analyse the whole library in the background, a few at a time. */
  async function sweep(onProgress?: (done: number, total: number) => void) {
    if (sweeping.value)
      return
    await ensureLoaded()

    const todo = library.videos.filter(v => v.hasScript && !summaries.value[v.name])
    sweeping.value = true
    sweepTotal.value = todo.length
    sweepDone.value = 0

    try {
      for (let i = 0; i < todo.length; i += SWEEP_CONCURRENCY) {
        if (!sweeping.value)
          break
        await Promise.all(todo.slice(i, i + SWEEP_CONCURRENCY).map(summarise))
        sweepDone.value = Math.min(todo.length, i + SWEEP_CONCURRENCY)
        onProgress?.(sweepDone.value, todo.length)
        // Yield so the sweep never blocks playback or the UI.
        await new Promise(r => setTimeout(r, 0))
      }
    }
    finally {
      sweeping.value = false
    }
  }

  function cancelSweep() {
    sweeping.value = false
  }

  /**
   * Choose the next video whose shape best fits the current session intensity.
   * Picks at random from a shortlist rather than always the single best match,
   * so a session does not become deterministic.
   */
  function pickNext(exclude?: string): VideoEntry | null {
    const target = steer.value ?? audio.intensity.value
    const analysed = library.videos.filter(v =>
      v.hasScript && v.name !== exclude && summaries.value[v.name],
    )
    // Matching on pace alone keeps landing on the same few videos over a long
    // session, so leave out what played recently while there is anything else.
    const recent = new Set(queue.history.slice(-RECENT_AVOID).map(q => q.entry.name))
    const fresh = analysed.filter(v => !recent.has(v.name))
    const pool = fresh.length ? fresh : analysed
    if (!pool.length)
      return null

    const scored = pool
      .map((v) => {
        const s = summaries.value[v.name]
        return { v, delta: Math.abs(meanSpeedToIntensity(s.meanSpeed) - target) }
      })
      .sort((a, b) => a.delta - b.delta)
      .slice(0, SHORTLIST)

    return scored[Math.floor(Math.random() * scored.length)]?.v ?? null
  }

  /** How many library videos the director can currently choose between. */
  function readyCount(): number {
    return library.videos.filter(v => v.hasScript && summaries.value[v.name]).length
  }

  void ensureLoaded()

  return {
    enabled,
    userEnabled,
    steer,
    sweeping,
    sweepDone,
    sweepTotal,
    summaries,
    summarise,
    sweep,
    cancelSweep,
    pickNext,
    readyCount,
  }
}
