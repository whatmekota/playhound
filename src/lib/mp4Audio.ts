/**
 * The audio track of an MP4 / MOV / M4A file, read and decoded in pieces.
 *
 * Only the box headers, the `moov` (the index) and the audio samples
 * themselves are read, with File.slice(), so a file of any size costs a few
 * megabytes at a time. mp4box.js parses the index; WebCodecs' AudioDecoder
 * does the decoding.
 *
 * Fragmented files (moof boxes) are not handled: the caller falls back to
 * decoding the whole file.
 */

import { createFile, MP4BoxBuffer } from 'mp4box'

export interface ByteSource {
  readonly size: number
  read: (start: number, end: number) => Promise<Uint8Array>
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  }
}

export interface TopBox {
  type: string
  start: number
  size: number
}

/** Boxes an ISO BMFF or QuickTime file can open with. */
const FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid'])
const MAX_MOOV_BYTES = 256 * 1024 ** 2

function fourcc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
}

/**
 * The top-level boxes, from their headers alone. Null when the file is not
 * an MP4 or QuickTime file. Stops at the first `moof`: a fragmented file.
 */
export async function topLevelBoxes(src: ByteSource): Promise<TopBox[] | null> {
  const out: TopBox[] = []
  let pos = 0
  while (pos + 8 <= src.size && out.length < 10000) {
    const h = await src.read(pos, Math.min(src.size, pos + 16))
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
    let size = dv.getUint32(0)
    const type = fourcc(h, 4)
    if (!/^[\x20-\x7E]{4}$/.test(type) || (!out.length && !FIRST_BOXES.has(type)))
      return out.length ? out : null
    if (size === 1) {
      if (h.length < 16)
        break
      size = dv.getUint32(8) * 2 ** 32 + dv.getUint32(12)
    }
    else if (size === 0) {
      size = src.size - pos
    }
    if (size < 8)
      return out.length ? out : null
    out.push({ type, start: pos, size })
    if (type === 'moof')
      break
    pos += size
  }
  return out.length ? out : null
}

export interface Mp4AudioTrack {
  /** A WebCodecs codec string. */
  codec: string
  description?: Uint8Array
  sampleRate: number
  channels: number
  /** Media timescale: ticks per second. */
  timescale: number
  /** Seconds. */
  duration: number
  /**
   * Seconds: where media time 0 lands on the presentation timeline, from the
   * edit list. Negative for leading samples to skip (encoder priming).
   */
  shift: number
  offsets: Float64Array
  sizes: Uint32Array
  /** Decode time of each sample, in timescale ticks. */
  dts: Float64Array
}

/** Sample offsets, sizes and times from the sample table boxes. */
export function buildSampleTable(t: {
  sizes: ArrayLike<number>
  chunkOffsets: ArrayLike<number>
  firstChunk: ArrayLike<number>
  samplesPerChunk: ArrayLike<number>
  sttsCounts: ArrayLike<number>
  sttsDeltas: ArrayLike<number>
}): { offsets: Float64Array, sizes: Uint32Array, dts: Float64Array } {
  const n = t.sizes.length
  const offsets = new Float64Array(n)
  const sizes = Uint32Array.from(t.sizes)
  const dts = new Float64Array(n)
  let s = 0
  for (let run = 0; run < t.firstChunk.length && s < n; run++) {
    const per = t.samplesPerChunk[run]
    const from = t.firstChunk[run] - 1
    const to = run + 1 < t.firstChunk.length ? t.firstChunk[run + 1] - 1 : t.chunkOffsets.length
    for (let c = from; c < to && s < n; c++) {
      let off = t.chunkOffsets[c]
      for (let k = 0; k < per && s < n; k++, s++) {
        offsets[s] = off
        off += sizes[s]
      }
    }
  }
  let time = 0
  let j = 0
  for (let run = 0; run < t.sttsCounts.length && j < n; run++) {
    for (let k = 0; k < t.sttsCounts[run] && j < n; k++, j++) {
      dts[j] = time
      time += t.sttsDeltas[run]
    }
  }
  for (; j < n; j++)
    dts[j] = time
  return { offsets, sizes, dts }
}

/** Edit list → where media time 0 plays, seconds. Only leading edits matter here. */
export function editShift(
  entries: { segment_duration: number, media_time: number }[] | undefined,
  movieTimescale: number,
  mediaTimescale: number,
): number {
  let shift = 0
  for (const e of entries ?? []) {
    if (e.media_time === -1 || e.media_time === 0xFFFFFFFF) {
      shift += e.segment_duration / movieTimescale
      continue
    }
    shift -= e.media_time / mediaTimescale
    break
  }
  return shift
}

