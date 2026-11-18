/**
 * Whether a media element has a sound track: true or false once the browser
 * can tell, null before. Firefox says so outright (mozHasAudio). Chromium
 * only counts the sound it has decoded, and it decodes the sound along with
 * the picture: a video that has played a second, or decoded a fair way of
 * picture, with not a byte of sound has none. Safari lists its tracks.
 */

/** Picture decoded with no sound by then: the video has none (a few seconds of even a small video). */
export const SILENT_AFTER_BYTES = 300_000
/** Played this long, picture decoded and still no sound: none. */
export const SILENT_AFTER_SEC = 1

interface MediaCounters {
  mozHasAudio?: boolean
  webkitAudioDecodedByteCount?: number
  webkitVideoDecodedByteCount?: number
  audioTracks?: { length: number }
}

/** Seconds the element has actually played, from its played ranges. */
export function playedSeconds(el: Pick<HTMLMediaElement, 'played'>): number {
  const r = el.played
  if (!r)
    return 0
  let s = 0
  for (let i = 0; i < r.length; i++)
    s += r.end(i) - r.start(i)
  return s
}

export function soundTrackOf(el: HTMLMediaElement): boolean | null {
  const m = el as HTMLMediaElement & MediaCounters
  if (typeof m.mozHasAudio === 'boolean')
    return m.mozHasAudio
  if (typeof m.webkitAudioDecodedByteCount === 'number') {
    if (m.webkitAudioDecodedByteCount > 0)
      return true
    const picture = m.webkitVideoDecodedByteCount ?? 0
    if (picture > SILENT_AFTER_BYTES || (picture > 0 && playedSeconds(m) >= SILENT_AFTER_SEC))
      return false
    return null
  }
  if (m.audioTracks && typeof m.audioTracks.length === 'number')
    return m.audioTracks.length > 0
  return null
}
