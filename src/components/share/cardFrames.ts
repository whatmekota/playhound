import type { Pic } from './drawCard'
import { looksSbs } from '~/lib/previews'

/**
 * Frames for a share card, from the video's own source in a hidden <video>
 * of its own: the player is never seeked, paused or slowed. One frame at a
 * time; a newer request of the same kind (a drag on the timeline) replaces
 * one still waiting.
 */
export interface FrameGrabber {
  /** The video's length in seconds. */
  duration: number
  /** The frame at `sec`, at most `maxWidth` wide; null if it cannot be had (or was replaced). */
  grab: (sec: number, maxWidth?: number, kind?: string) => Promise<Pic | null>
  dispose: () => void
}

/** Where the frames come from. */
export interface FrameMedia {
  url: string
  /** For telling side-by-side VR from a wide picture. */
  name: string
  /** A stream from elsewhere: asked for with CORS, so its pixels can be read. */
  cross: boolean
  /** Given back when the grabber is done (an object URL made for it). */
  release?: () => void
}

const META_TIMEOUT_MS = 15_000
const SEEK_TIMEOUT_MS = 10_000

function wait(el: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ac = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (err?: Error) => {
      clearTimeout(timer)
      ac.abort()
      if (err)
        reject(err)
      else
        resolve()
    }
    el.addEventListener(event, () => done(), { once: true, signal: ac.signal })
    el.addEventListener('error', () => done(new Error('unreadable')), { once: true, signal: ac.signal })
    timer = setTimeout(done, timeoutMs, new Error(`${event} timeout`))
  })
}

/** Seek, then wait until the new frame is really there (see previews.ts). */
async function seek(v: HTMLVideoElement, t: number) {
  if (Math.abs(v.currentTime - t) > 0.001 || v.readyState < 2) {
    const landed = wait(v, 'seeked', SEEK_TIMEOUT_MS)
    v.currentTime = t
    await landed
  }
  const rv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
  await new Promise<void>((resolve) => {
    if (typeof rv.requestVideoFrameCallback === 'function') {
      let done = false
      const finish = () => {
        if (!done) {
          done = true
          resolve()
        }
      }
      rv.requestVideoFrameCallback(finish)
      setTimeout(finish, 350)
    }
    else {
      setTimeout(resolve, 120)
    }
  })
}

/**
 * Open `media` for frames. Null when it cannot be read, or when its pixels
 * cannot be (a stream from a server that does not allow it).
 */
export async function openGrabber(media: FrameMedia): Promise<FrameGrabber | null> {
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  v.playsInline = true
  if (media.cross)
    v.crossOrigin = 'anonymous'
  const close = () => {
    v.removeAttribute('src')
    v.load()
    media.release?.()
  }
  try {
    const meta = wait(v, 'loadedmetadata', META_TIMEOUT_MS)
    v.src = media.url
    await meta
    if (!v.videoWidth || !Number.isFinite(v.duration) || v.duration <= 0)
      throw new Error('no picture')
  }
  catch {
    close()
    return null
  }

  const sbs = looksSbs(media.name, v.videoWidth, v.videoHeight)
  const draw = (maxWidth: number): Pic | null => {
    const sw = sbs ? v.videoWidth / 2 : v.videoWidth
    const sh = v.videoHeight
    const scale = Math.min(1, maxWidth / sw)
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d')
    if (!g)
      return null
    g.drawImage(v, 0, 0, sw, sh, 0, 0, w, h)
    // Throws for a stream whose server did not allow reading it.
    g.getImageData(0, 0, 1, 1)
    return { img: c, w, h }
  }

  interface Job { sec: number, maxWidth: number, kind: string, resolve: (p: Pic | null) => void }
  const queue: Job[] = []
  let running = false
  const state = { closed: false }

  async function pump() {
    if (running)
      return
    running = true
    try {
      while (queue.length && !state.closed) {
        const job = queue.shift()!
        try {
          await seek(v, Math.min(Math.max(0, job.sec), Math.max(0, v.duration - 0.05)))
          job.resolve(state.closed ? null : draw(job.maxWidth))
        }
        catch {
          job.resolve(null)
        }
      }
    }
    finally {
      running = false
    }
  }

  // The first frame proves the pixels can be read at all.
  try {
    await seek(v, Math.min(1, v.duration / 2))
    draw(16)
  }
  catch {
    close()
    return null
  }

  return {
    duration: v.duration,
    grab(sec, maxWidth = 1600, kind = '') {
      if (state.closed)
        return Promise.resolve(null)
      return new Promise((resolve) => {
        if (kind) {
          const i = queue.findIndex(j => j.kind === kind)
          if (i >= 0)
            queue.splice(i, 1)[0].resolve(null)
        }
        queue.push({ sec, maxWidth, kind, resolve })
        void pump()
      })
    },
    dispose() {
      state.closed = true
      for (const j of queue.splice(0))
        j.resolve(null)
      close()
    },
  }
}
