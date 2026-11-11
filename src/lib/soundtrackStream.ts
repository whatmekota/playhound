/**
 * Whole-track analysis of an MP4 / MOV / M4A soundtrack without ever holding
 * the file or its decoded audio in memory: the audio is decoded in pieces,
 * downmixed, resampled to the analysis rate and fed to the feature
 * extractor as it comes.
 *
 * The features are relative to the track's overall level, which is only
 * known at the end, so the track is decoded twice: once to measure the
 * level, once for the features. Decoding is the cheap part.
 *
 * Runs in the soundtrack worker.
 */

import type { SoundtrackAnalysis } from './beatTrack'
import type { ByteSource } from './mp4Audio'
import type { Resampler } from './resample'
import { analyseFeatures, createFeatureExtractor, createLevelMeter } from './beatTrack'
import { canDecode, decodeMp4Audio, readMp4AudioTrack } from './mp4Audio'
import { createResampler } from './resample'
import { ANALYSIS_RATE, MAX_STREAMED_SECONDS } from './soundtrackLimits'

export type StreamResult
  = | { kind: 'done', analysis: SoundtrackAnalysis }
    /** Not a file this can read in pieces: decode it whole instead. */
    | { kind: 'fallback' }
    | { kind: 'too-long' }
    | { kind: 'no-audio' }

/** Share of the progress bar for the first (level) pass; the features take the rest up to 0.85. */
const LEVEL_PASS = 0.3

export async function analyseMp4Soundtrack(
  src: ByteSource,
  opts: { maxSeconds?: number, onProgress?: (f: number) => void } = {},
): Promise<StreamResult> {
  const report = opts.onProgress ?? (() => {})
  const track = await readMp4AudioTrack(src)
  if (!track || !(await canDecode(track)))
    return { kind: 'fallback' }
  if (track.duration > (opts.maxSeconds ?? MAX_STREAMED_SECONDS))
    return { kind: 'too-long' }

  /** One decode of the track, resampled, into `sink`. */
  async function pass(sink: (x: Float32Array) => void, progress: (f: number) => void) {
    const conv: { rs: Resampler | null, rate: number } = { rs: null, rate: 0 }
    await decodeMp4Audio(src, track!, (mono, rate) => {
      if (!conv.rs) {
        conv.rate = rate
        conv.rs = createResampler(rate, ANALYSIS_RATE)
      }
      else if (rate !== conv.rate) {
        throw new Error(`The sample rate changed mid-track (${conv.rate} → ${rate})`)
      }
      sink(conv.rs.push(mono))
    }, progress)
    if (conv.rs)
      sink(conv.rs.flush())
  }

  const expectedSamples = Math.ceil((track.duration + Math.max(0, track.shift)) * ANALYSIS_RATE)
  const meter = createLevelMeter(ANALYSIS_RATE)
  try {
    await pass(x => meter.push(x), f => report(f * LEVEL_PASS))
  }
  catch (err) {
    // The decoder turned the track down after all: let the whole-file path try.
    console.warn('Decoding the soundtrack in pieces failed:', err)
    return { kind: 'fallback' }
  }
  if (!meter.length)
    return { kind: 'no-audio' }
  if (meter.length / ANALYSIS_RATE > (opts.maxSeconds ?? MAX_STREAMED_SECONDS))
    return { kind: 'too-long' }

  const rms = meter.rms()
  let analysis: SoundtrackAnalysis
  if (!(rms > 1e-5)) {
    // Silence: nothing to find, and no need to decode it again.
    analysis = analyseFeatures(null, meter.length / ANALYSIS_RATE)
  }
  else {
    const ex = createFeatureExtractor(ANALYSIS_RATE, rms, { expectedSamples })
    await pass(x => ex.push(x), f => report(LEVEL_PASS + f * (0.85 - LEVEL_PASS)))
    analysis = analyseFeatures(ex.finish(), ex.length / ANALYSIS_RATE, { onProgress: report })
  }
  report(1)
  return { kind: 'done', analysis }
}
