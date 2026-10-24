/**
 * Whole-track beat analysis of a soundtrack.
 *
 * The live analyser in useVideoBeat hears the music as it plays: no look-ahead,
 * a few bars to settle, and every seek starts it over. With the whole track in
 * hand all of that goes away — the tempo comes from minutes of music instead
 * of seconds, and every beat is placed knowing the ones after it.
 *
 * The method is the standard one (Ellis 2007, as librosa and @audio/beat do it):
 *
 * 1. an onset strength envelope at ~100 frames/s, from positive spectral flux
 *    of log-compressed band magnitudes
 * 2. a global tempo by autocorrelation of that envelope, weighted toward
 *    ~120 bpm, then a local tempo per window so a tempo change is followed
 * 3. beats by dynamic programming: the chain of frames that collects the most
 *    onset strength while keeping its spacing close to the tempo
 *
 * On top of that it measures what the motion generator wants per beat — how
 * loud, how bright (spectral centroid, a cheap stand-in for pitch), which beat
 * of the bar — and marks long stretches with no rhythm, so a generator can
 * rest there instead of stroking through a breakdown.
 *
 * Pure and DOM-free: it runs in a worker and in tests.
 */

/** Bump when the algorithm changes so cached analyses are redone. */
export const ANALYSIS_VERSION = 1

export interface SoundtrackGap {
  /** Seconds. */
  start: number
  end: number
}

export interface SoundtrackAnalysis {
  version: number
  /** Seconds of audio analysed. */
  duration: number
  /** The track's prevailing tempo. */
  bpm: number
  /** Beat times, seconds, ascending. */
  beats: number[]
  /** Loudness of each beat (the span to the next one), dBFS. */
  energy: number[]
  /** Spectral centroid of each beat, log2 Hz: higher is brighter. */
  centroid: number[]
  /** Onset strength at each beat; 1 is the track's median beat. */
  strength: number[]
  /** Where each beat sits in its bar, 0–3; 0 is the downbeat. */
  barPos: number[]
  /** How clearly the beats stand out from what is between them, 0–1. */
  confidence: number
  /** Stretches with no rhythmic content worth following. */
  gaps: SoundtrackGap[]
}

export interface BeatTrackOptions {
  minBpm?: number
  maxBpm?: number
  /** How strongly beat spacing is held to the tempo (Ellis' α). */
  tightness?: number
  /** Called with 0–1 as the work proceeds. */
  onProgress?: (f: number) => void
}

// Tightness is higher than librosa's 100 because this envelope is finer
// (100 frames/s) and peakier; at 100 the chain hopped onto syncopated
// sixteenths on real PMVs, and 400 keeps it on the beat while still
// following a real tempo change.
const DEFAULTS = { minBpm: 60, maxBpm: 200, tightness: 400 }

/** Analysis frames per second. */
const FPS = 100
/** Log compression of band magnitudes: large enough that quiet attacks still register. */
const LOG_GAIN = 100
/** Bands for the flux, log-spaced over the musically useful range. */
const BANDS = 36
const BAND_LO_HZ = 40
const BAND_HI_HZ = 8000
/** Below this the flux is kick and bass: the cue for where the bar starts. */
const LOW_HZ = 160
/** Where in a frame an attack registers, relative to its centre: measured on synthetic hits. */
const ONSET_SHIFT_S = 0.007
/** Prior on tempo: log-Gaussian centred here, σ in octaves. */
const PRIOR_BPM = 120
const PRIOR_OCTAVES = 1
/** Take the faster octave when its autocorrelation peak is at least this share of the slower one's. */
const OCTAVE_UP_RATIO = 0.7
/** A stretch counts as a gap when this many beats in a row are weak and it lasts this long. */
const GAP_MIN_BEATS = 4
const GAP_MIN_S = 2
const GAP_STRENGTH = 0.15
const GAP_QUIET_DB = 30

// ─── FFT ─────────────────────────────────────────────────────────────────────

/**
 * An in-place radix-2 complex FFT of size `n` (a power of two).
 * Tables are built once; the returned function transforms `re`/`im` in place.
 */
