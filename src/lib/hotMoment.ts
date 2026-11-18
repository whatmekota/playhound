/**
 * The hottest moment of a script: the middle of the stretch where it moves
 * the most. The library takes a scripted video's thumbnail there (lib/thumbs),
 * so a card shows the video at its liveliest rather than its opening.
 */

/** How long a stretch counts as one moment. */
export const HOT_WINDOW_MS = 20_000

/**
 * Script time (ms) in the middle of the busiest `windowMs`, by total travel;
 * a later stretch wins a tie. Null for a script too short or too still to
 * have one. Positions on any scale (0–1 or 0–100), sorted by time.
 */
export function hottestMoment(actions: readonly { at: number, pos: number }[], windowMs = HOT_WINDOW_MS): number | null {
  if (actions.length < 12)
    return null
  if (actions[actions.length - 1].at - actions[0].at < windowMs * 1.5)
    return null
  let best = 0
  let from = 0
  let to = 0
  let sum = 0
  // Segment i runs from action i-1 to action i; the window holds segments lo…hi.
  let lo = 1
  for (let hi = 1; hi < actions.length; hi++) {
    sum += Math.abs(actions[hi].pos - actions[hi - 1].pos)
    while (lo < hi && actions[hi].at - actions[lo - 1].at > windowMs) {
      sum -= Math.abs(actions[lo].pos - actions[lo - 1].pos)
      lo++
    }
    if (sum > 0 && sum >= best) {
      best = sum
      from = actions[lo - 1].at
      to = actions[hi].at
    }
  }
  return best > 0 ? Math.round((from + to) / 2) : null
}
