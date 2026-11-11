/**
 * Beat analysis off the main thread: a five-minute track is a few hundred ms
 * of solid number crunching, and an hour-long one is seconds — too long to
 * hold up the player.
 *
 * Two kinds of job: decoded samples (the whole-file path), or the file
 * itself, decoded here in pieces when it is an MP4 / MOV / M4A this browser
 * can decode. A file it cannot read that way comes back as `fallback`.
 */
import type { SoundtrackAnalysis } from '~/lib/beatTrack'
import { analyseBeats } from '~/lib/beatTrack'
import { blobSource } from '~/lib/mp4Audio'
import { analyseMp4Soundtrack } from '~/lib/soundtrackStream'

export type SoundtrackJob
  = | { id: number, kind: 'samples', samples: Float32Array, sampleRate: number }
    | { id: number, kind: 'file', file: Blob, maxSeconds: number }

export type SoundtrackReply
  = | { id: number, type: 'progress', value: number }
    | { id: number, type: 'done', analysis: SoundtrackAnalysis }
    | { id: number, type: 'fallback' }
    | { id: number, type: 'error', message: string, reason?: 'too-long' | 'no-audio' }

const ctx = globalThis as unknown as Worker

ctx.onmessage = async (e: MessageEvent<SoundtrackJob>) => {
  const job = e.data
  const { id } = job
  const post = (m: SoundtrackReply) => ctx.postMessage(m)
  let last = 0
  const onProgress = (f: number) => {
    if (f - last >= 0.01 || f >= 1) {
      last = f
      post({ id, type: 'progress', value: f })
    }
  }
  try {
    if (job.kind === 'samples') {
      post({ id, type: 'done', analysis: analyseBeats(job.samples, job.sampleRate, { onProgress }) })
      return
    }
    const r = await analyseMp4Soundtrack(blobSource(job.file), { maxSeconds: job.maxSeconds, onProgress })
    if (r.kind === 'done')
      post({ id, type: 'done', analysis: r.analysis })
    else if (r.kind === 'fallback')
      post({ id, type: 'fallback' })
    else
      post({ id, type: 'error', reason: r.kind, message: r.kind })
  }
  catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
