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
  return id
}

export function cancelFrame(id: number | null | undefined) {
  if (id == null)
    return
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
}