/** Group samples into reads: neighbours a small gap apart, a megabyte at most. */
export function planReads(offsets: Float64Array, sizes: Uint32Array, opts: { maxGap?: number, maxBytes?: number } = {}): number[] {
  const maxGap = opts.maxGap ?? 64 * 1024
  const maxBytes = opts.maxBytes ?? 1024 ** 2
  const starts: number[] = []
  let begin = 0
  let end = 0
  for (let i = 0; i < offsets.length; i++) {
    const a = offsets[i]
    const b = a + sizes[i]
    if (i === 0 || a < end || a - end > maxGap || b - begin > maxBytes) {
      starts.push(i)
      begin = a
    }
    end = b
  }
  starts.push(offsets.length)
  return starts
}

const AAC_OTI = new Set([0x40, 0x66, 0x67, 0x68])
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

/**
 * Sample rate and channel count from an AAC AudioSpecificConfig, which is
 * what the decoder goes by; the sample entry's fields are often placeholders.
 */
export function aacConfig(asc: Uint8Array): { sampleRate?: number, channels?: number } {
  let bit = 0
  const read = (n: number) => {
    let v = 0
    for (let i = 0; i < n; i++, bit++)
      v = (v << 1) | ((asc[bit >> 3] >> (7 - (bit & 7))) & 1)
    return v
  }
  if (asc.length < 2)
    return {}
  if (read(5) === 31)
    read(6)
  const fi = read(4)
  const sampleRate = fi === 15 ? read(24) : AAC_RATES[fi]
  const cc = read(4)
  return { sampleRate, channels: cc === 7 ? 8 : cc >= 1 && cc <= 6 ? cc : undefined }
}
const MP3_OTI = new Set([0x69, 0x6B])

/** The codec string and description WebCodecs wants for a sample entry, or null. */
function codecOf(entry: any): { codec: string, description?: Uint8Array } | null {
  const type: string = entry?.type ?? ''
  if (type === 'mp4a') {
    const esd = (entry.esds ?? entry.wave?.esds)?.esd
    if (!esd)
      return null
    const oti = esd.getOTI?.() ?? 0
    if (MP3_OTI.has(oti))
      return { codec: 'mp3' }
    if (!AAC_OTI.has(oti))
      return null
    const dsi = esd.findDescriptor?.(4)?.findDescriptor?.(5)?.data as Uint8Array | undefined
    if (!dsi?.length)
      return null
    const aot = esd.getAudioConfig?.() ?? 2
    return { codec: `mp4a.40.${aot}`, description: new Uint8Array(dsi) }
  }
  if (type === '.mp3')
    return { codec: 'mp3' }
  if (type === 'Opus')
    return { codec: 'opus' }
  return null
}

/** The first enabled audio track in a movie's index, or null. */
export function parseMoov(bytes: Uint8Array): Mp4AudioTrack | null {
  const file = createFile() as any
  const copy = bytes.slice()
  file.checkBuffer(MP4BoxBuffer.fromArrayBuffer(copy.buffer, 0))
  file.parse()
  const moov = file.moov
  if (!moov || moov.mvex)
    return null
  const traks: any[] = moov.traks ?? []
  const audio = traks.filter(t => t.mdia?.hdlr?.handler === 'soun' && t.mdia?.minf?.stbl?.stsd?.entries?.length)
  const trak = audio.find(t => (t.tkhd?.flags ?? 1) & 1) ?? audio[0]
  if (!trak)
    return null
  const stbl = trak.mdia.minf.stbl
  const entry = stbl.stsd.entries[0]
  const codec = codecOf(entry)
  const stco = stbl.stco ?? stbl.co64
  const stsz = stbl.stsz
  if (!codec || !stco || !stsz || !stbl.stsc || !stbl.stts)
    return null
  // A movie whose samples use more than one description would need a decoder each.
  if ((stbl.stsc.sample_description_index as number[]).some(i => i !== 1))
    return null
  const table = buildSampleTable({
    sizes: stsz.sample_sizes,
    chunkOffsets: stco.chunk_offsets,
    firstChunk: stbl.stsc.first_chunk,
    samplesPerChunk: stbl.stsc.samples_per_chunk,
    sttsCounts: stbl.stts.sample_counts,
    sttsDeltas: stbl.stts.sample_deltas,
  })
  if (!table.sizes.length)
    return null
  const timescale: number = trak.mdia.mdhd.timescale
  const last = table.dts.length - 1
  const sampled = table.dts[last] + (stbl.stts.sample_deltas.at(-1) ?? 0)
  const asc = codec.codec.startsWith('mp4a.') && codec.description ? aacConfig(codec.description) : {}
  return {
    ...codec,
    sampleRate: asc.sampleRate ?? Math.round(entry.getSampleRate?.() ?? entry.samplerate ?? 0),
    channels: asc.channels ?? entry.getChannelCount?.() ?? entry.channel_count ?? 2,
    timescale,
    duration: Math.max(trak.mdia.mdhd.duration, sampled) / timescale,
    shift: editShift(trak.edts?.elst?.entries, moov.mvhd?.timescale ?? timescale, timescale),
    ...table,
  }
}

