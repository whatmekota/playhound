import type { ImageAsset } from './storeMeta'
import type { PluginManifest } from './types'
import { desktopOnlyReason, PERMISSIONS, PLUGIN_API, readManifest } from './manifest'
import { incompatibility, isImageAsset, readStoreFields } from './storeMeta'

export { newer } from './storeMeta'

/**
 * Plugin sources: GitHub repositories whose latest release carries a plugin.
 *
 * A release that wants to be found attaches the plugin zip and, next to it,
 * its manifest.json: the store reads that to show the plugin (name, version,
 * description) before anything is downloaded. Without a manifest asset the
 * release's tag and the repository's name stand in for them. Its icon and
 * screenshots are attached to the release too (see storeMeta.ts).
 */

/**
 * The official plugins, followed out of the box; the user can add and remove
 * sources. A new one here reaches existing users once (see addNewDefaults):
 * one they removed stays removed.
 */
export const DEFAULT_SOURCES = ['whatmekota/playmate', 'whatmekota/ph2gether', 'whatmekota/phbrowser', 'whatmekota/phthreads', 'whatmekota/phbeatbar', 'whatmekota/phstash', 'whatmekota/phvr', 'whatmekota/phpmv']

/** What 1.5 shipped as the only default, before defaults were tracked. */
const FIRST_DEFAULTS = ['whatmekota/playmate']

/**
 * Add the defaults this user hasn't been offered yet to their list. `seen` is
 * null when nothing was tracked yet: then the list predates tracking, and only
 * the first default had been offered. Returns the new list and the new `seen`.
 */
export function addNewDefaults(list: string[], seen: string[] | null): { list: string[], seen: string[] } {
  const offered = new Set(seen ?? FIRST_DEFAULTS)
  const next = [...list]
  for (const repo of DEFAULT_SOURCES) {
    if (offered.has(repo))
      continue
    offered.add(repo)
    if (!next.some(r => r.toLowerCase() === repo.toLowerCase()))
      next.push(repo)
  }
  return { list: next, seen: [...offered] }
}

/** Plugins from this owner's repositories are playhound's own. */
export const OFFICIAL_OWNER = 'whatmekota'

/**
 * Authors whose plugins playhound vouches for: people who've made good
 * plugins and are known to the project. Their repositories get a "trusted"
 * mark in the store. It's a statement about the author, not a review of
 * every release, and plugins still aren't sandboxed.
 */
export const TRUSTED_OWNERS: string[] = []

export type SourceTrust = 'official' | 'trusted' | null

/** Whether a repository ("owner/repo") is playhound's own, a trusted author's, or neither. */
export function trustOf(repo: string): SourceTrust {
  const owner = repo.split('/')[0]?.toLowerCase() ?? ''
  if (owner === OFFICIAL_OWNER.toLowerCase())
    return 'official'
  return TRUSTED_OWNERS.some(o => o.toLowerCase() === owner) ? 'trusted' : null
}

/** "owner/repo" from that or a github.com URL; null if it's neither. */
export function parseRepo(input: string): string | null {
  const s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/.*)?$/i) ?? s.match(/^([\w.-]+)\/([\w.-]+)$/)
  return m ? `${m[1]}/${m[2]}` : null
}

export interface SourceRelease {
  repo: string
  version: string
  /** From the release's manifest.json, when it has one. */
  manifest: PluginManifest | null
  zipUrl: string
  zipSize: number
  pageUrl: string
  publishedAt: string
  /** The release notes (Markdown). */
  notes: string
  /** How often its zips were downloaded, over all its releases. */
  downloads: number | null
  /** Images attached to the release: where the store's icon and screenshots come from. */
  images: ImageAsset[]
  /** Why this playhound can't install it (too old, a broken manifest), or null. */
  problem: string | null
}

interface GhAsset { name: string, browser_download_url: string, size: number, download_count?: number }
interface GhRelease { tag_name: string, html_url: string, published_at: string, assets: GhAsset[], draft?: boolean, prerelease?: boolean, body?: string | null }

/** The plugin parts of a GitHub release; null if it has no zip. */
export function readRelease(repo: string, r: GhRelease): { release: Omit<SourceRelease, 'manifest' | 'problem'>, manifestUrl: string | null } | null {
  const zip = r.assets.find(a => /\.zip$/i.test(a.name))
  if (!zip)
    return null
  const manifest = r.assets.find(a => a.name.toLowerCase() === 'manifest.json')
  return {
    release: {
      repo,
      version: r.tag_name.replace(/^v/, ''),
      zipUrl: zip.browser_download_url,
      zipSize: zip.size,
      pageUrl: r.html_url,
      publishedAt: r.published_at,
      notes: typeof r.body === 'string' ? r.body : '',
      downloads: typeof zip.download_count === 'number' ? zip.download_count : null,
      images: r.assets.filter(a => isImageAsset(a.name)).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size })),
    },
    manifestUrl: manifest?.browser_download_url ?? null,
  }
}

