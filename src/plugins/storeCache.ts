import type { Ref } from 'vue'
import type { SourceRelease } from './sources'
import { ref, watch } from 'vue'
import { pluginDb } from '~/lib/idb'
import { pluginFetch } from './net'
import { fetchReadme } from './sources'
import { APP_VERSION, checkImage, IMAGE_MIME } from './storeMeta'

/**
 * What the plugin store keeps between visits, in the plugins database: the
 * sources' latest releases as last checked (so the store opens with them, and
 * shows them offline), the icons and screenshots it downloaded (checked
 * first; see storeMeta.checkImage), and READMEs. All of it is a cache: losing
 * it costs a few downloads.
 *
 *   store:releases        { app: version, sources: Record<repo, CachedSource> }
 *   store:media:<url>     MediaRecord, one per release asset (a new version is a new URL)
 *   store:readme:<repo>   ReadmeRecord
 */

export interface CachedSource {
  release: SourceRelease | null
  error: string
  checkedAt: number
}

const RELEASES_KEY = 'store:releases'
const MEDIA_PREFIX = 'store:media:'
const README_PREFIX = 'store:readme:'
/** Images kept; the oldest go first. A store page shows a few dozen at most. */
const MAX_MEDIA = 120
/** A README is fetched again after this long (or when its plugin has a new release). */
const README_TTL = 24 * 60 * 60 * 1000

/** IndexedDB can't store Vue's proxies; a plain copy can. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/**
 * The releases as last checked. Kept by another playhound version, they're
 * dropped: whether each plugin can be installed was worked out for that one.
 */
export async function loadReleases(): Promise<Record<string, CachedSource>> {
  try {
    const kept = await pluginDb.get<{ app: string, sources: Record<string, CachedSource> }>(RELEASES_KEY)
    return kept?.app === APP_VERSION ? kept.sources : {}
  }
  catch {
    return {}
  }
}

export async function saveReleases(all: Record<string, CachedSource>): Promise<void> {
  try {
    await pluginDb.set(RELEASES_KEY, plain({ app: APP_VERSION, sources: all }))
  }
  catch (err) {
    console.warn('[plugins] could not keep the store\'s releases', err)
  }
}

// ─── Images ──────────────────────────────────────────────────────────────────

interface MediaRecord {
  /** Null when the file was refused; `problem` says why, and it isn't fetched again. */
  blob: Blob | null
  problem?: string
  at: number
}

/** Object URLs handed out, by key; they live as long as the page. */
const objectUrls = new Map<string, Promise<string | null>>()

async function pruneMedia() {
  const keys = await pluginDb.keys(MEDIA_PREFIX)
  if (keys.length <= MAX_MEDIA)
    return
  const ages = await Promise.all(keys.map(async k => ({ k, at: (await pluginDb.get<MediaRecord>(k))?.at ?? 0 })))
  ages.sort((a, b) => a.at - b.at)
  for (const { k } of ages.slice(0, keys.length - MAX_MEDIA))
    await pluginDb.del(k)
}

/**
 * A release asset as a picture: from the cache, or downloaded, checked and
 * kept. An object URL, or null if it can't be had or isn't a fit image.
 */
export function releaseImage(url: string, role: 'icon' | 'screenshot'): Promise<string | null> {
  const key = MEDIA_PREFIX + url
  let p = objectUrls.get(key)
  if (!p) {
    p = (async () => {
      let rec = await pluginDb.get<MediaRecord>(key).catch(() => undefined)
      if (!rec) {
        const res = await pluginFetch(url)
        if (!res.ok)
          return null
        const bytes = new Uint8Array(await res.arrayBuffer())
        const check = checkImage(bytes, role)
        rec = check.ok
          ? { blob: new Blob([bytes as BlobPart], { type: IMAGE_MIME[check.type] }), at: Date.now() }
          : { blob: null, problem: check.problem, at: Date.now() }
        if (!check.ok)
          console.warn(`[plugins] store ${role} ${url}: ${check.problem}`)
        await pluginDb.set(key, rec).catch(() => {})
        void pruneMedia().catch(() => {})
      }
      return rec.blob ? URL.createObjectURL(rec.blob) : null
    })().catch(() => null)
    objectUrls.set(key, p)
    // A failed download may work next time.
    void p.then(u => u === null && objectUrls.delete(key))
  }
  return p
}

/**
 * A file from a plugin's own package as a picture, checked the same way. `key`
 * names the plugin's version and file, so an update reads it again.
 */
export function packageImage(key: string, load: () => Promise<Blob | null>, role: 'icon' | 'screenshot'): Promise<string | null> {
  const k = `pkg:${key}`
  let p = objectUrls.get(k)
  if (!p) {
    p = (async () => {
      const blob = await load()
      if (!blob)
        return null
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const check = checkImage(bytes, role)
      if (!check.ok) {
        console.warn(`[plugins] ${role} ${key}: ${check.problem}`)
        return null
      }
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: IMAGE_MIME[check.type] }))
    })().catch(() => null)
    objectUrls.set(k, p)
  }
  return p
}

/** Where a picture comes from: a release asset, or a file in an installed package. */
export type ImageRef
  = | { kind: 'release', url: string }
    | { kind: 'package', key: string, load: () => Promise<Blob | null> }

export function loadImage(r: ImageRef, role: 'icon' | 'screenshot'): Promise<string | null> {
  return r.kind === 'release' ? releaseImage(r.url, role) : packageImage(r.key, r.load, role)
}

/** The picture a ref points at, as a reactive URL (null while loading, or if there's none). */
export function useImage(get: () => ImageRef | null, role: 'icon' | 'screenshot'): Ref<string | null> {
  const url = ref<string | null>(null)
  watch(() => {
    const r = get()
    return r ? (r.kind === 'release' ? r.url : r.key) : null
  }, async (id) => {
    const r = get()
    if (!id || !r) {
      url.value = null
      return
    }
    const u = await loadImage(r, role)
    // Still the one asked for?
    const now = get()
    if (now && (now.kind === 'release' ? now.url : now.key) === id)
      url.value = u
  }, { immediate: true })
  return url
}

// ─── READMEs ─────────────────────────────────────────────────────────────────

interface ReadmeRecord {
  text: string | null
  version: string
  at: number
}

/**
 * A repository's README: kept for a day, and fetched again when its plugin
 * has a new release. When GitHub can't be reached, the kept one (however
 * old) is better than nothing.
 */
export async function readme(repo: string, version: string): Promise<string | null> {
  const key = README_PREFIX + repo.toLowerCase()
  const kept = await pluginDb.get<ReadmeRecord>(key).catch(() => undefined)
  if (kept && kept.version === version && Date.now() - kept.at < README_TTL)
    return kept.text
  try {
    const text = await fetchReadme(pluginFetch, repo)
    await pluginDb.set(key, { text, version, at: Date.now() }).catch(() => {})
    return text
  }
  catch (err) {
    if (kept)
      return kept.text
    throw err
  }
}