/** The audio track of an MP4 / MOV / M4A file, or null when it has none this can read. */
export async function readMp4AudioTrack(src: ByteSource): Promise<Mp4AudioTrack | null> {
  const boxes = await topLevelBoxes(src)
  if (!boxes || boxes.some(b => b.type === 'moof'))
    return null
  const moov = boxes.find(b => b.type === 'moov')
  if (!moov || moov.size > MAX_MOOV_BYTES)
    return null
  // ftyp too: the sample entries parse differently in QuickTime files.
  const ftyp = boxes.find(b => b.type === 'ftyp' && b.size < 4096)
  const head = ftyp ? await src.read(ftyp.start, ftyp.start + ftyp.size) : new Uint8Array(0)
  const body = await src.read(moov.start, moov.start + moov.size)
  if (body.length < moov.size)
    return null
  const bytes = new Uint8Array(head.length + body.length)
  bytes.set(head)
  bytes.set(body, head.length)
  try {
    return parseMoov(bytes)
  }
  catch {
    return null
  }
}

export function decoderConfig(track: Mp4AudioTrack): AudioDecoderConfig {
  return {
    codec: track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
    ...(track.description ? { description: track.description } : {}),
  }
}

/** Whether this browser can decode the track in pieces. */
export async function canDecode(track: Mp4AudioTrack): Promise<boolean> {
  if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined')
    return false
  try {
    return !!(await AudioDecoder.isConfigSupported(decoderConfig(track))).supported
  }
  catch {
    return false
  }
}

/** Decoded samples waiting at most; more and reading pauses. */
const MAX_QUEUE = 48

/**
 * Decode the whole track in order, as mono at the decoder's own rate.
 * `onAudio` gets each piece, already lined up with the edit list (priming
 * dropped, a delayed start padded with silence); `onProgress` gets 0–1.
 * Resolves with the number of output frames that came out.
 */
export async function decodeMp4Audio(
  src: ByteSource,
  track: Mp4AudioTrack,
  onAudio: (mono: Float32Array, sampleRate: number) => void,
  onProgress?: (f: number) => void,
): Promise<number> {
  let failure: unknown = null
  let skip = -1
  let produced = 0
  let plane = new Float32Array(0)

  const decoder = new AudioDecoder({
    output(data) {
      try {
        if (failure)
          return
        const rate = data.sampleRate
        const frames = data.numberOfFrames
        const channels = data.numberOfChannels
        if (skip < 0) {
          // The first output fixes the rate the edit list is applied at.
          skip = Math.max(0, Math.round(-track.shift * rate))
          const pad = Math.round(track.shift * rate)
          if (pad > 0) {
            onAudio(new Float32Array(pad), rate)
            produced += pad
          }
        }
        const mono = new Float32Array(frames)
        if (plane.length < frames)
          plane = new Float32Array(frames)
        for (let c = 0; c < channels; c++) {
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
          for (let i = 0; i < frames; i++)
            mono[i] += plane[i] / channels
        }
        let piece = mono
        if (skip > 0) {
          const k = Math.min(skip, frames)
          skip -= k
          piece = mono.subarray(k)
        }
        if (piece.length) {
          onAudio(piece, rate)
          produced += piece.length
        }
      }
      catch (err) {
        failure = err
      }
      finally {
        data.close()
      }
    },
    error(err) {
      failure = err
    },
  })

  try {
    decoder.configure(decoderConfig(track))
    const groups = planReads(track.offsets, track.sizes)
    const read = (g: number) => src.read(track.offsets[groups[g]], track.offsets[groups[g + 1] - 1] + track.sizes[groups[g + 1] - 1])
    let next = groups.length > 1 ? read(0) : null
    const µs = 1e6 / track.timescale
    for (let g = 0; g + 1 < groups.length; g++) {
      const bytes = await next!
      // Read ahead while this group decodes.
      next = g + 2 < groups.length ? read(g + 1) : null
      const base = track.offsets[groups[g]]
      for (let s = groups[g]; s < groups[g + 1]; s++) {
        if (failure)
          throw failure
        const at = track.offsets[s] - base
        decoder.decode(new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round(track.dts[s] * µs),
          data: bytes.subarray(at, at + track.sizes[s]),
        }))
        // A decoder error closes it, which empties the queue too.
        while (decoder.decodeQueueSize > MAX_QUEUE && decoder.state === 'configured')
          await dequeued(decoder)
      }
      onProgress?.(groups[g + 1] / track.sizes.length)
    }
    await decoder.flush()
    if (failure)
      throw failure
    return produced
  }
  finally {
    if (decoder.state !== 'closed')
      decoder.close()
  }
}

function dequeued(decoder: AudioDecoder): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, 50)
    function done() {
      clearTimeout(timer)
      decoder.removeEventListener('dequeue', done)
      resolve()
    }
    decoder.addEventListener('dequeue', done)
  })
}
