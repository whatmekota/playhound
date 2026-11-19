import type { Reactive } from 'vue'
import type { MenuItem } from '~/components/ui/menu'
import type { FilterKey, SortKey, SortState } from '~/lib/libraryQuery'
import type { IntensityBand } from '~/lib/scriptIntensity'
import type { VideoEntry } from '~/stores/libraryStore'
import { refDebounced, useLocalStorage } from '@vueuse/core'
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { bandCounts, filterCounts, nextSort, queryLibrary, SCRIPT_SORTS, SORT_LABELS, TASTE_SORTS, toggleBand as toggleBandIn, toggleFilter as toggleFilterIn, toggleTag as toggleTagIn, usesSummaries } from '~/lib/libraryQuery'
import { KEYS } from '~/lib/persist'
import { summaryFor } from '~/lib/tags'
import { TASTE_MIN, tasteFeatures, tasteProfile, tasteScore } from '~/lib/yourType'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { useQueueStore } from '~/stores/queueStore'
import { useStatsStore } from '~/stores/statsStore'
import { useScriptSummaries } from './useScriptSummaries'

/**
 * What a video played from the library does to the queue: line up the rest
 * of the list after it ('rest'), or play on its own ('one'), slotted in after
 * the current video with whatever was queued by hand kept. Play all, Shuffle
 * and a selection always line up their list.
 */
export type LibraryPlay = 'rest' | 'one'

export function useLibraryPlay() {
  return useLocalStorage<LibraryPlay>(KEYS.libraryPlay.key, 'rest')
}

export const FILTER_CHIPS: { key: FilterKey, label: string, icon: string }[] = [
  { key: 'scripted', label: 'Scripted', icon: 'i-carbon-chart-line-smooth' },
  { key: 'multi', label: 'Multi-axis', icon: 'i-carbon-chart-multi-line' },
  { key: 'starred', label: 'Starred', icon: 'i-carbon-star' },
  { key: 'unscripted', label: 'No script', icon: 'i-carbon-subtract-alt' },
  // Shown only once the library has an audio file (FilterChips).
  { key: 'audio', label: 'Audio', icon: 'i-carbon-music' },
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
  const library = useLibraryStore()
  const queue = useQueueStore()
  const scripts = useScriptSummaries()
  const stats = useStatsStore()

  const sort = useLocalStorage<SortState>(KEYS.librarySort.key, { key: 'name', asc: true }, { mergeDefaults: true })
  const search = ref('')
  const query = refDebounced(search, 120)
  const filters = shallowRef(new Set<FilterKey>())
  /**
   * One library folder (or one app plugins add videos from, by its name), or
   * null for all; one that leaves the library drops back to all.
   */
  const folder = ref<string | null>(null)
  watch(() => [...library.folders, ...library.sources], (list) => {
    if (folder.value && !list.includes(folder.value))
      folder.value = null
  })
  const bands = shallowRef(new Set<IntensityBand>())
  /** Tag chips; a video needs all of them. */
  const tags = shallowRef(new Set<string>())

  function setSort(key: SortKey, asc?: boolean) {
    sort.value = nextSort(sort.value, key, asc)
  }
  function toggleFilter(f: FilterKey) {
    filters.value = toggleFilterIn(filters.value, f)
  }
  function toggleBand(b: IntensityBand) {
    bands.value = toggleBandIn(bands.value, b)
  }
  function toggleTag(tag: string) {
    tags.value = toggleTagIn(tags.value, tag)
  }
  function clearFilters() {
    filters.value = new Set()
    bands.value = new Set()
    tags.value = new Set()
    search.value = ''
    folder.value = null
  }
  /** Just this tag: what "Filter library by tag" from elsewhere means. */
  function showTag(tag: string) {
    clearFilters()
    tags.value = new Set([tag])
  }

  const filtering = computed(() => !!query.value.trim() || filters.value.size > 0 || bands.value.size > 0 || tags.value.size > 0 || !!folder.value)
  /** Sorting or filtering on script shape, where lazy analysis would shuffle rows under the pointer. */
  const scriptAware = computed(() => usesSummaries({ bands: bands.value, sort: sort.value, tags: tags.value, query: query.value }))

  /**
   * "Your type" (lib/yourType): what your finishes, stars and replays have
   * in common, over the whole library, worked out only while sorted by it.
   */
  const taste = computed(() => {
    if (!TASTE_SORTS.includes(sort.value.key))
      return null
    void scripts.settledCount.value
    const rows = library.videos.map((v) => {
      const s = stats.stats[v.name]
      return {
        name: v.name,
        features: tasteFeatures(v, summaryFor(v, scripts.peek)),
        signal: { finishes: s?.finishEvents.length ?? 0, plays: s?.totalPlays ?? 0, starred: !!v.starred },
      }
    })
    const profile = tasteProfile(rows)
    return profile ? new Map(rows.map(r => [r.name, tasteScore(profile, r.features)])) : null
  })
  const tasteReady = computed(() => !!taste.value)

  const results = computed(() => {
    const q = { query: query.value, filters: filters.value, bands: bands.value, tags: tags.value, sort: sort.value, folder: folder.value }
    // Only a script-aware query re-runs as analyses land, and then calmly.
    if (usesSummaries(q))
      void scripts.settledCount.value
    const scores = taste.value
    return queryLibrary(videos(), q, scripts.peek, scores ? v => scores.get(v.name) : undefined)
  })

  const counts = computed(() => filterCounts(videos()))
  const bandTally = computed(() => {
    void scripts.settledCount.value
    return bandCounts(videos(), scripts.peek)
  })

  // ─── Playing ──────────────────────────────────────────────────────────────
  const libraryPlay = useLibraryPlay()
  function playEntry(entry: VideoEntry) {
    if (libraryPlay.value === 'one')
      void playback.play(entry)
    else
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
    const plain = (Object.keys(SORT_LABELS) as SortKey[]).filter(k => !SCRIPT_SORTS.includes(k) && !TASTE_SORTS.includes(k))
    const item = (k: SortKey): MenuItem => ({ label: SORT_LABELS[k], checked: sort.value.key === k, run: () => setSort(k, k === sort.value.key ? sort.value.asc : nextSort(sort.value, k).asc) })
    return [
      { heading: true, label: 'Sort by' },
      ...plain.map(item),
      { heading: true, label: 'Script' },
      ...SCRIPT_SORTS.map(item),
      { heading: true, label: 'For you' },
      ...TASTE_SORTS.map(k => ({
        ...item(k),
        hint: sort.value.key === k && !tasteReady.value ? `Finish to or star ${TASTE_MIN} videos first` : 'Most like what you finish to',
      })),
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
    tags,
    folder,
    sort,
    setSort,
    toggleFilter,
    toggleBand,
    toggleTag,
    showTag,
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
    tasteReady,
  }
}

export type LibraryQueryState = Reactive<ReturnType<typeof useLibraryQuery>>

/** The same, unwrapped, so templates and child components can read it plainly. */
export function useLibraryQueryState(videos: () => VideoEntry[], label?: string): LibraryQueryState {
  return reactive(useLibraryQuery(videos, label))
}
