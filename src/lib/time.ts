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

/** A span of ms in words for stats: `<1m`, `42m`, `1h 05m` → `1h 5m`. */
export function formatDuration(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 1)
    return ms > 0 ? '<1m' : '0m'
  const h = Math.floor(m / 60)
  return h ? `${h}h ${m % 60}m` : `${m}m`
}

/** The local calendar day of a timestamp, `YYYY-MM-DD`. */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
