import type { SourceRelease, SourceTrust } from './sources'
import type { ImageRef } from './storeCache'
import type { PluginCategory } from './storeMeta'
import type { PluginManifest } from './types'
import type { PluginInfo, SourceState } from '~/stores/pluginStore'
import { trustOf } from './sources'
import { newer, storeImages } from './storeMeta'

/**
 * One plugin as the store shows it: a followed repository (with its latest
 * release, and the installed plugin it is, if any), or an installed plugin
 * that no followed repository offers (from a zip, or a folder).
 */
export interface StoreEntry {
  key: string
  repo: string | null
  source: SourceState | null
  release: SourceRelease | null
  installed: PluginInfo | null
  /** What to show: the release's manifest, else the installed one's. */
  manifest: PluginManifest | null
  id: string
  name: string
  description: string
  author: string
  category: PluginCategory | null
  version: string | null
  trust: SourceTrust
  /** A newer release than the installed version. */
  update: SourceRelease | null
  /** Why the store can't install its release (needs a newer playhound, a broken manifest). */
  problem: string | null
}

const sameRepo = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase()

export function buildEntries(sourceList: string[], sources: Record<string, SourceState>, plugins: PluginInfo[]): StoreEntry[] {
  const out: StoreEntry[] = []
  const claimed = new Set<string>()
  for (const repo of sourceList) {
    const source = sources[repo] ?? null
    const release = source?.release ?? null
    const rm = release?.manifest ?? null
    const installed = plugins.find(p => (rm && p.manifest.id === rm.id) || sameRepo(p.source, repo)) ?? null
    if (installed)
      claimed.add(installed.manifest.id)
    const manifest = rm ?? installed?.manifest ?? null
    const name = repo.split('/')[1]
    out.push({
      key: repo,
      repo,
      source,
      release,
      installed,
      manifest,
      id: manifest?.id ?? name.toLowerCase(),
      name: manifest?.name ?? name,
      description: manifest?.description ?? '',
      author: manifest?.author ?? repo.split('/')[0],
      category: manifest?.category ?? null,
      version: release?.version ?? installed?.manifest.version ?? null,
      trust: trustOf(repo),
      update: installed && release && !installed.dev && newer(release.version, installed.manifest.version) ? release : null,
      problem: release?.problem ?? null,
    })
  }
  for (const p of plugins) {
    if (claimed.has(p.manifest.id))
      continue
    out.push({
      key: `local:${p.manifest.id}`,
      repo: p.source,
      source: null,
      release: null,
      installed: p,
      manifest: p.manifest,
      id: p.manifest.id,
      name: p.manifest.name,
      description: p.manifest.description ?? '',
      author: p.manifest.author ?? (p.source ? p.source.split('/')[0] : ''),
      category: p.manifest.category ?? null,
      version: p.manifest.version,
      trust: p.source ? trustOf(p.source) : null,
      update: null,
      problem: null,
    })
  }
  return out
}

type FileLoader = (id: string, path: string) => Promise<Blob | null>

/** The installed plugin's own package, where its icon and screenshots are when it has them. */
function packageRef(p: PluginInfo, file: string, load: FileLoader): ImageRef {
  return { kind: 'package', key: `${p.manifest.id}@${p.manifest.version}${p.dev ? `:dev${p.installedAt}` : ''}:${file}`, load: () => load(p.manifest.id, file) }
}

/** Where an entry's icon comes from: its release, or its installed package; null for a generated one. */
export function iconRef(e: StoreEntry, load: FileLoader): ImageRef | null {
  // A plugin loaded from a folder shows its own, so its author sees it.
  if (e.installed?.dev && e.installed.manifest.icon)
    return packageRef(e.installed, e.installed.manifest.icon, load)
  if (e.release) {
    const icon = storeImages(e.release.manifest, e.release.images).icon
    if (icon)
      return { kind: 'release', url: icon.url }
  }
  if (e.installed?.manifest.icon)
    return packageRef(e.installed, e.installed.manifest.icon, load)
  return null
}

export function screenshotRefs(e: StoreEntry, load: FileLoader): { image: ImageRef, caption?: string }[] {
  if (e.release && !e.installed?.dev) {
    const shots = storeImages(e.release.manifest, e.release.images).screenshots
    if (shots.length)
      return shots.map(s => ({ image: { kind: 'release', url: s.asset.url }, caption: s.caption }))
  }
  const p = e.installed
  return p?.manifest.screenshots?.map(s => ({ image: packageRef(p, s.file, load), caption: s.caption })) ?? []
}
