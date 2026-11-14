/**
 * Where on its time axis a live trace plots what was last sent to an axis.
 *
 * The trace reads the output on its own animation frame, but the output was
 * worked out by a device loop at some other moment: usually a frame earlier,
 * now and then two or three (the page missed frames while a video started
 * decoding), or just now, off the loop's timer. Plotted at the time it was
 * read, a value that is 25 ms old instead of the usual 7 puts a flat step and
 * then a steeper bit into a stroke the device was sent perfectly straight.
 * Plotted at the time it was worked out, the stroke is drawn as it was sent.
 *
 * Times are performance.now() ms.
 */

/** An output this old is not about to be replaced: nothing is moving the axis, and the trace runs flat. */
export const TRACE_IDLE_MS = 100

/**
 * The time to plot the output at, or null for nothing to plot this frame.
 * `stamp` is when the output was worked out (undefined: never, the value is
 * a stand-in), `plotted` the stamp of the last one plotted, `now` the frame.
 */
export function traceSampleTime(stamp: number | undefined, plotted: number | undefined, now: number): number | null {
  if (stamp === undefined)
    return now
  if (stamp !== plotted)
    return stamp
  // Read before: between two outputs the line simply runs from one to the
  // next. Only an axis left alone is drawn on, flat, up to now.
  return now - stamp < TRACE_IDLE_MS ? null : now
}
