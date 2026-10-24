/**
 * Getting a video's soundtrack analysed: decode, analyse in a worker, cache.
 *
 * Decoding needs the whole file in memory (decodeAudioData takes one
 * ArrayBuffer), so very large files are refused up front rather than risking
 * the renderer; the live analyser still works for those.
 */

import type { SoundtrackAnalysis } from './beatTrack'
import type { SoundtrackJob, SoundtrackReply } from '~/workers/soundtrack.worker'
import { ANALYSIS_VERSION } from './beatTrack'
import { soundtrackDb } from './idb'

/** Plenty for beats and loudness, and a quarter of the memory of 44.1 kHz stereo. */
export const ANALYSIS_RATE = 22050
export const MAX_FILE_BYTES = 1.5 * 1024 ** 3
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
  if (file.size > MAX_FILE_BYTES)
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

/** Run the beat analysis in a worker. The samples are transferred, not copied. */
export function analyseInWorker(
  samples: Float32Array<ArrayBuffer>,
  sampleRate: number,
  onProgress?: (f: number) => void,
): Promise<SoundtrackAnalysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/soundtrack.worker.ts', import.meta.url), { type: 'module' })
    const id = ++jobSeq
    worker.onmessage = (e: MessageEvent<SoundtrackReply>) => {
      const m = e.data
      if (m.id !== id)
        return
      if (m.type === 'progress') {
        onProgress?.(m.value)
        return
      }
      worker.terminate()
      if (m.type === 'done')
        resolve(m.analysis)
      else
        reject(new SoundtrackError('failed', m.message))
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new SoundtrackError('failed', e.message || FAILURE_TEXT.failed))
    }
    const job: SoundtrackJob = { id, samples, sampleRate }
    worker.postMessage(job, [samples.buffer])
  })
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