export function createFFT(n: number) {
  if (n < 2 || (n & (n - 1)) !== 0)
    throw new Error(`FFT size must be a power of two, got ${n}`)
  const bits = Math.round(Math.log2(n))
  const rev = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++)
      r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n)
    sin[i] = Math.sin((2 * Math.PI * i) / n)
  }

  return function fft(re: Float64Array, im: Float64Array) {
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half
          const c = cos[k]
          const s = sin[k]
          const tre = re[l] * c + im[l] * s
          const tim = im[l] * c - re[l] * s
          re[l] = re[j] - tre
          im[l] = im[j] - tim
          re[j] += tre
          im[j] += tim
        }
      }
    }
  }
}

// ─── Small numeric helpers ───────────────────────────────────────────────────

function median(values: ArrayLike<number>): number {
  const a = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length)
    return 0
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const a = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length)
    return 0
  const i = Math.min(a.length - 1, Math.max(0, (a.length - 1) * p))
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return a[lo] + (a[hi] - a[lo]) * (i - lo)
}

/** Centred moving average over ±`radius` samples. */
function movingAverage(x: ArrayLike<number>, radius: number): Float64Array {
  const n = x.length
  const pre = new Float64Array(n + 1)
  for (let i = 0; i < n; i++)
    pre[i + 1] = pre[i] + x[i]
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius)
    const b = Math.min(n, i + radius + 1)
    out[i] = (pre[b] - pre[a]) / (b - a)
  }
  return out
}

function gaussianSmooth(x: Float64Array, sigma: number): Float64Array {
  const r = Math.ceil(sigma * 3)
  const k: number[] = []
  for (let i = -r; i <= r; i++)
    k.push(Math.exp(-0.5 * (i / sigma) ** 2))
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    let s = 0
    for (let j = -r; j <= r; j++) {
      const t = i + j
      if (t >= 0 && t < x.length)
        s += x[t] * k[j + r]
    }
    out[i] = s
  }
  return out
}

/** Vertex of the parabola through (−1,a) (0,b) (1,c), as an offset in [−1, 1]. */
function parabolicOffset(a: number, b: number, c: number): number {
  const d = a - 2 * b + c
  if (d >= 0)
    return 0
  const off = (0.5 * (a - c)) / d
  return Math.max(-1, Math.min(1, off))
}

// ─── Onset envelope ──────────────────────────────────────────────────────────

interface Features {
  fps: number
  /** Time of frame 0, seconds; frame i is at t0 + i / fps. */
  t0: number
  /** Positive log-band flux per frame, mean-removed and clamped (normalised by std). */
  env: Float64Array
  /** The same but mean-removed and unclamped, for autocorrelation. */
  envAc: Float64Array
  /** Low-band (kick/bass) flux per frame, normalised by std. */
  low: Float64Array
  /** Spectral centroid per frame, Hz (NaN when silent). */
  centroid: Float64Array
  /** Spectral weight per frame (for weighting the centroid). */
  weight: Float64Array
  /** Mean square of the signal per hop-sized block. */
  blockMs: Float64Array
  hop: number
}

