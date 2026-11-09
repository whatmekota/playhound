import type { ProvidedVideo } from './types'
import type { RemoteSource, VideoEntry } from '~/stores/libraryStore'
import { AXIS_MAP } from '~/lib/axisMap'
import { normalizeTags } from '~/lib/tags'
import { axisKeyFor } from './scripts'

/**
 * Videos a plugin adds to the library from another app (ctx.library.provide):
 * checking what it hands in, and making library entries of them.
 *
 * They live in the library beside the user's own files, with the source's
 * name as their folder (so the folder filter picks one source), a badge, and
 * a `remote` record saying where to stream from and where the scripts are.
 * They have no file: nothing reads them from disk, previews come from the
 * source's thumbnail, and scripts are fetched when the video is played.
 */

/** A plugin can't add more than this many at once. */
export const MAX_PROVIDED = 20_000

function httpUrl(u: unknown): string | null {
  if (typeof u !== 'string')
    return null
  try {
    const url = new URL(u.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  }
  catch {
    return null
  }
}

const imageUrl = (u: unknown): string | null => httpUrl(u) ?? (typeof u === 'string' && /^data:image\/[\w+.-]+[;,]/i.test(u) ? u : null)

function cleanHeaders(h: unknown): Record<string, string> | undefined {
  if (!h || typeof h !== 'object' || Array.isArray(h))
    return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) {
    if (/^[\w-]+$/.test(k) && (typeof v === 'string' || typeof v === 'number'))
      out[k] = String(v).replace(/[\r\n]/g, ' ')
  }
  return Object.keys(out).length ? out : undefined
}

/** A provided video as the library keeps it. */
export interface CleanVideo {
  id: string
  title: string
  url: string
  kind: 'file' | 'hls'
  headers?: Record<string, string>
  scripts: { axis: string, url: string }[]
  hasScript: boolean
  tags: string[]
  chapters: { name: string, start: number, end?: number }[]
  thumbnail: string | null
  duration: number | null
  sourceUrl: string | null
}

/** Check one video; the reason it can't be used, in words for the plugin's author. */
export function cleanProvided(raw: unknown, opts: { loader?: boolean } = {}): CleanVideo | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { error: 'not an object' }
  const v = raw as Partial<ProvidedVideo> & Record<string, unknown>
  const id = typeof v.id === 'number' && Number.isFinite(v.id) ? String(v.id) : typeof v.id === 'string' ? v.id.trim() : ''
  if (!id || id.length > 200)
    return { error: '"id" must be a string (or number) of up to 200 characters' }
  const title = typeof v.title === 'string' ? v.title.trim().slice(0, 300) : ''
  if (!title)
    return { error: `${id}: "title" is missing` }
  const url = httpUrl(v.url)
  if (!url)
    return { error: `${id}: "url" must be an http(s) address` }
  const kind = v.kind === 'hls' || v.kind === 'file' ? v.kind : /\.m3u8(?:$|\?)/i.test(new URL(url).pathname) ? 'hls' : 'file'

  const scripts: { axis: string, url: string }[] = []
  if (v.scripts !== undefined) {
    if (!Array.isArray(v.scripts))
      return { error: `${id}: "scripts" must be a list of { axis, url }` }
    for (const s of v.scripts) {
      const axis = axisKeyFor(s?.axis)
      const su = httpUrl(s?.url)
      if (!axis)
        return { error: `${id}: unknown script axis "${String(s?.axis)}" (try L0, R0, V0, or twist, roll, vib…)` }
      if (!su)
        return { error: `${id}: a script's "url" must be an http(s) address` }
      // One per axis ("L0" and the stroke are one): the first wins.
      if (!scripts.some(x => AXIS_MAP[x.axis].channel === AXIS_MAP[axis].channel))
        scripts.push({ axis, url: su })
    }
  }

  const chapters: CleanVideo['chapters'] = []
  if (Array.isArray(v.chapters)) {
    for (const c of v.chapters) {
      const start = Number(c?.start)
      if (!c || typeof c.name !== 'string' || !c.name.trim() || !Number.isFinite(start) || start < 0)
        continue
      const end = Number(c.end)
      chapters.push({ name: c.name.trim().slice(0, 120), start, ...(Number.isFinite(end) && end > start ? { end } : {}) })
    }
    chapters.sort((a, b) => a.start - b.start)
  }

  const duration = Number(v.duration)
  return {
    id,
    title,
    url,
    kind,
    headers: cleanHeaders(v.headers),
    scripts,
    // Scripts come from their URLs, or from the provider's loader when it has one.
    hasScript: scripts.length > 0 || (!!opts.loader && v.hasScript === true),
    tags: normalizeTags(Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string') : []),
    chapters,
    thumbnail: imageUrl(v.thumbnail),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    sourceUrl: httpUrl(v.sourceUrl),
  }
}

/** Check a whole list: the usable ones (each id once, the first kept) and why the others weren't. */
export function cleanProvidedList(raw: unknown, opts: { loader?: boolean } = {}): { videos: CleanVideo[], errors: string[] } {
  if (!Array.isArray(raw))
    return { videos: [], errors: ['videos() must return a list'] }
  const videos: CleanVideo[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  for (const r of raw.slice(0, MAX_PROVIDED)) {
    const c = cleanProvided(r, opts)
    if ('error' in c) {
      errors.push(c.error)
      continue
    }
    if (seen.has(c.id)) {
      errors.push(`${c.id}: the same id twice; the first one is kept`)
      continue
    }
    seen.add(c.id)
    videos.push(c)
  }
  if (raw.length > MAX_PROVIDED)
    errors.push(`only the first ${MAX_PROVIDED} videos are kept`)
  return { videos, errors }
}

/** The library's name for a provided video: stable while its id is, and never a file's. */
export function providedName(owner: string, id: string): string {
  return `${owner}:${id}`
}

/** A library entry for a provided video. */
export function entryOf(v: CleanVideo, owner: string, label: string, extra: Pick<RemoteSource, 'loader'> = {}): VideoEntry {
  const name = providedName(owner, v.id)
  const remote: RemoteSource = {
    owner,
    label,
    id: v.id,
    url: v.url,
    kind: v.kind,
    headers: v.headers,
    scripts: v.scripts,
    chapters: v.chapters,
    sourceUrl: v.sourceUrl,
    loader: extra.loader,
  }
  return {
    // No file on disk: an empty stand-in, so code that only looks at a name or
    // a size keeps working. Nothing reads it (see the `remote` checks).
    file: new File([], name),
    name,
    basename: v.title,
    hasScript: v.hasScript,
    scriptCount: v.scripts.length || (v.hasScript ? 1 : 0),
    channels: undefined,
    altCount: 0,
    scriptFiles: [],
    scriptMatches: [],
    thumbnailUrl: v.thumbnail,
    duration: v.duration,
    scriptType: !v.hasScript ? 'none' : v.scripts.length > 1 ? 'multi' : 'single',
    path: `${label}/${v.title}`,
    folder: label,
    scriptMeta: { tags: v.tags, ...(v.sourceUrl ? { url: v.sourceUrl } : {}) },
    starred: false,
    remote,
  }
}
