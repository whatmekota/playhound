import type { ScriptSummary } from '~/lib/idb'
import type { VideoEntry } from '~/stores/libraryStore'
import { refThrottled } from '@vueuse/core'
import { computed, ref, toRaw } from 'vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { toast } from '~/composables/useToast'
import { plural } from '~/lib/entryInfo'
import { summaryDb } from '~/lib/idb'
import { whenIdle } from '~/lib/thumbs'
import { useLibraryStore } from '~/stores/libraryStore'

/**
 * Script intensity for the library, on top of the director's summaries.
 *
 * Lists say which entries are on screen (`want`) and those get analysed in
 * the background, one per idle slice, newest list first. Nothing is queued
 * for what has scrolled away, so a fling through thousands of videos leaves
 * no backlog behind it, and scrolling is never waiting on a parse.
 */

/** Entries on screen per list (the view and the drawer panel ask separately). */
const wanted = new Map<string, VideoEntry[]>()
/** Scripts that would not analyse (too short, unreadable): not retried this session. */
const failed = new Set<string>()
/** Bumped when `failed` grows, so coverage notices. */
const failedTick = ref(0)
let pumping = false

export function useScriptSummaries() {
  const director = useAutoDirector()
  const library = useLibraryStore()
  const { summaries } = director

  /** Reactive per key, for cards and rows. */
  function summaryOf(entry: VideoEntry): ScriptSummary | null {
    return entry.hasScript ? summaries.value[entry.name] ?? null : null
  }

  /**
   * A stand-in for "a summary arrived" that changes at most once a second,
   * so a sorted list re-sorts calmly while a sweep runs instead of on every
   * single result. Read the record with `peek` after depending on this.
   */
  const analysedCount = computed(() => Object.keys(summaries.value).length)
  const settledCount = refThrottled(analysedCount, 1000)
  const peek = (name: string): ScriptSummary | undefined => toRaw(summaries.value)[name]

  /** Scripted videos analysed so far, out of those that can be (a script too short to read is left out). */
  function count() {
    let done = 0
    let total = 0
    for (const v of library.videos) {
      if (!v.hasScript)
        continue
      if (peek(v.name))
        done++
      else if (failed.has(v.name))
        continue
      total++
    }
    return { done, total }
  }
  const coverage = computed(() => {
    void settledCount.value
    void failedTick.value
    return count()
  })

  function next(): VideoEntry | null {
    // Latest list first: Map keeps insertion order and `want` re-inserts.
    const lists = [...wanted.values()].reverse()
    for (const list of lists) {
      for (const e of list) {
        if (e.hasScript && !failed.has(e.name) && !peek(e.name))
          return e
      }
    }
    return null
  }

  async function pump() {
    if (pumping)
      return
    pumping = true
    try {
      while (true) {
        await whenIdle(600)
        // The sweep does the same work faster; stand aside while it runs.
        if (director.sweeping.value)
          break
        const entry = next()
        if (!entry)
          break
        // Already worked out in an earlier session: the director may still be
        // loading its cache, and parsing again would be a waste.
        let s: ScriptSummary | null | undefined
        try {
          s = await summaryDb.get(entry.name)
        }
        catch {}
        if (s)
          summaries.value[entry.name] = s
        else
          s = await director.summarise(entry)
        if (!s) {
          failed.add(entry.name)
          failedTick.value++
        }
        // Breathe between parses so a run of long scripts never adds up to jank.
        await new Promise(r => setTimeout(r, 40))
      }
    }
    finally {
      pumping = false
    }
  }

  /** "These are on screen in list `source`." An empty list withdraws the request. */
  function want(source: string, entries: VideoEntry[]) {
    wanted.delete(source)
    if (entries.length)
      wanted.set(source, entries)
    void pump()
  }

  /** Store a summary worked out elsewhere (the info dialog's profile). */
  function remember(entry: VideoEntry, s: ScriptSummary) {
    summaries.value[entry.name] = s
    void summaryDb.set(entry.name, s).catch(() => {})
  }

  let sweepToastShown = false
  async function analyseAll() {
    if (director.sweeping.value)
      return
    const before = count().done
    toast('Analysing scripts', { detail: 'Runs in the background; lists update as it goes', icon: 'i-carbon-chart-average', key: 'analyse' })
    sweepToastShown = true
    await director.sweep()
    if (sweepToastShown) {
      // Whatever the sweep went through and could not read is not worth offering again.
      for (const v of library.videos) {
        if (v.hasScript && !peek(v.name))
          failed.add(v.name)
      }
      failedTick.value++
      const n = count().done - before
      toast.success('Scripts analysed', { detail: n > 0 ? `${plural(n, 'new script')} profiled` : 'Everything was already analysed', key: 'analyse' })
    }
  }

  function cancelAnalyse() {
    sweepToastShown = false
    director.cancelSweep()
    toast('Analysis stopped', { icon: 'i-carbon-stop', key: 'analyse' })
  }

  return {
    summaries,
    summaryOf,
    peek,
    settledCount,
    coverage,
    want,
    remember,
    analyseAll,
    cancelAnalyse,
    sweeping: director.sweeping,
    sweepDone: director.sweepDone,
    sweepTotal: director.sweepTotal,
  }
}