function extractFeatures(x: Float32Array, sr: number, progress: (f: number) => void): Features | null {
  const n = 2 ** Math.round(Math.log2(sr * 0.046))
  const hop = Math.max(1, Math.round(sr / FPS))
  const fps = sr / hop
  const frames = x.length >= n ? Math.floor((x.length - n) / hop) + 1 : 0

  // Block energy: an exact partition of the signal for per-beat loudness.
  const blocks = Math.ceil(x.length / hop)
  const blockMs = new Float64Array(blocks)
  let total = 0
  for (let b = 0; b < blocks; b++) {
    const a = b * hop
    const e = Math.min(x.length, a + hop)
    let s = 0
    for (let i = a; i < e; i++)
      s += x[i] * x[i]
    total += s
    blockMs[b] = s / Math.max(1, e - a)
  }
  const rms = Math.sqrt(total / Math.max(1, x.length))
  if (frames < 3 || !(rms > 1e-5))
    return null

  // Per-bin normalisation: a white noise at the track's level reads ~1, so
  // the log compression treats every track alike regardless of its gain.
  const window = new Float64Array(n)
  for (let i = 0; i < n; i++)
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  const norm = 1 / (rms * Math.sqrt((3 * n) / 8))

  const half = n / 2
  const bandOf = new Int16Array(half).fill(-1)
  const bandCount = new Float64Array(BANDS)
  const binHz = sr / n
  const hiHz = Math.min(BAND_HI_HZ, sr * 0.45)
  let lowBins = 0
  for (let k = 1; k < half; k++) {
    const f = k * binHz
    if (f < BAND_LO_HZ || f > hiHz)
      continue
    const b = Math.min(BANDS - 1, Math.floor((BANDS * Math.log(f / BAND_LO_HZ)) / Math.log(hiHz / BAND_LO_HZ)))
    bandOf[k] = b
    bandCount[b]++
    if (f < LOW_HZ)
      lowBins = k + 1
  }

  const fft = createFFT(n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const mags = [new Float64Array(half), new Float64Array(half)]
  const LAG = 2
  // A ring of the last LAG+1 frames' band levels.
  const ring = Array.from({ length: LAG + 1 }, () => new Float64Array(BANDS))
  const lowRing = new Float64Array(LAG + 1)
  const flux = new Float64Array(frames)
  const lowFlux = new Float64Array(frames)
  const centroid = new Float64Array(frames)
  const weight = new Float64Array(frames)
  const level = new Float64Array(BANDS)

  let nextReport = 0
  // Two real frames per complex FFT: one in the real part, one in the imaginary.
  for (let f = 0; f < frames; f += 2) {
    const a0 = f * hop
    const a1 = (f + 1) * hop
    const second = f + 1 < frames
    for (let i = 0; i < n; i++) {
      re[i] = x[a0 + i] * window[i] * norm
      im[i] = second ? x[a1 + i] * window[i] * norm : 0
    }
    fft(re, im)
    for (let k = 0; k < half; k++) {
      const j = k === 0 ? 0 : n - k
      const ar = (re[k] + re[j]) / 2
      const ai = (im[k] - im[j]) / 2
      const br = (im[k] + im[j]) / 2
      const bi = (re[j] - re[k]) / 2
      mags[0][k] = Math.sqrt(ar * ar + ai * ai)
      mags[1][k] = Math.sqrt(br * br + bi * bi)
    }

    for (let s = 0; s < (second ? 2 : 1); s++) {
      const fi = f + s
      const mag = mags[s]
      level.fill(0)
      let num = 0
      let den = 0
      let low = 0
      for (let k = 1; k < half; k++) {
        const m = mag[k]
        num += m * k * binHz
        den += m
        if (k < lowBins)
          low += m
        const b = bandOf[k]
        if (b >= 0)
          level[b] += m
      }
      centroid[fi] = den > 1e-9 ? num / den : Number.NaN
      weight[fi] = den

      const cur = ring[fi % (LAG + 1)]
      for (let b = 0; b < BANDS; b++)
        cur[b] = bandCount[b] ? Math.log1p((LOG_GAIN * level[b]) / bandCount[b]) : 0
      const lowLevel = Math.log1p((LOG_GAIN * low) / Math.max(1, lowBins - 1))
      lowRing[fi % (LAG + 1)] = lowLevel
      if (fi >= LAG) {
        const prev = ring[(fi - LAG) % (LAG + 1)]
        let fl = 0
        for (let b = 0; b < BANDS; b++) {
          const d = cur[b] - prev[b]
          if (d > 0)
            fl += d
        }
        flux[fi] = fl
        lowFlux[fi] = Math.max(0, lowLevel - lowRing[(fi - LAG) % (LAG + 1)])
      }
    }

    if (f >= nextReport) {
      progress(f / frames)
      nextReport = f + Math.max(2, Math.floor(frames / 50))
    }
  }

  // Remove the slowly varying part, so a loud chorus does not outweigh the
  // beats in a quiet verse: the tracker cares about attacks, not level.
  const mean = movingAverage(flux, Math.round(fps * 0.5))
  const envAc = new Float64Array(frames)
  const env = new Float64Array(frames)
  let sq = 0
  for (let i = 0; i < frames; i++) {
    envAc[i] = flux[i] - mean[i]
    env[i] = Math.max(0, envAc[i])
    sq += env[i] * env[i]
  }
  const sd = Math.sqrt(sq / frames) || 1
  for (let i = 0; i < frames; i++)
    env[i] /= sd

  const lowMean = movingAverage(lowFlux, Math.round(fps * 0.5))
  let lsq = 0
  for (let i = 0; i < frames; i++) {
    lowFlux[i] = Math.max(0, lowFlux[i] - lowMean[i])
    lsq += lowFlux[i] * lowFlux[i]
  }
  const lsd = Math.sqrt(lsq / frames) || 1
  for (let i = 0; i < frames; i++)
    lowFlux[i] /= lsd

  return {
    fps,
    t0: n / 2 / sr + ONSET_SHIFT_S,
    env,
    envAc,
    low: lowFlux,
    centroid,
    weight,
    blockMs,
    hop,
  }
}

// ─── Tempo ───────────────────────────────────────────────────────────────────

/** Unbiased autocorrelation of `x[a..b)` for lags `lo..hi` (inclusive). */
function autocorr(x: Float64Array, lo: number, hi: number, a = 0, b = x.length): Float64Array {
  const out = new Float64Array(hi + 1)
  for (let l = Math.max(0, lo); l <= hi; l++) {
    let s = 0
    const end = b - l
    for (let i = a; i < end; i++)
      s += x[i] * x[i + l]
    out[l] = end > a ? s / (end - a) : 0
  }
  return out
}

function priorWeight(bpm: number, centre: number, octaves: number): number {
  return Math.exp(-0.5 * (Math.log2(bpm / centre) / octaves) ** 2)
}

/** Peak of `ac` within ±1 of `l`, or -1 when there is none in range. */
function peakNear(ac: Float64Array, l: number, lo: number, hi: number): number {
  let best = -1
  for (let j = Math.round(l) - 1; j <= Math.round(l) + 1; j++) {
    if (j < lo || j > hi || j < 1 || j >= ac.length - 1)
      continue
    if (best < 0 || ac[j] > ac[best])
      best = j
  }
  return best
}

/**
 * The prevailing beat period, in frames (fractional).
 *
 * Autocorrelation peaks at every multiple of the beat, so which one is "the"
 * beat is a matter of taste (the octave problem). The prior settles most of
 * it; on top, a faster octave inside the range wins whenever the music
 * supports it nearly as well — at PMV tempos the half-time reading is the
 * usual mistake, and a stroker can always go slower than the beat, not faster.
 */
export function estimateTempo(envAc: Float64Array, fps: number, minBpm: number, maxBpm: number): { period: number, strength: number } {
  const lo = Math.max(2, Math.floor((fps * 60) / maxBpm))
  const hi = Math.min(envAc.length - 2, Math.ceil((fps * 60) / minBpm))
  if (hi <= lo + 2)
    return { period: (fps * 60) / PRIOR_BPM, strength: 0 }
  const ac = autocorr(envAc, 0, hi + 1)
  let best = -1
  let bestScore = -Infinity
  for (let l = lo; l <= hi; l++) {
    if (!(ac[l] >= ac[l - 1] && ac[l] >= ac[l + 1]))
      continue
    const s = ac[l] * priorWeight((fps * 60) / l, PRIOR_BPM, PRIOR_OCTAVES)
    if (s > bestScore) {
      bestScore = s
      best = l
    }
  }
  if (best < 0 || !(ac[best] > 0))
    return { period: (fps * 60) / PRIOR_BPM, strength: 0 }

  const up = peakNear(ac, best / 2, lo, hi)
  if (up > 0 && ac[up] >= ac[up - 1] && ac[up] >= ac[up + 1] && ac[up] >= OCTAVE_UP_RATIO * ac[best])
    best = up

  const period = best + parabolicOffset(ac[best - 1], ac[best], ac[best + 1])
  return { period, strength: ac[0] > 0 ? Math.max(0, ac[best] / ac[0]) : 0 }
}

/**
 * The beat period per frame, following tempo changes.
 *
 * Windows of a few seconds each find their own period near the global one
 * (within half an octave either way, so the octave does not flip about), and
 * windows with no clear periodicity — silence, a breakdown — borrow from
 * their neighbours.
 */
function localPeriods(envAc: Float64Array, fps: number, global: number): Float64Array {
  const n = envAc.length
  const win = Math.round(fps * 8)
  const step = Math.round(fps * 2)
  const out = new Float64Array(n).fill(global)
  if (n < win * 1.5)
    return out

  const lo = Math.max(2, Math.floor(global / Math.SQRT2))
  const hi = Math.ceil(global * Math.SQRT2)
  const centres: number[] = []
  const periods: number[] = []
  for (let a = 0; a + win <= n; a += step) {
    const ac = autocorr(envAc, lo - 1, hi + 1, a, a + win)
    let e0 = 0
    for (let i = a; i < a + win; i++)
      e0 += envAc[i] * envAc[i]
    e0 /= win
    let best = -1
    let bestScore = -Infinity
    for (let l = lo; l <= hi; l++) {
      if (!(ac[l] >= ac[l - 1] && ac[l] >= ac[l + 1]))
        continue
      const s = ac[l] * Math.exp(-0.5 * (Math.log2(l / global) / 0.25) ** 2)
      if (s > bestScore) {
        bestScore = s
        best = l
      }
    }
    centres.push(a + win / 2)
    periods.push(best > 0 && e0 > 0 && ac[best] / e0 > 0.1
      ? best + parabolicOffset(ac[best - 1], ac[best], ac[best + 1])
      : Number.NaN)
  }

  // Fill windows without a reading from the nearest that has one.
  for (let i = 0; i < periods.length; i++) {
    if (Number.isFinite(periods[i]))
      continue
    let d = 1
    let v = Number.NaN
    while (Number.isNaN(v) && (i - d >= 0 || i + d < periods.length)) {
      const l = i - d >= 0 ? periods[i - d] : Number.NaN
      const r = i + d < periods.length ? periods[i + d] : Number.NaN
      v = Number.isFinite(l) ? l : r
      d++
    }
    periods[i] = Number.isFinite(v) ? v : global
  }
  // Median of three, so one confused window does not bend the beat.
  const smooth = periods.map((_, i) => median(periods.slice(Math.max(0, i - 1), i + 2)))

  for (let i = 0; i < n; i++) {
    if (i <= centres[0]) {
      out[i] = smooth[0]
      continue
    }
    if (i >= centres[centres.length - 1]) {
      out[i] = smooth[smooth.length - 1]
      continue
    }
    const w = Math.floor((i - centres[0]) / step)
    const f = (i - centres[w]) / step
    out[i] = smooth[w] + (smooth[Math.min(w + 1, smooth.length - 1)] - smooth[w]) * f
  }
  return out
}

// ─── Beat tracking ───────────────────────────────────────────────────────────

/**
 * Ellis' dynamic programme: the best-scoring chain of beats, where a chain
 * earns the onset strength at each beat and pays for every interval that
 * strays from the local period (in log ratio, squared).
 *
 * Returns beat frame indices and the local score they were chosen from.
 */
function trackBeats(env: Float64Array, period: Float64Array, tightness: number): { frames: number[], score: Float64Array } {
  const n = env.length
  const score = gaussianSmooth(env, 1.5)
  let maxScore = 0
  for (let i = 0; i < n; i++)
    maxScore = Math.max(maxScore, score[i])
  if (!(maxScore > 0))
    return { frames: [], score }

  const cum = new Float64Array(n)
  const back = new Int32Array(n).fill(-1)
  let started = false
  for (let i = 0; i < n; i++) {
    const p = period[i]
    const from = Math.max(0, i - Math.round(2 * p))
    const to = i - Math.round(p / 2)
    let best = -Infinity
    let bi = -1
    for (let j = from; j <= to; j++) {
      const s = cum[j] - tightness * Math.log((i - j) / p) ** 2
      if (s > best) {
        best = s
        bi = j
      }
    }
    if (bi < 0) {
      cum[i] = score[i]
      continue
    }
    cum[i] = score[i] + best
    // Until the music starts, every frame is a fresh chain.
    if (!started && score[i] < 0.01 * maxScore)
      continue
    started = true
    back[i] = bi
  }

  // End on the last strong local maximum of the cumulative score, so the
  // chain does not run on into a fade.
  const maxima: number[] = []
  for (let i = 1; i < n - 1; i++) {
    if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1])
      maxima.push(i)
  }
  if (!maxima.length)
    return { frames: [], score }
  const half = 0.5 * median(maxima.map(i => cum[i]))
  let last = maxima[maxima.length - 1]
  for (let k = maxima.length - 1; k >= 0; k--) {
    if (cum[maxima[k]] >= half) {
      last = maxima[k]
      break
    }
  }

  const frames: number[] = []
  for (let i = last; i >= 0; i = back[i]) {
    frames.push(i)
    if (back[i] < 0)
      break
  }
  frames.reverse()

  // Trim the weak beats the chain needed to get going and to wind down.
  if (frames.length > 2) {
    const s = frames.map(f => score[f])
    const sm = s.map((_, i) => {
      let t = 0
      let w = 0
      for (let j = -2; j <= 2; j++) {
        const v = s[i + j]
        if (v === undefined)
          continue
        const k = 1 - Math.abs(j) / 3
        t += v * k
        w += k
      }
      return t / w
    })
    const thr = 0.5 * Math.sqrt(sm.reduce((a, v) => a + v * v, 0) / sm.length)
    let a = 0
    let b = frames.length
    while (a < b && sm[a] < thr)
      a++
    while (b > a && sm[b - 1] < thr)
      b--
    return { frames: frames.slice(a, b), score }
  }
  return { frames, score }
}

