/**
 * Whether a media element has a sound track: true or false once the browser
 * can tell, null before. Firefox says so outright (mozHasAudio). Chromium
 * only counts the sound it has decoded, so a video whose picture has decoded
 * a fair way with not a byte of sound has none. Safari lists its tracks.
 */

/** Picture decoded with no sound by then: the video has none (a few seconds of even a small video). */
export const SILENT_AFTER_BYTES = 300_000

interface MediaCounters {
  mozHasAudio?: boolean
  webkitAudioDecodedByteCount?: number
  webkitVideoDecodedByteCount?: number
  audioTracks?: { length: number }
}

export function soundTrackOf(el: HTMLMediaElement): boolean | null {
  const m = el as HTMLMediaElement & MediaCounters
  if (typeof m.mozHasAudio === 'boolean')
    return m.mozHasAudio
  if (typeof m.webkitAudioDecodedByteCount === 'number') {
    if (m.webkitAudioDecodedByteCount > 0)
      return true
    return (m.webkitVideoDecodedByteCount ?? 0) > SILENT_AFTER_BYTES ? false : null
  }
  if (m.audioTracks && typeof m.audioTracks.length === 'number')
    return m.audioTracks.length > 0
  return null
}
