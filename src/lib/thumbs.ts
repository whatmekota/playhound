import type { Directive } from 'vue'
/**
 * Thumbnails, durations and saved metadata for library entries — everything
 * about a video that is slow to learn.
 *
 * Lives here rather than in the library view so the queue, the dock, playlists
 * and the up-next strip can ask for a picture whether or not the library has
 * ever been opened.
 *
 * Decoding a frame means spinning up a <video> element per file, which is the
 * expensive part, so it goes through a small worker pool:
 *
 * - newest request first, so whatever just scrolled into view wins over what
 *   scrolled past a second ago
 * - "lazy" requests (on-screen cards) can be dropped again with `thumbsFor`
 *   once they leave the screen, so a fast fling through thousands of videos
 *   does not leave thousands of decodes behind it
 * - cache hits never touch the pool: an IndexedDB read is cheap
 */
import type { VideoEntry } from '~/stores/libraryStore'
import { reactive, shallowReactive } from 'vue'
import { metaDb, thumbDb, videoMetaDb } from '~/lib/idb'

const THUMB_W = 320
const THUMB_H = 180
/** Concurrent frame decodes. More than this starves playback of the decoder. */
const WORKERS = 2
/** A file that never reports `seeked` (broken index, odd codec) gives up after this. */
const DECODE_TIMEOUT_MS = 15_000

/** Names being decoded right now, for skeleton shimmer. */
export const thumbBusy = shallowReactive(new Set<string>())
/** Names the browser could not decode, so cards show a placeholder instead of retrying forever. */
export const thumbFailed = shallowReactive(new Set<string>())

/** Resolve on the next idle slice (or after `timeout` ms, whichever is first). */
export function whenIdle(timeout = 500): Promise<void> {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window)
      window.requestIdleCallback(() => resolve(), { timeout })
    else
      setTimeout(resolve, 16)
  })
}

// ─── Thumbnails ────────────────────────────────────────────────────────────────

interface Job {
  entry: VideoEntry
  lazy: boolean
  resolve: () => void
}

const waiting: Job[] = []
const inflight = new Map<string, Promise<void>>()
let active = 0

function pump() {
  while (active < WORKERS && waiting.length) {
    // LIFO: the most recent request is the one the user is looking at.
    const job = waiting.pop()!
    active++
    thumbBusy.add(job.entry.name)
    decodeFrame(job.entry)
      .catch(() => thumbFailed.add(job.entry.name))
      .finally(() => {
        active--
        thumbBusy.delete(job.entry.name)
        inflight.delete(job.entry.name)
        job.resolve()
        pump()
      })
  }
}

function coverRect(sw: number, sh: number) {
  // Crop to 16:9 instead of stretching, so portrait and SBS clips stay in proportion.
  const target = THUMB_W / THUMB_H
  if (!sw || !sh)
    return { sx: 0, sy: 0, sw, sh }
  if (sw / sh > target) {
    const w = sh * target
    return { sx: (sw - w) / 2, sy: 0, sw: w, sh }
  }
  const h = sw / target
  return { sx: 0, sy: (sh - h) / 2, sw, sh: h }
}

function decodeFrame(entry: VideoEntry): Promise<void> {
  const url = URL.createObjectURL(entry.file)
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (err?: unknown) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      video.pause()
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
      if (err)
        reject(err)
      else
        resolve()
    }
    timer = setTimeout(() => done(new Error('decode timeout')), DECODE_TIMEOUT_MS)

    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration)) {
        setDuration(entry, video.duration)
        // Skip cold opens and title cards, but stay early enough to be representative.
        video.currentTime = Math.min(video.duration * 0.12, 60)
      }
      else {
        video.currentTime = 1
      }
    }, { once: true })
    // `seeked` can fire before the new frame is actually decoded, and a detached
    // element then draws as solid black. Wait for the frame to be presented
    // when the browser can say so, with a short fallback when it cannot.
    video.addEventListener('seeked', () => {
      const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
      if (typeof v.requestVideoFrameCallback === 'function') {
        let drawn = false
        const draw = () => {
          if (!drawn) {
            drawn = true
            capture()
          }
        }
        v.requestVideoFrameCallback(draw)
        setTimeout(draw, 400)
      }
      else {
        setTimeout(capture, 120)
      }
    }, { once: true })
    function capture() {
      try {
        const c = document.createElement('canvas')
        c.width = THUMB_W
        c.height = THUMB_H
        const r = coverRect(video.videoWidth, video.videoHeight)
        c.getContext('2d')!.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, THUMB_W, THUMB_H)
        const dataUrl = c.toDataURL('image/jpeg', 0.72)
        entry.thumbnailUrl = dataUrl
        void thumbDb.set(entry.name, dataUrl).catch(() => {})
        done()
      }
      catch (err) {
        done(err)
      }
    }
    video.addEventListener('error', () => done(new Error('decode error')), { once: true })
    video.src = url
  })
}