/** Zip downloads over a repository's releases. */
export function totalDownloads(releases: GhRelease[]): number | null {
  let total = 0
  let any = false
  for (const r of releases) {
    for (const a of r.assets) {
      if (/\.zip$/i.test(a.name) && typeof a.download_count === 'number') {
        total += a.download_count
        any = true
      }
    }
  }
  return any ? total : null
}

/**
 * A release's manifest.json as the store shows it. One this playhound can't
 * install (written for a newer one, or broken) still shows, with why.
 */
export function listingManifest(raw: unknown): { manifest: PluginManifest | null, problem: string | null } {
  try {
    const manifest = readManifest(raw)
    return { manifest, problem: null }
  }
  catch (err) {
    const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    const id = str(m.id)
    const name = str(m.name)
    const version = str(m.version)
    const manifest: PluginManifest | null = id && name && version
      ? {
          id,
          name,
          version,
          description: str(m.description),
          author: str(m.author),
          api: typeof m.api === 'number' ? m.api : undefined,
          // The ones this playhound knows, so the store can still say what it asks for.
          ...(Array.isArray(m.permissions) ? { permissions: PERMISSIONS.map(p => p.id).filter(p => (m.permissions as unknown[]).includes(p)) } : {}),
          ...readStoreFields(m).fields,
        }
      : null
    const why = manifest && (incompatibility(manifest, PLUGIN_API) || desktopOnlyReason(manifest.permissions))
    return { manifest, problem: why || (err instanceof Error ? err.message : String(err)) }
  }
}

/** Why a source can't be followed or read, with the kind of failure (adding one that isn't a plugin is refused). */
export class SourceError extends Error {
  constructor(public kind: 'not-found' | 'no-release' | 'no-zip' | 'rate' | 'offline' | 'other', message: string) {
    super(message)
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

async function gh(fetchFn: Fetch, url: string, accept = 'application/vnd.github+json'): Promise<Response> {
  let res: Response
  try {
    res = await fetchFn(url, { headers: { Accept: accept } })
  }
  catch {
    throw new SourceError('offline', 'Couldn\'t reach GitHub. Check the connection (or the proxy in Settings → Network).')
  }
  if (res.status === 403 || res.status === 429)
    throw new SourceError('rate', 'GitHub says to slow down. Try again in a while.')
  return res
}

/** The latest release of one source, with its manifest if it has one. One GitHub API call. */
export async function fetchRelease(fetchFn: Fetch, repo: string): Promise<SourceRelease> {
  const res = await gh(fetchFn, `https://api.github.com/repos/${repo}/releases?per_page=100`)
  if (res.status === 404)
    throw new SourceError('not-found', 'No such repository on GitHub (or it is private)')
  if (!res.ok)
    throw new SourceError('other', `GitHub answered ${res.status}`)
  const list = await res.json() as GhRelease[]
  const published = Array.isArray(list) ? list.filter(r => !r.draft && !r.prerelease) : []
  if (!published.length)
    throw new SourceError('no-release', 'It has no releases yet, so there is nothing to install')
  const latest = published[0]
  const parts = readRelease(repo, latest)
  if (!parts)
    throw new SourceError('no-zip', `Its latest release (${latest.tag_name}) has no plugin .zip attached`)
  let manifest: PluginManifest | null = null
  let problem: string | null = null
  if (parts.manifestUrl) {
    try {
      const m = await fetchFn(parts.manifestUrl)
      if (m.ok)
        ({ manifest, problem } = listingManifest(await m.json()))
    }
    catch {}
  }
  return { ...parts.release, downloads: totalDownloads(published) ?? parts.release.downloads, manifest, problem }
}

/** A repository's README, as Markdown; null if it has none. */
export async function fetchReadme(fetchFn: Fetch, repo: string): Promise<string | null> {
  const res = await gh(fetchFn, `https://api.github.com/repos/${repo}/readme`, 'application/vnd.github.raw+json')
  if (res.status === 404)
    return null
  if (!res.ok)
    throw new SourceError('other', `GitHub answered ${res.status}`)
  return (await res.text()).slice(0, 100_000)
}
