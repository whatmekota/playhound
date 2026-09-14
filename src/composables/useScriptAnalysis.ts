import type { EnvelopeSample, Peak } from '~/lib/funscriptAnalysis'
import { computed, shallowRef, watch } from 'vue'
import { buildEnvelope, detectPeaks } from '~/lib/funscriptAnalysis'
import { useScriptStore } from '~/stores/scriptStore'

export interface ScriptAnalysis {
  peaks: Peak[]
  envelope: EnvelopeSample[]
  /** Highest speed seen, for normalising a heatmap or a curve. */
  peakSpeed: number
  /** Mean speed across the whole script. */
  meanSpeed: number
  /** Mean stroke rate across the whole script. */
  meanSpm: number
  durationMs: number
}

// Cached per script so the timeline, the pulse driver and the auto-director all
// share one analysis rather than each recomputing it.
const cache = new Map<string, ScriptAnalysis>()
const MAX_CACHED = 24

export function analysisKey(filename: string, channel: string, actionCount: number): string {
  return `${filename}:${channel}:${actionCount}`
}

export function analyseActions(
  actions: { at: number, pos: number }[],
  key?: string,
): ScriptAnalysis {
  if (key) {
    const hit = cache.get(key)
    if (hit)
      return hit
  }

  const peaks = detectPeaks(actions)
  const envelope = buildEnvelope(actions)

  let peakSpeed = 0
  let speedSum = 0
  let spmSum = 0
  for (const s of envelope) {
    if (s.speed > peakSpeed)
      peakSpeed = s.speed
    speedSum += s.speed
    spmSum += s.spm
  }

  const result: ScriptAnalysis = {
    peaks,
    envelope,
    peakSpeed,
    meanSpeed: envelope.length ? speedSum / envelope.length : 0,
    meanSpm: envelope.length ? spmSum / envelope.length : 0,
    durationMs: actions.length ? actions[actions.length - 1].at : 0,
  }

  if (key) {
    if (cache.size >= MAX_CACHED)
      cache.delete(cache.keys().next().value!)
    cache.set(key, result)
  }
  return result
}

/** Analysis of the script currently loaded on the primary stroke axis. */
export function useScriptAnalysis() {
  const script = useScriptStore()
  const analysis = shallowRef<ScriptAnalysis | null>(null)

  const source = computed(() => script.primaryScript ?? script.activeScripts[0] ?? null)

  watch(source, (s) => {
    if (!s) {
      analysis.value = null
      return
    }
    analysis.value = analyseActions(
      s.parsed.actions,
      analysisKey(s.filename, s.channel, s.parsed.actions.length),
    )
  }, { immediate: true })

  return { analysis, source }
}