async function fromCache(entry: VideoEntry): Promise<boolean> {
  try {
    const cached = await thumbDb.get(entry.name)
    if (cached) {
      entry.thumbnailUrl = cached
      return true
    }
  }
  catch {
    // storage unavailable — fall through and decode
  }
  return false
}

/**
 * Make sure `entry.thumbnailUrl` is set: from the cache if possible, otherwise
 * by decoding a frame. Safe to call repeatedly; concurrent calls share one job.
 *
 * `lazy` marks a request that only matters while the card is on screen, so
 * `thumbsFor` may drop it again.
 */
export function ensureThumb(entry: VideoEntry, opts: { lazy?: boolean } = {}): Promise<void> {
  if (entry.thumbnailUrl || thumbFailed.has(entry.name))
    return Promise.resolve()
  const running = inflight.get(entry.name)
  if (running) {
    // An eager request upgrades a lazy one that is still waiting, so it survives scrolling.
    if (!opts.lazy) {
      const job = waiting.find(j => j.entry.name === entry.name)
      if (job)
        job.lazy = false
    }
    return running
  }

  const p = (async () => {
    if (await fromCache(entry)) {
      inflight.delete(entry.name)
      return
    }
    await new Promise<void>((resolve) => {
      waiting.push({ entry, lazy: !!opts.lazy, resolve })
      pump()
    })
  })()
  inflight.set(entry.name, p)
  return p
}

/** Ask for many at once without waiting (queue rows, playlist covers). */
export function prefetchThumbs(entries: VideoEntry[]) {
  for (const e of entries)
    void ensureThumb(e)
}

/**
 * "These are on screen now." Requests their thumbnails and drops any lazy
 * request for something that has scrolled away and not started decoding yet.
 */
export function thumbsFor(entries: VideoEntry[]) {
  const keep = new Set(entries.map(e => e.name))
  for (let i = waiting.length - 1; i >= 0; i--) {
    const job = waiting[i]
    if (job.lazy && !keep.has(job.entry.name)) {
      waiting.splice(i, 1)
      inflight.delete(job.entry.name)
      job.resolve()
    }
  }
  // Request in reverse so the first card on screen ends up at the top of the LIFO stack.
  for (let i = entries.length - 1; i >= 0; i--)
    void ensureThumb(entries[i], { lazy: true })
}

// One observer for every lazily thumbnailed row in the app.
const lazyTargets = new WeakMap<Element, VideoEntry>()
let lazyObserver: IntersectionObserver | null = null

function observer() {
  lazyObserver ??= new IntersectionObserver((records) => {
    for (const r of records) {
      if (!r.isIntersecting)
        continue
      const entry = lazyTargets.get(r.target)
      if (entry)
        void ensureThumb(entry)
      lazyObserver!.unobserve(r.target)
      lazyTargets.delete(r.target)
    }
  }, { rootMargin: '300px 0px' })
  return lazyObserver
}

function watchLazy(el: HTMLElement, entry: VideoEntry | null | undefined) {
  if (lazyTargets.get(el) === entry)
    return
  observer().unobserve(el)
  lazyTargets.delete(el)
  if (entry && !entry.thumbnailUrl) {
    lazyTargets.set(el, entry)
    observer().observe(el)
  }
}

/**
 * `v-lazy-thumb="entry"` on a row's thumbnail box: asks for the picture once
 * the row comes within a screen of the viewport, so long lists (queue,
 * playlists) only decode what anyone is going to see.
 */
export const vLazyThumb: Directive<HTMLElement, VideoEntry | null | undefined> = {
  mounted: (el, b) => watchLazy(el, b.value),
  updated: (el, b) => watchLazy(el, b.value),
  unmounted: (el) => {
    lazyObserver?.unobserve(el)
    lazyTargets.delete(el)
  },
}

/** Pull every already-cached thumbnail into memory. Cheap; never decodes. */
export async function warmCachedThumbs(entries: VideoEntry[]) {
  const BATCH = 64
  const todo = entries.filter(e => !e.thumbnailUrl)
  for (let i = 0; i < todo.length; i += BATCH) {
    await Promise.all(todo.slice(i, i + BATCH).map(fromCache))
    await whenIdle(300)
  }
}

// ─── Bulk generation ───────────────────────────────────────────────────────────

