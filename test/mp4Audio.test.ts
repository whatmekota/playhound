import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildSampleTable, editShift, planReads, readMp4AudioTrack, topLevelBoxes } from '../src/lib/mp4Audio'
import { createResampler } from '../src/lib/resample'

function memorySource(bytes: Uint8Array) {
  return { size: bytes.length, read: async (a: number, b: number) => bytes.slice(a, b) }
}

// 0.3 s of a 440 Hz tone, AAC mono at 22.05 kHz, moov after mdat (ffmpeg's default).
const TINY = new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tiny.m4a')))

describe('mp4Audio', () => {
  it('walks the top-level boxes from their headers', async () => {
    const boxes = (await topLevelBoxes(memorySource(TINY)))!
    expect(boxes.map(b => b.type)).toEqual(['ftyp', 'free', 'mdat', 'moov'])
    expect(boxes.at(-1)!.start + boxes.at(-1)!.size).toBe(TINY.length)
  })

  it('refuses what is not an MP4', async () => {
    const webm = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 0x01, 0x42, 0xF7, 0x81])
    expect(await topLevelBoxes(memorySource(webm))).toBeNull()
    expect(await readMp4AudioTrack(memorySource(webm))).toBeNull()
  })

  it('reads the audio track and its sample table', async () => {
    const t = (await readMp4AudioTrack(memorySource(TINY)))!
    expect(t.codec).toBe('mp4a.40.2')
    expect(t.description?.length).toBeGreaterThan(0)
    expect(t.sampleRate).toBe(22050)
    expect(t.channels).toBe(1)
    expect(t.duration).toBeGreaterThan(0.28)
    expect(t.duration).toBeLessThan(0.4)
    // ffmpeg's priming: 1024 samples skipped by the edit list.
    expect(t.shift).toBeCloseTo(-1024 / 22050, 6)
    const mdat = (await topLevelBoxes(memorySource(TINY)))!.find(b => b.type === 'mdat')!
    for (let i = 0; i < t.sizes.length; i++) {
      expect(t.offsets[i]).toBeGreaterThanOrEqual(mdat.start + 8)
      expect(t.offsets[i] + t.sizes[i]).toBeLessThanOrEqual(mdat.start + mdat.size)
      if (i > 0)
        expect(t.dts[i] - t.dts[i - 1]).toBe(1024)
    }
  })

  it('builds offsets and times from chunks', () => {
    const t = buildSampleTable({
      sizes: [10, 20, 30, 40, 50],
      chunkOffsets: [100, 500, 900],
      firstChunk: [1, 3],
      samplesPerChunk: [2, 1],
      sttsCounts: [3, 2],
      sttsDeltas: [1024, 512],
    })
    expect(Array.from(t.offsets)).toEqual([100, 110, 500, 530, 900])
    expect(Array.from(t.dts)).toEqual([0, 1024, 2048, 3072, 3584])
  })

  it('applies empty edits and priming from the edit list', () => {
    expect(editShift(undefined, 1000, 48000)).toBe(0)
    expect(editShift([{ segment_duration: 5000, media_time: 2112 }], 1000, 48000)).toBeCloseTo(-0.044)
    expect(editShift([{ segment_duration: 500, media_time: -1 }, { segment_duration: 5000, media_time: 0 }], 1000, 48000)).toBe(0.5)
  })

  it('groups neighbouring samples into reads', () => {
    const offsets = Float64Array.from([0, 100, 200, 100000, 100100, 100200])
    const sizes = Uint32Array.from([100, 100, 100, 100, 100, 100])
    expect(planReads(offsets, sizes)).toEqual([0, 3, 6])
    expect(planReads(offsets, sizes, { maxGap: 1e6, maxBytes: 250 })).toEqual([0, 2, 3, 5, 6])
  })
})

describe('createResampler', () => {
  function tone(rate: number, hz: number, seconds: number) {
    return Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate))
  }

  for (const rate of [44100, 48000, 32000, 16000]) {
    it(`converts ${rate} Hz to 22.05 kHz, keeping a tone's level and pitch`, () => {
      const out = createResampler(rate, 22050)
      const x = tone(rate, 1000, 1)
      const y = Float32Array.from([...out.push(x), ...out.flush()])
      expect(y.length).toBe(Math.ceil((x.length * 22050) / rate))
      // Against the ideal tone, away from the ends.
      let err = 0
      for (let i = 1000; i < y.length - 1000; i++)
        err = Math.max(err, Math.abs(y[i] - Math.sin((2 * Math.PI * 1000 * i) / 22050)))
      expect(err).toBeLessThan(0.01)
    })
  }

  it('removes what would alias', () => {
    const out = createResampler(48000, 22050)
    const y = out.push(tone(48000, 14000, 1))
    let peak = 0
    for (let i = 500; i < y.length - 500; i++)
      peak = Math.max(peak, Math.abs(y[i]))
    expect(peak).toBeLessThan(0.002)
  })

  it('gives the same output however the input is split', () => {
    const x = tone(48000, 523, 0.5).map((v, i) => v * (1 + Math.sin(i / 300)))
    const whole = createResampler(48000, 22050)
    const a = Float32Array.from([...whole.push(x), ...whole.flush()])
    for (const piece of [1, 37, 1024, 5000]) {
      const r = createResampler(48000, 22050)
      const parts: number[] = []
      for (let i = 0; i < x.length; i += piece)
        parts.push(...r.push(x.subarray(i, i + piece)))
      parts.push(...r.flush())
      expect(Float32Array.from(parts)).toEqual(a)
    }
  })
})
