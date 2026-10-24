/**
 * How a library entry is described in lists: script badge, effective metadata,
 * sizes and dates. Shared by the library, playlists and queue so the same video
 * reads the same everywhere.
 */
import type { VideoMeta } from '~/lib/idb'
import type { ScriptType, VideoEntry } from '~/stores/libraryStore'

export interface ScriptBadge {
  kind: ScriptType
  /** Compact text for a card corner: '' for a single axis, the axis count otherwise. */
  short: string
  /** For list columns. */
  long: string
  /** Full explanation, for the tooltip. */
  title: string
}

/**
 * none / single / multi (several axis files) / merged (one file holding several
 * axes). Alternate takes are mentioned but never counted as axes.
 */
export function scriptBadge(entry: VideoEntry): ScriptBadge {
  const t = entry.scriptType
  if (!entry.hasScript || t === 'none')
    return { kind: 'none', short: '', long: 'No script', title: 'No script' }

  const alts = entry.altCount > 0
    ? ` · ${entry.altCount} alternate take${entry.altCount === 1 ? '' : 's'}`
    : ''
  const chans = entry.channels?.length ? ` (${entry.channels.join(', ')})` : ''

  if (t === 'merged') {
    return {
      kind: 'merged',
      short: String(entry.scriptCount),
      long: `${entry.scriptCount} axes · merged`,
      title: `Merged multi-axis script: ${entry.scriptCount} axes in one file${chans}${alts}`,
    }
  }
  if (t === 'multi') {
    return {
      kind: 'multi',
      short: String(entry.scriptCount),
      long: `${entry.scriptCount} axes`,
      title: `Multi-axis: ${entry.scriptCount} axis files${alts}`,
    }
  }
  return { kind: 'single', short: '', long: 'Script', title: `Scripted${chans}${alts}` }
}

/** User overrides win over what the script's own metadata says. */
export function effectiveMeta(entry: VideoEntry): VideoMeta {
  return { ...(entry.scriptMeta ?? {}), ...(entry.userMeta ?? {}) }
}

export function entryTags(entry: VideoEntry): string[] {
  return effectiveMeta(entry).tags ?? []
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3)
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2)
    return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

export function formatDate(ms: number | undefined): string {
  return ms ? dateFmt.format(ms) : ''
}

/** "1 h 23 min" for totals, where m:ss would be noise. */
export function formatTotal(secs: number): string {
  const m = Math.round(secs / 60)
  if (m < 60)
    return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}
