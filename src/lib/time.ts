/**
 * Format a duration in seconds as m:ss, or h:mm:ss past an hour.
 *
 * Was duplicated in five places across the player; `fallback` covers the
 * loop-point case where a time may legitimately be unset.
 */
export function formatTime(s: number | null | undefined, fallback = '--:--'): string {
  if (s === null || s === undefined || !Number.isFinite(s))
    return fallback

  const total = Math.max(0, s)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = Math.floor(total % 60)

  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}