// ─── Per-beat features ───────────────────────────────────────────────────────

function maxAround(x: Float64Array, i: number, r: number): number {
  let m = 0
  for (let j = Math.max(0, i - r); j <= Math.min(x.length - 1, i + r); j++)
    m = Math.max(m, x[j])
  return m
}

function sampleAt(x: Float64Array, f: number): number {
  const i = Math.round(f)
  return i >= 0 && i < x.length ? x[i] : 0
}

/** Analyse a mono signal. */
export function analyseBeats(samples: Float32Array, sampleRate: number, opts: BeatTrackOptions = {}): SoundtrackAnalysis {
  const o = { ...DEFAULTS, ...opts }
  const report = opts.onProgress ?? (() => {})
  const duration = samples.length / sampleRate
  const empty: SoundtrackAnalysis = {
    version: ANALYSIS_VERSION,
    duration,
    bpm: 0,
    beats: [],
    energy: [],
    centroid: [],
    strength: [],
    barPos: [],
    confidence: 0,
    gaps: duration > 0 ? [{ start: 0, end: duration }] : [],
  }

  // The spectrum is ~85% of the work; everything after is quick.
  const feat = extractFeatures(samples, sampleRate, f => report(f * 0.85))
  if (!feat) {
    report(1)
    return empty
  }
  const { fps, t0, env, envAc } = feat
  const frameTime = (f: number) => t0 + f / fps

  const tempo = estimateTempo(envAc, fps, o.minBpm, o.maxBpm)
  const periods = localPeriods(envAc, fps, tempo.period)
  report(0.9)
  const { frames, score } = trackBeats(env, periods, o.tightness)
  report(0.95)
  if (frames.length < 2) {
    report(1)
    return empty
  }

  // Sub-frame timing from the shape of the local score around each pick.
  const beats = frames.map((f) => {
    const d = f > 0 && f < score.length - 1 ? parabolicOffset(score[f - 1], score[f], score[f + 1]) : 0
    return Math.max(0, frameTime(f + d))
  })
  const n = beats.length
  const lastSpan = beats[n - 1] - beats[n - 2]
  const ends = beats.map((t, i) => (i + 1 < n ? beats[i + 1] : Math.min(duration, t + lastSpan)))

  // Loudness and brightness of each beat's span.
  const energy: number[] = []
  const centroid: number[] = []
  const blockS = feat.hop / sampleRate
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, Math.floor(beats[i] / blockS))
    const b = Math.min(feat.blockMs.length, Math.max(a + 1, Math.floor(ends[i] / blockS)))
    let s = 0
    for (let j = a; j < b; j++)
      s += feat.blockMs[j]
    energy.push(Math.max(-120, 10 * Math.log10(s / Math.max(1, b - a) + 1e-12)))

    const fa = Math.max(0, Math.round((beats[i] - t0) * fps))
    const fb = Math.min(env.length, Math.max(fa + 1, Math.round((ends[i] - t0) * fps)))
    let num = 0
    let den = 0
    for (let f = fa; f < fb; f++) {
      const c = feat.centroid[f]
      if (Number.isFinite(c)) {
        num += c * feat.weight[f]
        den += feat.weight[f]
      }
    }
    centroid.push(den > 0 ? Math.log2(num / den) : Number.NaN)
  }
  // Silent beats have no brightness; give them their neighbours'.
  const cMed = median(centroid)
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(centroid[i]))
      centroid[i] = Number.isFinite(centroid[i - 1]) ? centroid[i - 1] : cMed
  }

  const rawStrength = frames.map(f => maxAround(score, f, 2))
  const sMed = median(rawStrength) || 1
  const strength = rawStrength.map(v => v / sMed)
  const rawLow = frames.map(f => maxAround(feat.low, f, 3))
  const lMed = median(rawLow) || 1
  const lowStrength = rawLow.map(v => v / lMed)

  // ── Gaps: runs of beats with nothing on them, or nothing at all ──────
  const eMed = median(energy)
  const weak = strength.map((s, i) => s < GAP_STRENGTH || energy[i] < eMed - GAP_QUIET_DB)
  const gaps: SoundtrackGap[] = []
  const inGap = Array.from<boolean>({ length: n }).fill(false)
  if (beats[0] >= GAP_MIN_S)
    gaps.push({ start: 0, end: beats[0] })
  for (let i = 0; i < n;) {
    if (!weak[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && weak[j])
      j++
    const start = beats[i]
    const end = j < n ? beats[j] : ends[n - 1]
    if (j - i >= GAP_MIN_BEATS && end - start >= GAP_MIN_S) {
      gaps.push({ start, end })
      for (let k = i; k < j; k++)
        inGap[k] = true
    }
    i = j
  }
  if (duration - ends[n - 1] >= GAP_MIN_S)
    gaps.push({ start: ends[n - 1], end: duration })

  // ── Bars: each stretch between gaps finds its own downbeat ───────────
  // The downbeat is where the kick (low-band attack) is strongest on
  // average, with overall attack strength as a tie-break. A break often
  // re-enters on a different footing, which is why it is per stretch.
  const barPos = Array.from<number>({ length: n }).fill(0)
  let prevPos = -1
  for (let i = 0; i < n;) {
    if (inGap[i]) {
      barPos[i] = (prevPos + 1) % 4
      prevPos = barPos[i]
      i++
      continue
    }
    let j = i
    while (j < n && !inGap[j])
      j++
    if (j - i >= 8) {
      const sums = [0, 0, 0, 0]
      const counts = [0, 0, 0, 0]
      for (let k = i; k < j; k++) {
        const p = (k - i) % 4
        sums[p] += lowStrength[k] + 0.3 * strength[k]
        counts[p]++
      }
      let phase = 0
      for (let p = 1; p < 4; p++) {
        if (sums[p] / counts[p] > sums[phase] / counts[phase])
          phase = p
      }
      for (let k = i; k < j; k++)
        barPos[k] = (((k - i - phase) % 4) + 4) % 4
      prevPos = barPos[j - 1]
    }
    else {
      for (let k = i; k < j; k++) {
        barPos[k] = (prevPos + 1) % 4
        prevPos = barPos[k]
      }
    }
    i = j
  }

  // ── Confidence: beats against what lies between them ─────────────────
  let on = 0
  let off = 0
  let counted = 0
  for (let i = 0; i + 1 < n; i++) {
    if (inGap[i])
      continue
    const fa = (beats[i] - t0) * fps
    const fb = (beats[i + 1] - t0) * fps
    on += maxAround(score, Math.round(fa), 1)
    off += (sampleAt(score, fa + (fb - fa) * 0.25) + sampleAt(score, fa + (fb - fa) * 0.5) + sampleAt(score, fa + (fb - fa) * 0.75)) / 3
    counted++
  }
  const contrast = on > 0 ? Math.max(0, Math.min(1, 1 - off / on)) : 0
  // The tracker always finds *some* peaks to call beats, even in noise, so
  // contrast alone flatters it; the envelope also has to repeat at the beat
  // period. And a handful of beats is not a track's worth of evidence.
  const periodic = Math.min(1, tempo.strength / 0.25)
  const confidence = contrast * periodic * Math.min(1, counted / 16)

  // The prevailing tempo from the beats themselves, which are finer than the
  // autocorrelation's lag grid: the median of four-beat spans.
  const spans: number[] = []
  for (let i = 0; i + 4 < n; i++) {
    if (!inGap[i] && !inGap[i + 4])
      spans.push((beats[i + 4] - beats[i]) / 4)
  }
  const beatS = spans.length ? median(spans) : median(beats.slice(1).map((t, i) => t - beats[i]))

  report(1)
  return {
    version: ANALYSIS_VERSION,
    duration,
    bpm: beatS > 0 ? 60 / beatS : (fps * 60) / tempo.period,
    beats,
    energy,
    centroid,
    strength,
    barPos,
    confidence,
    gaps,
  }
}

