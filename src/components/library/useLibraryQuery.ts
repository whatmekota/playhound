import type { Reactive } from 'vue'
import type { MenuItem } from '~/components/ui/menu'
import type { FilterKey, SortKey, SortState } from '~/lib/libraryQuery'
import type { IntensityBand } from '~/lib/scriptIntensity'
import type { VideoEntry } from '~/stores/libraryStore'
import { refDebounced, useLocalStorage } from '@vueuse/core'
import { computed, reactive, ref, shallowRef } from 'vue'
import { bandCounts, filterCounts, nextSort, queryLibrary, SCRIPT_SORTS, SORT_LABELS, toggleBand as toggleBandIn, toggleFilter as toggleFilterIn, usesSummaries } from '~/lib/libraryQuery'
import { KEYS } from '~/lib/persist'
import { usePlaybackStore } from '~/stores/playbackStore'
import { useQueueStore } from '~/stores/queueStore'
import { useScriptSummaries } from './useScriptSummaries'

export const FILTER_CHIPS: { key: FilterKey, label: string, icon: string }[] = [
  { key: 'scripted', label: 'Scripted', icon: 'i-carbon-chart-line-smooth' },
  { key: 'multi', label: 'Multi-axis', icon: 'i-carbon-chart-multi-line' },
  { key: 'starred', label: 'Starred', icon: 'i-carbon-star' },
  { key: 'unscripted', label: 'No script', icon: 'i-carbon-subtract-alt' },
]

/**
 * Search, chips and sort over the library, plus playing the result.
 *
 * Each caller gets its own search text and chips (the drawer panel is a
 * different place to look than the full view), but the sort is one saved
 * preference shared by both.
 */
export function useLibraryQuery(videos: () => VideoEntry[], label = 'Library') {
  const playback = usePlaybackStore()
  const queue = useQueueStore()
  const scripts = useScriptSummaries()

  const sort = useLocalStorage<SortState>(KEYS.librarySort.key, { key: 'name', asc: true }, { mergeDefaults: true })
  const search = ref('')
  const query = refDebounced(search, 120)
  const filters = shallowRef(new Set<FilterKey>())
  const bands = shallowRef(new Set<IntensityBand>())

  function setSort(key: SortKey, asc?: boolean) {
    sort.value = nextSort(sort.value, key, asc)
  }
  function toggleFilter(f: FilterKey) {
    filters.value = toggleFilterIn(filters.value, f)
  }
  function toggleBand(b: IntensityBand) {
    bands.value = toggleBandIn(bands.value, b)
  }
  function clearFilters() {
    filters.value = new Set()
    bands.value = new Set()
    search.value = ''
  }

  const filtering = computed(() => !!query.value.trim() || filters.value.size > 0 || bands.value.size > 0)
  /** Sorting or filtering on script shape, where lazy analysis would shuffle rows under the pointer. */
  const scriptAware = computed(() => usesSummaries({ bands: bands.value, sort: sort.value }))

  const results = computed(() => {
    const q = { query: query.value, filters: filters.value, bands: bands.value, sort: sort.value }
    // Only a script-aware query re-runs as analyses land, and then calmly.
    if (usesSummaries(q))
      void scripts.settledCount.value
    return queryLibrary(videos(), q, scripts.peek)
  })

  const counts = computed(() => filterCounts(videos()))
  const bandTally = computed(() => {
    void scripts.settledCount.value
    return bandCounts(videos(), scripts.peek)
  })

  // ─── Playing ──────────────────────────────────────────────────────────────
  function playEntry(entry: VideoEntry) {
    void playback.play(entry, results.value, label)
  }

  function playAll() {
    const list = results.value
    if (!list.length)
      return
    // "Play" means in order, the way every music player treats it.
    if (queue.shuffle)
      queue.setShuffle(false)
    void playback.play(list[0], list, label)
  }

  function shuffleAll() {
    const list = results.value
    if (!list.length)
      return
    if (!queue.shuffle)
      queue.setShuffle(true)
    void playback.play(list[Math.floor(Math.random() * list.length)], list, label)
  }

  // ─── Menus ────────────────────────────────────────────────────────────────
  const sortMenu = computed<MenuItem[]>(() => {
    const plain = (Object.keys(SORT_LABELS) as SortKey[]).filter(k => !SCRIPT_SORTS.includes(k))
    const item = (k: SortKey): MenuItem => ({ label: SORT_LABELS[k], checked: sort.value.key === k, run: () => setSort(k, k === sort.value.key ? sort.value.asc : nextSort(sort.value, k).asc) })
    return [
      { heading: true, label: 'Sort by' },
      ...plain.map(item),
      { heading: true, label: 'Script' },
      ...SCRIPT_SORTS.map(item),
      { separator: true },
      { label: 'Ascending', icon: 'i-carbon-sort-ascending', checked: sort.value.asc, run: () => setSort(sort.value.key, true) },
      { label: 'Descending', icon: 'i-carbon-sort-descending', checked: !sort.value.asc, run: () => setSort(sort.value.key, false) },
    ]
  })

  const sortLabel = computed(() => SORT_LABELS[sort.value.key].replace(' modified', ''))

  return {
    search,
    query,
    filters,
    bands,
    sort,
    setSort,
    toggleFilter,
    toggleBand,
    clearFilters,
    filtering,
    scriptAware,
    results,
    counts,
    bandTally,
    playEntry,
    playAll,
    shuffleAll,
    sortMenu,
    sortLabel,
    scripts,
  }
}

export type LibraryQueryState = Reactive<ReturnType<typeof useLibraryQuery>>

/** The same, unwrapped, so templates and child components can read it plainly. */
export function useLibraryQueryState(videos: () => VideoEntry[], label?: string): LibraryQueryState {
  return reactive(useLibraryQuery(videos, label))
}
