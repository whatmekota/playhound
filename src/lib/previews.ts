/**
 * Scrub previews: a strip of small frames across each video, so hovering a
 * timeline (or a library card) can show what is there before anyone seeks.
 *
 * A strip is up to 160 frames at 160×90, packed into one JPEG sprite sheet and
 * kept in IndexedDB by name, size and mtime — a changed file gets a new one.
 * Building one means seeking a hidden <video> a hundred-odd times, which is
 * slow and competes with playback for the decoder, so:
 *
 * - one strip at a time, a frame per idle slice
 * - the video that is playing goes first ('now'); cards ask with 'low' and
 *   newest-first, and a 'now' request pre-empts a 'low' build in progress
 * - a 'low' request whose card has gone away is dropped before it starts
 * - cache hits never touch the queue
 */
import type { PreviewRecord } from '~/lib/idb'
import { reactive, shallowReactive } from 'vue'
import { previewDb } from '~/lib/idb'
import { whenIdle } from '~/lib/thumbs'

export interface PreviewStrip {
  /** Object URL of the sprite sheet. */
  url: string
  cols: number
  rows: number
  frameW: number
  frameH: number
  /** Seconds per frame: frame i covers [i·interval, (i+1)·interval). */
  interval: number
  count: number
}

/** Anything with a file and a stable name; a library VideoEntry is one. */
export interface PreviewSource {
  name: string
  file: File
}

export type PreviewPriority = 'now' | 'low'

const FORMAT = 1
const FRAME_W = 160
const FRAME_H = 90
/**
 * One frame per this many seconds of video. Every frame is a real seek and
 * decode, so a frame every couple of seconds made a long video take minutes;
 * for a hover preview, half a minute apart is plenty.
 */
const FRAME_EVERY_SEC = 30
/** Short videos still get this many, so a two-minute clip is not two images. */
const MIN_FRAMES = 8
const MAX_FRAMES = 120
const SHEET_COLS = 10
/** One seek that never lands (broken index, odd codec) gives up after this. */
const SEEK_TIMEOUT_MS = 8000
/** Strips kept decoded in memory; each is a few hundred KB. */
const MEMORY_STRIPS = 48
/** Strips kept on disk. */
const DISK_STRIPS = 300

export function previewKey(src: PreviewSource): string {
  return `${src.name}|${src.file.size}|${src.file.lastModified}`
}

// ─── State ────────────────────────────────────────────────────────────────────

const strips = shallowReactive(new Map<string, PreviewStrip>())
/** Not reactive on purpose: touched from render paths, read only on eviction. */
const lastUsed = new Map<string, number>()
const failed = new Set<string>()

/** The strip being built right now, for a progress hint. */
export const previewProgress = reactive({ key: null as string | null, done: 0, total: 0 })

/** The finished strip for `src`, or null. Reactive; never starts a build. */
export function getStrip(src: PreviewSource | null | undefined): PreviewStrip | null {
  if (!src)
    return null
  const key = previewKey(src)
  const s = strips.get(key) ?? null
  if (s)
    lastUsed.set(key, performance.now())
  return s
}

/** True while `src`'s strip is being decoded. Reactive. */
export function isStripBuilding(src: PreviewSource | null | undefined): boolean {
  return !!src && previewProgress.key === previewKey(src)
}

function remember(key: string, rec: PreviewRecord) {
  const old = strips.get(key)
  if (old)
    URL.revokeObjectURL(old.url)
  strips.set(key, {
    url: URL.createObjectURL(rec.blob),
    cols: rec.cols,
    rows: rec.rows,
    frameW: rec.frameW,
    frameH: rec.frameH,
    interval: rec.interval,
    count: rec.count,
  })
  lastUsed.set(key, performance.now())
  while (strips.size > MEMORY_STRIPS) {
    let oldest = ''
    let at = Number.POSITIVE_INFINITY
    for (const k of strips.keys()) {
      const t = lastUsed.get(k) ?? 0
      if (t < at && k !== key) {
        at = t
        oldest = k
      }
    }
    const s = strips.get(oldest)
    if (s)
      URL.revokeObjectURL(s.url)
    strips.delete(oldest)
    lastUsed.delete(oldest)
  }
}

// ─── Requests ────────────────────────────────────────────────────────────────

interface Request {
  key: string
  src: PreviewSource
  priority: PreviewPriority
  refs: number
  /** Newest first among equals. */
  seq: number
  state: 'lookup' | 'queued' | 'running'
}

/** Every live request, whatever stage it is at. */
const requests = new Map<string, Request>()
const lookups = new Map<string, Promise<boolean>>()
let current: { req: Request, abort: AbortController } | null = null
let seq = 0
let pumping = false
let builtSincePrune = 0