/** Progress of "generate every thumbnail", for whichever view wants to show it. */
export const thumbJob = reactive({ running: false, done: 0, total: 0 })
let jobCancelled = false

/** Decode every missing thumbnail, one idle slice at a time. */
export async function generateAllThumbs(entries: VideoEntry[]) {
  if (thumbJob.running)
    return
  const todo = entries.filter(e => !e.thumbnailUrl && !thumbFailed.has(e.name))
  if (!todo.length)
    return
  jobCancelled = false
  Object.assign(thumbJob, { running: true, done: 0, total: todo.length })
  try {
    // A couple at a time keeps both workers busy without flooding the pool,
    // which would push on-screen requests behind the whole backlog.
    for (let i = 0; i < todo.length; i += WORKERS) {
      if (jobCancelled)
        break
      await Promise.all(todo.slice(i, i + WORKERS).map(e => ensureThumb(e)))
      thumbJob.done = Math.min(todo.length, i + WORKERS)
      await whenIdle(800)
    }
  }
  finally {
    thumbJob.running = false
  }
}

export function cancelGenerateAll() {
  jobCancelled = true
}

// ─── Durations ─────────────────────────────────────────────────────────────────

const durationKey = (e: VideoEntry) => `dur:${e.name}|${e.file.size}|${e.file.lastModified}`
const durInflight = new Map<string, Promise<void>>()

function setDuration(entry: VideoEntry, secs: number) {
  if (entry.duration === secs)
    return
  entry.duration = secs
  void metaDb.set(durationKey(entry), secs).catch(() => {})
}

function probeDuration(entry: VideoEntry): Promise<void> {
  const url = URL.createObjectURL(entry.file)
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
      resolve()
    }
    timer = setTimeout(done, DECODE_TIMEOUT_MS)
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration))
        setDuration(entry, video.duration)
      done()
    }, { once: true })
    video.addEventListener('error', done, { once: true })
    video.src = url
  })
}

/**
 * Make sure `entry.duration` is known. Remembered per file (name, size, mtime)
 * so sorting by length works straight away on the next visit.
 */
export function ensureDuration(entry: VideoEntry): Promise<void> {
  if (entry.duration !== null)
    return Promise.resolve()
  const running = durInflight.get(entry.name)
  if (running)
    return running
  const p = (async () => {
    try {
      const cached = await metaDb.get<number>(durationKey(entry))
      if (typeof cached === 'number' && Number.isFinite(cached)) {
        entry.duration = cached
        return
      }
    }
    catch {}
    await probeDuration(entry)
  })().finally(() => durInflight.delete(entry.name))
  durInflight.set(entry.name, p)
  return p
}

/** Durations for a short list (a playlist, the queue), a few at a time. */
export async function ensureDurations(entries: VideoEntry[]) {
  const BATCH = 6
  const todo = entries.filter(e => e.duration === null)
  for (let i = 0; i < todo.length; i += BATCH)
    await Promise.all(todo.slice(i, i + BATCH).map(ensureDuration))
}

let durationRun = 0

/** Fill in every missing duration in the background. A newer call supersedes an older one. */
export async function loadDurations(entries: VideoEntry[]) {
  const run = ++durationRun
  const BATCH = 6
  const todo = entries.filter(e => e.duration === null)
  for (let i = 0; i < todo.length; i += BATCH) {
    if (run !== durationRun)
      return
    await whenIdle(200)
    await Promise.all(todo.slice(i, i + BATCH).map(ensureDuration))
  }
}

// ─── Saved metadata ───────────────────────────────────────────────────────────

/** Load each entry's user-edited info (tags, rating…) from IndexedDB. */
export async function loadUserMeta(entries: VideoEntry[]) {
  const BATCH = 64
  const todo = entries.filter(e => !e.userMeta)
  for (let i = 0; i < todo.length; i += BATCH) {
    await Promise.all(todo.slice(i, i + BATCH).map(async (e) => {
      try {
        const stored = await videoMetaDb.get(e.name)
        if (stored)
          e.userMeta = stored
      }
      catch {}
    }))
  }
}

let hydratedStamp = -1

/**
 * Everything a fresh library needs in the background: saved info first (smart
 * playlists filter on it), then durations. Thumbnails stay on demand.
 * Keyed on `library.loadedAt`, so calling it from several views is free.
 */
export async function hydrateLibrary(entries: VideoEntry[], stamp: number) {
  if (stamp === hydratedStamp || !entries.length)
    return
  hydratedStamp = stamp
  await loadUserMeta(entries)
  void loadDurations(entries)
}