// ─── Reading an analysis back ────────────────────────────────────────────────

/**
 * A running beat count per beat, with every downbeat on a multiple of four.
 *
 * Normally it goes up by one per beat; where a section re-enters on a new
 * footing it skips ahead to keep the bar lines on the downbeats.
 */
export function beatNumbers(a: Pick<SoundtrackAnalysis, 'barPos'>): number[] {
  const out: number[] = []
  for (let i = 0; i < a.barPos.length; i++) {
    if (i === 0) {
      out.push(a.barPos[0])
      continue
    }
    const skip = (((a.barPos[i] - a.barPos[i - 1] - 1) % 4) + 4) % 4
    out.push(out[i - 1] + 1 + skip)
  }
  return out
}

/** Smooth per-beat values over ±`radius` beats. */
export function smoothPerBeat(values: number[], radius: number): number[] {
  return Array.from(movingAverage(values, radius))
}

/**
 * Per-beat values mapped onto 0–1 relative to this track (5th–95th
 * percentile, so one cymbal crash or a silent intro does not set the scale),
 * then smoothed.
 */
export function normalisePerBeat(values: number[], radius = 2, exclude?: boolean[]): number[] {
  const pool = exclude ? values.filter((_, i) => !exclude[i]) : values
  const lo = percentile(pool.length ? pool : values, 0.05)
  const hi = percentile(pool.length ? pool : values, 0.95)
  const span = hi - lo
  const raw = values.map(v => (span > 1e-9 ? Math.max(0, Math.min(1, (v - lo) / span)) : 0.5))
  return radius > 0 ? smoothPerBeat(raw, radius) : raw
}

