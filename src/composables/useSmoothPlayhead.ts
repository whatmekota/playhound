import { onScopeDispose, watch } from 'vue'
import { usePlayerStore } from '~/stores/playerStore'

/**
 * Calls `draw(t)` once per animation frame while the video plays, with the
 * playback position extrapolated between `timeupdate` events.
 *
 * The media element only reports its time about four times a second, so a
 * progress bar bound to the store steps visibly. Re-rendering a component at
 * 60 Hz to smooth it would be worse, so callers write straight to the DOM (a
 * CSS variable, a canvas) from `draw` instead.
 *
 * While paused it calls `draw` only when the time actually changes.
 */
export function useSmoothPlayhead(draw: (t: number) => void) {
  const player = usePlayerStore()

  let base = player.currentTime
  let baseAt = performance.now()
  let raf = 0

  function now() {
    if (!player.isPlaying)
      return base
    // Never run more than half a second ahead of the last real report, so a
    // stall (buffering, a dropped event) cannot carry the bar off on its own.
    const ahead = Math.min(0.5, (performance.now() - baseAt) / 1000) * player.playbackSpeed
    const end = player.videoDuration > 0 ? player.videoDuration : Number.POSITIVE_INFINITY
    return Math.min(end, base + ahead)
  }

  function frame() {
    draw(now())
    raf = requestAnimationFrame(frame)
  }

  function sync() {
    cancelAnimationFrame(raf)
    raf = 0
    if (player.isPlaying)
      raf = requestAnimationFrame(frame)
    else
      draw(base)
  }

  watch(() => player.currentTime, (t) => {
    base = t
    baseAt = performance.now()
    if (!player.isPlaying)
      draw(t)
  })
  watch(() => [player.isPlaying, player.videoDuration], () => {
    baseAt = performance.now()
    sync()
  })

  sync()
  onScopeDispose(() => cancelAnimationFrame(raf))

  /** Redraw now, e.g. after the element it draws into was resized. */
  return { redraw: () => draw(now()) }
}
