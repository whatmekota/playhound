/**
 * Beat analysis off the main thread: a five-minute track is a few hundred ms
 * of solid number crunching, and an hour-long one is seconds — too long to
 * hold up the player.
 */
import type { SoundtrackAnalysis } from '~/lib/beatTrack'
import { analyseBeats } from '~/lib/beatTrack'

export interface SoundtrackJob {
  id: number
  samples: Float32Array
  sampleRate: number
}

export type SoundtrackReply
  = | { id: number, type: 'progress', value: number }
    | { id: number, type: 'done', analysis: SoundtrackAnalysis }
    | { id: number, type: 'error', message: string }

const ctx = globalThis as unknown as Worker

ctx.onmessage = (e: MessageEvent<SoundtrackJob>) => {
  const { id, samples, sampleRate } = e.data
  const post = (m: SoundtrackReply) => ctx.postMessage(m)
  try {
    let last = 0
    const analysis = analyseBeats(samples, sampleRate, {
      onProgress: (f) => {
        if (f - last >= 0.02 || f >= 1) {
          last = f
          post({ id, type: 'progress', value: f })
        }
      },
    })
    post({ id, type: 'done', analysis })
  }
  catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