/** Try the disk cache. Resolves true when the strip is now in memory. */
function lookup(key: string): Promise<boolean> {
  let p = lookups.get(key)
  if (!p) {
    p = previewDb.get(key)
      .then((rec) => {
        if (rec && rec.v === FORMAT && rec.blob) {
          remember(key, rec)
          // Refresh its age so pruning keeps what is in use.
          void previewDb.set(key, { ...rec, at: Date.now() }).catch(() => {})
          return true
        }
        return false
      })
      .catch(() => false)
      .finally(() => lookups.delete(key))
    lookups.set(key, p)
  }
  return p
}

/**
 * Ask for `src`'s strip. Loads it from the cache or queues a build; the strip
 * appears in `getStrip` when ready. Returns a release function: once every
 * requester has released a request that has not started, it is dropped.
 */
export function requestStrip(src: PreviewSource, priority: PreviewPriority = 'low'): () => void {
  const key = previewKey(src)
  if (strips.has(key) || failed.has(key))
    return () => {}

  let req = requests.get(key)
  if (req) {
    req.refs++
    req.seq = ++seq
    if (priority === 'now')
      req.priority = 'now'
    if (req.state === 'queued')
      preemptFor(req)
  }
  else {
    const r: Request = { key, src, priority, refs: 1, seq: ++seq, state: 'lookup' }
    req = r
    requests.set(key, r)
    void lookup(key).then((hit) => {
      if (requests.get(key) !== r)
        return
      if (hit) {
        requests.delete(key)
        return
      }
      r.state = 'queued'
      preemptFor(r)
      void pump()
    })
  }

  let released = false
  const r = req
  return () => {
    if (released)
      return
    released = true
    r.refs--
    if (r.refs > 0)
      return
    if (r.state !== 'running')
      requests.delete(r.key)
    // A track that has been skipped past is not worth finishing; a card that
    // scrolled away mid-build is (the work is cached for next time).
    else if (r.priority === 'now' && current?.req === r)
      current.abort.abort()
  }
}

/** A 'now' request stops a 'low' build, which goes back in the queue. */
function preemptFor(req: Request) {
  if (req.priority === 'now' && current && current.req !== req && current.req.priority !== 'now')
    current.abort.abort()
}

function nextRequest(): Request | null {
  let best: Request | null = null
  for (const r of requests.values()) {
    if (r.state !== 'queued')
      continue
    if (!best
      || (r.priority === 'now' && best.priority !== 'now')
      || (r.priority === best.priority && r.seq > best.seq)) {
      best = r
    }
  }
  return best
}

async function pump() {
  if (pumping)
    return
  pumping = true
  try {
    while (true) {
      await whenIdle(1000)
      const req = nextRequest()
      if (!req)
        break
      req.state = 'running'
      const abort = new AbortController()
      current = { req, abort }
      Object.assign(previewProgress, { key: req.key, done: 0, total: 0 })
      try {
        const rec = await buildStrip(req.src, abort.signal)
        remember(req.key, rec)
        requests.delete(req.key)
        void previewDb.set(req.key, rec).catch(() => {})
        if (++builtSincePrune >= 10) {
          builtSincePrune = 0
          void previewDb.prune(DISK_STRIPS).catch(() => {})
        }
      }
      catch {
        // An abort is a pre-emption or a cancel, not a broken file: a
        // pre-empted request that is still wanted goes back in line.
        if (abort.signal.aborted && req.refs > 0) {
          req.state = 'queued'
        }
        else {
          if (!abort.signal.aborted)
            failed.add(req.key)
          requests.delete(req.key)
        }
      }
      finally {
        current = null
        Object.assign(previewProgress, { key: null, done: 0, total: 0 })
      }
    }
  }
  finally {
    pumping = false
  }
}

// ─── Decoding ────────────────────────────────────────────────────────────────

/**
 * Side-by-side VR is two eyes in one frame; a crop of the middle is the seam
 * between them. Take the left eye instead.
 */
function looksSbs(name: string, w: number, h: number) {
  const aspect = w / h
  return (aspect > 1.95 && aspect < 2.05)
    || (aspect > 1.6 && /(?:^|[^a-z0-9])(?:180|vr|sbs|lr|3dh)(?:[^a-z0-9]|$)/i.test(name))
}

/** Source rect that fills a 16:9 frame without stretching. */
function cropRect(name: string, vw: number, vh: number) {
  const sx = 0
  const sw = looksSbs(name, vw, vh) ? vw / 2 : vw
  const sh = vh
  const target = FRAME_W / FRAME_H
  if (!sw || !sh)
    return { sx, sy: 0, sw, sh }
  if (sw / sh > target) {
    const w = sh * target
    return { sx: sx + (sw - w) / 2, sy: 0, sw: w, sh }
  }
  const h = sw / target
  return { sx, sy: (sh - h) / 2, sw, sh: h }
}

