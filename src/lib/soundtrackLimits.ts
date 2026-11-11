/** Shared by the main thread and the soundtrack worker; nothing heavy may be imported here. */

/** Plenty for beats and loudness, and a quarter of the memory of 44.1 kHz stereo. */
export const ANALYSIS_RATE = 22050
/**
 * Files above this are read in pieces (MP4 / MOV / M4A). Below it the whole
 * file is decoded at once: about twice as fast, and memory is no problem yet.
 */
export const STREAM_ABOVE_BYTES = 1024 ** 3
/** The longest soundtrack analysed in pieces (MP4 / MOV / M4A). */
export const MAX_STREAMED_SECONDS = 6 * 60 * 60
export const STREAMED_TOO_LONG = 'The soundtrack is over six hours long.'
