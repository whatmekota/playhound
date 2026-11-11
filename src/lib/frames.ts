/**
 * requestAnimationFrame that keeps running while the pop-out player is the
 * only thing on screen.
 *
 * A window's frames stop when it is hidden: a minimised desktop window, a
 * browser tab behind another app. With the video popped out, that is exactly
 * when the main window is out of sight, yet the device loops (script sync, the
 * motion generator, the edge envelope) still have to run. So while a pop-out is
 * open, each frame is asked of both windows and runs on whichever paints first.
 *
 * Callbacks get the main window's performance.now(), not the frame timestamp:
 * the two windows' clocks start at different times, and a loop must never see
 * them mixed.
 */

let extra: Window | null = null
let seq = 0
const pending = new Map<number, [Window, number][]>()

/**
 * In the Android app, with the screen off or another app in front while a
 * session runs, the page is kept running (its timers at full speed) but
 * paints no frames. Then each frame is also asked of a timer, every
 * `timerMs`, and runs on whichever comes first. Null (always, except there)
 * is frames alone.
 */
let timerMs: number | null = null
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export function setFrameTimer(ms: number | null) {
  timerMs = ms
}

/** The pop-out window, or null once it closes. */
export function setFrameSource(w: Window | null) {
  extra = w
}

export function requestFrame(cb: (now: number) => void): number {
  const id = ++seq
  const fire = () => {
    const reqs = pending.get(id)
    if (!reqs)
      return
    pending.delete(id)
    for (const [w, h] of reqs) {
      try {
        w.cancelAnimationFrame(h)
      }
      catch {}
    }
    clearTimer(id)
    cb(performance.now())
  }
  const reqs: [Window, number][] = [[window, window.requestAnimationFrame(fire)]]
  if (extra && !extra.closed) {
    try {
      reqs.push([extra, extra.requestAnimationFrame(fire)])
    }
    catch {}
  }
  pending.set(id, reqs)
  if (timerMs !== null)
    timers.set(id, setTimeout(fire, timerMs))
  return id
}

function clearTimer(id: number) {
  const t = timers.get(id)
  if (t !== undefined) {
    clearTimeout(t)
    timers.delete(id)
  }
}

export function cancelFrame(id: number | null | undefined) {
  if (id == null)
    return
  const reqs = pending.get(id)
  if (!reqs)
    return
  pending.delete(id)
  clearTimer(id)
  for (const [w, h] of reqs) {
    try {
      w.cancelAnimationFrame(h)
    }
    catch {}
  }
}