function abortError() {
  return new DOMException('Aborted', 'AbortError')
}

/** Resolve on `event` from `el`, rejecting on error, timeout or abort. */
function once(el: HTMLVideoElement, event: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const handlers: [EventTarget, string, () => void][] = []
    const settle = (err?: unknown) => {
      clearTimeout(timer)
      for (const [target, name, fn] of handlers)
        target.removeEventListener(name, fn)
      if (err)
        reject(err)
      else
        resolve()
    }
    const on = (target: EventTarget, name: string, fn: () => void) => {
      handlers.push([target, name, fn])
      target.addEventListener(name, fn, { once: true })
    }
    on(el, event, () => settle())
    on(el, 'error', () => settle(new Error('decode error')))
    on(signal, 'abort', () => settle(abortError()))
    timer = setTimeout(() => settle(new Error(`${event} timeout`)), timeoutMs)
  })
}

/**
 * Seek and wait until the frame is actually there to draw. `seeked` can fire
 * before the new frame is decoded, and a detached element then draws solid
 * black (see thumbs.ts); waiting for the presented frame avoids that.
 */
async function seekFrame(video: HTMLVideoElement, t: number, signal: AbortSignal) {
  const landed = once(video, 'seeked', signal, SEEK_TIMEOUT_MS)
  video.currentTime = t
  await landed
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
  await new Promise<void>((resolve) => {
    if (typeof v.requestVideoFrameCallback === 'function') {
      let done = false
      const finish = () => {
        if (!done) {
          done = true
          resolve()
        }
      }
      v.requestVideoFrameCallback(finish)
      setTimeout(finish, 400)
    }
    else {
      setTimeout(resolve, 120)
    }
  })
  if (signal.aborted)
    throw abortError()
}

async function buildStrip(src: PreviewSource, signal: AbortSignal): Promise<PreviewRecord> {
  const url = URL.createObjectURL(src.file)
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  try {
    const meta = once(video, 'loadedmetadata', signal, SEEK_TIMEOUT_MS * 2)
    video.src = url
    await meta
    const duration = video.duration
    if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth)
      throw new Error('no duration')

    const count = Math.max(1, Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round(duration / FRAME_EVERY_SEC))))
    const interval = duration / count
    const cols = Math.min(SHEET_COLS, count)
    const rows = Math.ceil(count / cols)
    previewProgress.total = count

    const canvas = document.createElement('canvas')
    canvas.width = cols * FRAME_W
    canvas.height = rows * FRAME_H
    const ctx = canvas.getContext('2d')
    if (!ctx)
      throw new Error('no canvas')
    const r = cropRect(src.name, video.videoWidth, video.videoHeight)

    for (let i = 0; i < count; i++) {
      if (signal.aborted)
        throw abortError()
      // A frame per idle slice keeps the page responsive while it runs, but
      // never wait long for one: with few frames the whole strip is quick.
      await whenIdle(150)
      await seekFrame(video, Math.min(duration - 0.05, (i + 0.5) * interval), signal)
      ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, (i % cols) * FRAME_W, Math.floor(i / cols) * FRAME_H, FRAME_W, FRAME_H)
      previewProgress.done = i + 1
    }

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.7))
    if (!blob)
      throw new Error('encode failed')
    return { v: FORMAT, blob, cols, rows, frameW: FRAME_W, frameH: FRAME_H, interval, count, at: Date.now() }
  }
  finally {
    video.pause()
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

// ─── Drawing helpers ─────────────────────────────────────────────────────────

/** Which frame shows `seconds` into the video. */
export function frameAt(strip: PreviewStrip, seconds: number): number {
  return Math.max(0, Math.min(strip.count - 1, Math.floor(seconds / strip.interval)))
}

/**
 * CSS that shows one frame of the sheet filling its element, at any size:
 * the sheet is scaled to cols×rows of the element and positioned by percent.
 */
export function frameStyle(strip: PreviewStrip, index: number): Record<string, string> {
  const col = index % strip.cols
  const row = Math.floor(index / strip.cols)
  const x = strip.cols > 1 ? (col / (strip.cols - 1)) * 100 : 0
  const y = strip.rows > 1 ? (row / (strip.rows - 1)) * 100 : 0
  return {
    backgroundImage: `url("${strip.url}")`,
    backgroundSize: `${strip.cols * 100}% ${strip.rows * 100}%`,
    backgroundPosition: `${x}% ${y}%`,
    backgroundRepeat: 'no-repeat',
  }
}
