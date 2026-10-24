/**
 * Searching, filtering and sorting the library.
 *
 * Shared by the full-stage Library view and the Library panel in the drawer,
 * so the same chips and the same sort mean the same thing in both. Pure, so
 * it is tested without a component around it.
 */
import type { IntensityBand } from './scriptIntensity'
import type { ScriptSummary } from '~/lib/idb'
import type { VideoEntry } from '~/stores/libraryStore'
import { effectiveMeta } from './entryInfo'
import { intensityBand } from './scriptIntensity'

export type SortKey = 'name' | 'size' | 'date' | 'duration' | 'intensity' | 'peak'
export interface SortState { key: SortKey, asc: boolean }

export type FilterKey = 'scripted' | 'multi' | 'starred' | 'unscripted'

export const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  size: 'Size',
  date: 'Date modified',
  duration: 'Duration',
  intensity: 'Intensity',
  peak: 'Peak speed',
}

/** Sorts that need the script analysed; unanalysed videos sink to the end. */
export const SCRIPT_SORTS: readonly SortKey[] = ['intensity', 'peak']

/**
 * Pick a sort. Choosing the current key again flips it; a new key starts in
 * the direction anyone choosing it wants: A→Z, but newest, longest, biggest
 * and most intense first.
 */
export function nextSort(cur: SortState, key: SortKey, asc?: boolean): SortState {
  if (asc !== undefined)
    return { key, asc }
  if (cur.key === key)
    return { key, asc: !cur.asc }
  return { key, asc: key === 'name' }
}

/** Toggle a chip, dropping whichever chips it contradicts. */
export function toggleFilter(set: ReadonlySet<FilterKey>, f: FilterKey): Set<FilterKey> {
  const next = new Set(set)
  if (next.has(f)) {
    next.delete(f)
    return next
  }
  next.add(f)
  if (f === 'scripted' || f === 'multi')
    next.delete('unscripted')
  if (f === 'unscripted') {
    next.delete('scripted')
    next.delete('multi')
  }
  return next
}

/** Bands combine with OR: "gentle or medium" is a sensible ask, "gentle and intense" is not. */
export function toggleBand(set: ReadonlySet<IntensityBand>, b: IntensityBand): Set<IntensityBand> {
  const next = new Set(set)
  if (next.has(b))
    next.delete(b)
  else
    next.add(b)
  return next
}

/** Axis count, so a merged single file counts and alternate takes do not. */
export const isMulti = (v: VideoEntry) => v.scriptCount > 1 || v.scriptType === 'merged'

/** `q` is already trimmed and lower-cased. Names, creators and tags. */
export function matchesQuery(v: VideoEntry, q: string): boolean {
  if (!q || v.basename.toLowerCase().includes(q))
    return true
  const m = effectiveMeta(v)
  return !!(m.creator?.toLowerCase().includes(q) || m.tags?.some(t => t.includes(q)))
}

export type SummaryOf = (name: string) => ScriptSummary | undefined

export interface LibraryQuery {
  query: string
  filters: ReadonlySet<FilterKey>
  bands: ReadonlySet<IntensityBand>
  sort: SortState
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
export const byName = (a: VideoEntry, b: VideoEntry) => collator.compare(a.basename, b.basename)

function sortValue(v: VideoEntry, key: SortKey, summaryOf: SummaryOf): number | undefined {
  switch (key) {
    case 'size': return v.file.size
    case 'date': return v.file.lastModified ?? 0
    case 'duration': return v.duration ?? 0
    case 'intensity': return summaryOf(v.name)?.meanSpeed
    case 'peak': return summaryOf(v.name)?.peakSpeed
    default: return 0
  }
}

/**
 * Sort in place. Ties fall back to the name so the order is stable across
 * re-sorts, and for the script sorts anything without an analysis goes last
 * whichever way round, since "unknown" is neither gentle nor intense.
 */
export function sortEntries(list: VideoEntry[], sort: SortState, summaryOf: SummaryOf): VideoEntry[] {
  const { key, asc } = sort
  if (key === 'name')
    return list.sort((a, b) => (asc ? byName(a, b) : byName(b, a)))

  // Read every key once rather than twice per comparison.
  const val = new Map<VideoEntry, number | undefined>()
  for (const v of list)
    val.set(v, sortValue(v, key, summaryOf))
  return list.sort((a, b) => {
    const x = val.get(a)
    const y = val.get(b)
    if (x === undefined || y === undefined) {
      if (x !== y)
        return x === undefined ? 1 : -1
      return byName(a, b)
    }
    const cmp = asc ? x - y : y - x
    return cmp || byName(a, b)
  })
}

export function filterEntries(videos: readonly VideoEntry[], q: Omit<LibraryQuery, 'sort'>, summaryOf: SummaryOf): VideoEntry[] {
  const text = q.query.trim().toLowerCase()
  const f = q.filters
  const bands = q.bands
  return videos.filter((v) => {
    if (f.has('scripted') && !v.hasScript)
      return false
    if (f.has('unscripted') && v.hasScript)
      return false
    if (f.has('multi') && !isMulti(v))
      return false
    if (f.has('starred') && !v.starred)
      return false
    if (bands.size) {
      const s = summaryOf(v.name)
      if (!s || !bands.has(intensityBand(s.meanSpeed)))
        return false
    }
    return matchesQuery(v, text)
  })
}

/** Filter, then sort. Returns a new array; `videos` is untouched. */
export function queryLibrary(videos: readonly VideoEntry[], q: LibraryQuery, summaryOf: SummaryOf): VideoEntry[] {
  return sortEntries(filterEntries(videos, q, summaryOf), q.sort, summaryOf)
}

/** Whether the result depends on script analyses, so it must refresh as they arrive. */
export function usesSummaries(q: Pick<LibraryQuery, 'bands' | 'sort'>): boolean {
  return q.bands.size > 0 || SCRIPT_SORTS.includes(q.sort.key)
}

export interface FilterCounts {
  scripted: number
  multi: number
  starred: number
  unscripted: number
}

export function filterCounts(videos: readonly VideoEntry[]): FilterCounts {
  let scripted = 0
  let multi = 0
  let starred = 0
  for (const v of videos) {
    if (v.hasScript)
      scripted++
    if (isMulti(v))
      multi++
    if (v.starred)
      starred++
  }
  return { scripted, multi, starred, unscripted: videos.length - scripted }
}

/** Videos per band, among those analysed. */
export function bandCounts(videos: readonly VideoEntry[], summaryOf: SummaryOf): Record<IntensityBand, number> {
  const out: Record<IntensityBand, number> = { gentle: 0, medium: 0, intense: 0 }
  for (const v of videos) {
    const s = summaryOf(v.name)
    if (s)
      out[intensityBand(s.meanSpeed)]++
  }
  return out
}
