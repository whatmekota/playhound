/**
 * Getting a video's soundtrack analysed: decode, analyse in a worker, cache.
 *
 * MP4, MOV and M4A files are decoded in pieces in the worker (WebCodecs), so
 * their size does not matter and up to six hours of audio is fine. Anything
 * else goes through decodeAudioData, which needs the whole file in memory
 * (it takes one ArrayBuffer), so very large files are refused up front
 * rather than risking the renderer; the live analyser still works for those.
 */

import type { SoundtrackAnalysis } from './beatTrack'
import type { SoundtrackJob, SoundtrackReply } from '~/workers/soundtrack.worker'
import { isAndroidApp } from './android/detect'
import { NativeFile } from './android/nativeFile'
import { ANALYSIS_VERSION } from './beatTrack'
import { soundtrackDb } from './idb'
import { ANALYSIS_RATE, MAX_STREAMED_SECONDS, STREAMED_TOO_LONG } from './soundtrackLimits'

export { ANALYSIS_RATE, MAX_STREAMED_SECONDS }
/** Limits of the whole-file path. */
export const MAX_FILE_BYTES = 1.5 * 1024 ** 3
/**
 * On a phone the whole file in memory, plus its decoded audio, is enough to
 * get the WebView's renderer killed well before 1.5 GB.
 */
export const MAX_FILE_BYTES_ANDROID = 300 * 1024 ** 2
export const MAX_AUDIO_SECONDS = 60 * 60

export type SoundtrackFailure = 'too-big' | 'too-long' | 'no-audio' | 'unsupported' | 'failed'

export class SoundtrackError extends Error {
  constructor(public reason: SoundtrackFailure, message: string) {
    super(message)
  }
}

/** Human wording for a failure. */
export const FAILURE_TEXT: Record<SoundtrackFailure, string> = {
  'too-big': 'The file is too large to decode in one go.',
  'too-long': 'The soundtrack is over an hour long.',
  'no-audio': 'The video has no soundtrack this browser can decode.',
  'unsupported': 'This browser cannot decode audio offline.',
  'failed': 'The analysis failed.',
}

/** Cache key: the same file found again, even after a rescan. */
export function soundtrackKey(f: { name: string, size: number, lastModified: number }): string {
  return `${f.name}|${f.size}|${f.lastModified}`
}

/** Decode a video file's audio as mono at ANALYSIS_RATE. */
export async function decodeSoundtrack(file: File, opts: { durationHint?: number } = {}): Promise<{ samples: Float32Array<ArrayBuffer>, sampleRate: number }> {
  if (file.size > (isAndroidApp ? MAX_FILE_BYTES_ANDROID : MAX_FILE_BYTES))
    throw new SoundtrackError('too-big', FAILURE_TEXT['too-big'])
  if ((opts.durationHint ?? 0) > MAX_AUDIO_SECONDS)
    throw new SoundtrackError('too-long', FAILURE_TEXT['too-long'])

  const OAC: typeof OfflineAudioContext | undefined = (globalThis as any).OfflineAudioContext ?? (globalThis as any).webkitOfflineAudioContext
  if (!OAC)
    throw new SoundtrackError('unsupported', FAILURE_TEXT.unsupported)
  // The context only sets the rate decodeAudioData resamples to; it never renders.
  const ctx = new OAC(1, 1, ANALYSIS_RATE)

  let audio: AudioBuffer
  try {
    audio = await ctx.decodeAudioData(await file.arrayBuffer())
  }
  catch {
    // A video without an audio track (or with a codec the browser lacks)
    // lands here; there is nothing more specific to say.
    throw new SoundtrackError('no-audio', FAILURE_TEXT['no-audio'])
  }
  if (!audio.length)
    throw new SoundtrackError('no-audio', FAILURE_TEXT['no-audio'])
  if (audio.duration > MAX_AUDIO_SECONDS)
    throw new SoundtrackError('too-long', FAILURE_TEXT['too-long'])

  // A fresh buffer either way: the AudioBuffer's own channel data cannot be
  // transferred to the worker.
  const samples = new Float32Array(audio.length)
  const channels = audio.numberOfChannels
  for (let c = 0; c < channels; c++) {
    const data = audio.getChannelData(c)
    for (let i = 0; i < data.length; i++)
      samples[i] += data[i] / channels
  }
  return { samples, sampleRate: audio.sampleRate }
}

let jobSeq = 0

/** One job in a fresh worker; resolves with its last reply. */
function runJob(
  job: SoundtrackJob,
  transfer: Transferable[],
  onProgress?: (f: number) => void,
): Promise<Exclude<SoundtrackReply, { type: 'progress' }>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/soundtrack.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<SoundtrackReply>) => {
      const m = e.data
      if (m.id !== job.id)
        return
      if (m.type === 'progress') {
        onProgress?.(m.value)
        return
      }
      worker.terminate()
      resolve(m)
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new SoundtrackError('failed', e.message || FAILURE_TEXT.failed))
    }
    worker.postMessage(job, transfer)
  })
}

/** Run the beat analysis in a worker. The samples are transferred, not copied. */
export async function analyseInWorker(
  samples: Float32Array<ArrayBuffer>,
  sampleRate: number,
  onProgress?: (f: number) => void,
): Promise<SoundtrackAnalysis> {
  const m = await runJob({ id: ++jobSeq, kind: 'samples', samples, sampleRate }, [samples.buffer], onProgress)
  if (m.type === 'done')
    return m.analysis
  throw new SoundtrackError('failed', m.type === 'error' ? m.message : FAILURE_TEXT.failed)
}

/**
 * Decode and analyse a file in pieces, in a worker: never the whole file in
 * memory. Null when the file is not one it can read that way (not MP4 /
 * MOV / M4A, a codec or browser without WebCodecs support): decode it
 * whole with decodeSoundtrack instead.
 */
export async function analyseFileInWorker(file: File, onProgress?: (f: number) => void): Promise<SoundtrackAnalysis | null> {
  // A library file in the Android app streams from the media server; posted
  // to a worker it would arrive as an empty File. Decoded whole instead (up
  // to MAX_FILE_BYTES_ANDROID) until the worker can fetch it in ranges.
  if (typeof Worker === 'undefined' || file instanceof NativeFile)
    return null
  const m = await runJob({ id: ++jobSeq, kind: 'file', file, maxSeconds: MAX_STREAMED_SECONDS }, [], onProgress)
  switch (m.type) {
    case 'done':
      return m.analysis
    case 'fallback':
      return null
    default:
      if (m.reason === 'too-long')
        throw new SoundtrackError('too-long', STREAMED_TOO_LONG)
      if (m.reason === 'no-audio')
        throw new SoundtrackError('no-audio', FAILURE_TEXT['no-audio'])
      throw new SoundtrackError('failed', m.message || FAILURE_TEXT.failed)
  }
}

/** A cached analysis made by the current algorithm, if there is one. */
export async function cachedAnalysis(key: string): Promise<SoundtrackAnalysis | null> {
  try {
    const rec = await soundtrackDb.get(key)
    return rec && rec.v === ANALYSIS_VERSION ? (rec.analysis as SoundtrackAnalysis) : null
  }
  catch {
    return null
  }
}

export async function storeAnalysis(key: string, analysis: SoundtrackAnalysis): Promise<void> {
  try {
    await soundtrackDb.set(key, { v: ANALYSIS_VERSION, analysis, at: Date.now() })
  }
  catch {
    // A cache that cannot be written only costs a re-analysis next time.
  }
}
