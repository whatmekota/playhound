import type { PluginManifest } from './types'

/**
 * Plugin sources: GitHub repositories whose latest release carries a plugin.
 *
 * A release that wants to be found attaches the plugin zip and, next to it,
 * its manifest.json: the store reads that to show the plugin (name, version,
 * description) before anything is downloaded. Without a manifest asset the
 * release's tag and the repository's name stand in for them.
 */

/** Shipped as the first source; the user can add and remove others. */
export const DEFAULT_SOURCES = ['whatmekota/playmate']

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

/** 1.10.0 > 1.9.2; a pre-release sorts below its release. Same rules as the app's own updater. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => String(v).replace(/^v/, '').split('-')
  const [ma, pa] = parse(a)
  const [mb, pb] = parse(b)
  const xa = ma.split('.').map(Number)
  const xb = mb.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((xa[i] || 0) !== (xb[i] || 0))
      return (xa[i] || 0) > (xb[i] || 0)
  }
  return !pa && !!pb
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
}

interface GhAsset { name: string, browser_download_url: string, size: number }
interface GhRelease { tag_name: string, html_url: string, published_at: string, assets: GhAsset[], draft?: boolean }

/** The plugin parts of a GitHub "latest release" answer; null if it has no zip. */
export function readRelease(repo: string, r: GhRelease): { release: Omit<SourceRelease, 'manifest'>, manifestUrl: string | null } | null {
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
    },
    manifestUrl: manifest?.browser_download_url ?? null,
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** The latest release of one source, with its manifest if it has one. */
export async function fetchRelease(fetchFn: Fetch, repo: string): Promise<SourceRelease> {
  const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
  if (res.status === 404)
    throw new Error('no release there (or no such repository)')
  if (res.status === 403 || res.status === 429)
    throw new Error('GitHub says to slow down; try again in a while')
  if (!res.ok)
    throw new Error(`GitHub: ${res.status}`)
  const parts = readRelease(repo, await res.json())
  if (!parts)
    throw new Error('its latest release has no plugin zip')
  let manifest: PluginManifest | null = null
  if (parts.manifestUrl) {
    try {
      const m = await fetchFn(parts.manifestUrl)
      if (m.ok)
        manifest = await m.json()
    }
    catch {}
  }
  return { ...parts.release, manifest }
}
