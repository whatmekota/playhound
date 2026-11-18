/**
 * The phone's stroke pad: a finger's height on the phone is the stroke's
 * position on the device. The phone sends `{ type: 'pad', pos }` while a
 * finger is down (again every few hundred ms if it rests, so silence means
 * the link went) and `{ type: 'pad', up: true }` when it lifts.
 */

/** No word from the finger for this long (a dropped link, a locked phone) lets go too. */
export const PAD_IDLE_MS = 1200

/** How often the phone repeats a finger that rests, well inside PAD_IDLE_MS. */
export const PAD_KEEPALIVE_MS = 350

/** Fastest the phone sends a moving finger. */
export const PAD_SEND_MS = 30

/** A pad message read safely: the finger's height (0 bottom, 1 top), 'up', or null for anything else. */
export function readPad(msg: unknown): number | 'up' | null {
  if (!msg || typeof msg !== 'object')
    return null
  const m = msg as Record<string, unknown>
  if (m.type !== 'pad')
    return null
  if (m.up === true)
    return 'up'
  const pos = Number(m.pos)
  return Number.isFinite(pos) ? Math.min(1, Math.max(0, pos)) : null
}

/** Where a finger at `clientY` sits on a pad spanning `top`…`top + height`: 1 at the top. */
export function padHeight(clientY: number, top: number, height: number): number {
  if (!(height > 0))
    return 0.5
  return Math.min(1, Math.max(0, 1 - (clientY - top) / height))
}