/** Which beats fall inside a gap. */
export function beatsInGaps(a: Pick<SoundtrackAnalysis, 'beats' | 'gaps'>): boolean[] {
  return a.beats.map(t => a.gaps.some(g => t >= g.start && t < g.end))
}

export interface GridReading {
  /** Continuous beat count; integers on beats, multiples of 4 on downbeats. */
  beats: number
  bpm: number
  /** 0–1, relative to this track, smoothed. */
  energy: number
  confidence: number
  inGap: boolean
}

/**
 * Look up where in the music a moment is, from an analysis.
 *
 * Built once per analysis; `at` is cheap enough to call every frame (it
 * remembers where it last was, so playback costs a comparison or two).
 */
export function createAnalysedGrid(a: SoundtrackAnalysis) {
  const b = a.beats
  const n = b.length
  if (n < 2)
    return null
  const num = beatNumbers(a)
  const gapBeat = beatsInGaps(a)
  const energy = normalisePerBeat(a.energy, 2, gapBeat)
  let i = 0

  function locate(t: number): number {
    if (t < b[0])
      return -1
    if (t >= b[n - 1])
      return n - 1
    if (i >= 0 && i < n - 1 && t >= b[i] && t < b[i + 1])
      return i
    if (i >= 0 && i + 2 < n && t >= b[i + 1] && t < b[i + 2])
      return ++i
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (b[m] <= t)
        lo = m
      else
        hi = m
    }
    return lo
  }

  function bpmAround(k: number): number {
    const lo = Math.max(0, k - 2)
    const hi = Math.min(n - 1, k + 3)
    const d = b[hi] - b[lo]
    return d > 0 ? (60 * (hi - lo)) / d : a.bpm
  }

  return {
    at(t: number): GridReading {
      const k = locate(t)
      i = Math.max(0, k)
      const gap = a.gaps.some(g => t >= g.start && t < g.end)
      if (k < 0) {
        const p = b[1] - b[0]
        return { beats: num[0] + (t - b[0]) / p, bpm: 60 / p, energy: energy[0], confidence: gap ? 0 : a.confidence, inGap: gap }
      }
      if (k >= n - 1) {
        const p = b[n - 1] - b[n - 2]
        return { beats: num[n - 1] + (t - b[n - 1]) / p, bpm: 60 / p, energy: energy[n - 1], confidence: gap ? 0 : a.confidence, inGap: gap }
      }
      const frac = (t - b[k]) / (b[k + 1] - b[k])
      return {
        beats: num[k] + frac,
        bpm: bpmAround(k),
        energy: energy[k] + (energy[k + 1] - energy[k]) * frac,
        confidence: gap ? 0 : a.confidence,
        inGap: gap,
      }
    },
    /** The beat count's value at each analysed beat. */
    numbers: num,
  }
}

export type AnalysedGrid = NonNullable<ReturnType<typeof createAnalysedGrid>>
