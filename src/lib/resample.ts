/**
 * Streaming sample-rate conversion for analysis: a Kaiser-windowed sinc,
 * polyphase, with one exact table of coefficients per output phase.
 *
 * Fed in pieces of any size, it gives the same output as fed all at once.
 * The default filter keeps everything up to ~8 kHz at 22.05 kHz and lets
 * nothing alias below ~9 kHz, which is all a beat tracker needs.
 *
 * Pure and DOM-free.
 */

export interface ResamplerOptions {
  /** Zero crossings of the sinc each side. More is sharper and slower. */
  zeros?: number
  /** Cutoff as a share of the lower rate's Nyquist frequency. */
  cutoff?: number
  /** Kaiser window β: ~6 is 60 dB of stopband. */
  beta?: number
}

function gcd(a: number, b: number): number {
  while (b) {
    const t = a % b
    a = b
    b = t
  }
  return a
}

/** Modified Bessel function of the first kind, order 0. */
function besselI0(x: number): number {
  let sum = 1
  let term = 1
  const q = (x * x) / 4
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k)
    sum += term
    if (term < sum * 1e-16)
      break
  }
  return sum
}

export interface Resampler {
  /** Converts the next piece of input; returns the output it completes. */
  push: (x: Float32Array) => Float32Array
  /** The output still owed for the input so far (the end is padded with silence). */
  flush: () => Float32Array
}

export function createResampler(inRate: number, outRate: number, opts: ResamplerOptions = {}): Resampler {
  const fin = Math.round(inRate)
  const fout = Math.round(outRate)
  if (!(fin > 0) || !(fout > 0))
    throw new Error(`Bad sample rates ${inRate} → ${outRate}`)
  if (fin === fout) {
    return { push: x => x.slice(), flush: () => new Float32Array(0) }
  }

  const g = gcd(fin, fout)
  // Output k sits at input position k·M/L.
  const L = fout / g
  const M = fin / g
  const zeros = opts.zeros ?? 8
  const beta = opts.beta ?? 6
  // Cutoff in cycles per input sample.
  const fc = ((opts.cutoff ?? 0.95) * Math.min(fin, fout)) / 2 / fin
  const halfLen = zeros / (2 * fc)
  const H = Math.ceil(halfLen)
  const T = 2 * H
  const coef = new Float64Array(L * T)
  const i0b = besselI0(beta)
  for (let ph = 0; ph < L; ph++) {
    let sum = 0
    for (let t = 0; t < T; t++) {
      // Distance from the output position to input sample i − H + 1 + t.
      const d = ph / L + (H - 1 - t)
      const r = d / halfLen
      if (Math.abs(r) >= 1)
        continue
      const x = 2 * fc * d
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const w = besselI0(beta * Math.sqrt(1 - r * r)) / i0b
      const c = 2 * fc * sinc * w
      coef[ph * T + t] = c
      sum += c
    }
    // Unity gain at DC in every phase.
    for (let t = 0; t < T; t++)
      coef[ph * T + t] /= sum
  }

  // Input carried between pieces, from sample `bufStart` (negative at first:
  // silence before the signal).
  let buf = new Float32Array(Math.max(4096, 2 * T))
  let bufStart = -H
  let bufLen = H
  let inCount = 0
  // The next output's input position: i + ph / L.
  let i = 0
  let ph = 0

  function append(x: Float32Array) {
    // Drop what no output needs any more before growing.
    const drop = Math.max(0, Math.min(bufLen, i - H + 1 - bufStart))
    if (drop > 0) {
      buf.copyWithin(0, drop, bufLen)
      bufLen -= drop
      bufStart += drop
    }
    if (bufLen + x.length > buf.length) {
      const b = new Float32Array(Math.max(bufLen + x.length, buf.length * 2))
      b.set(buf.subarray(0, bufLen))
      buf = b
    }
    buf.set(x, bufLen)
    bufLen += x.length
  }

  /** Outputs whose input window lies inside the buffer, up to input position `end`. */
  function produce(end: number): Float32Array {
    const avail = Math.floor(((Math.min(end, bufStart + bufLen - H) - i) * L - ph) / M) + 1
    const out = new Float32Array(Math.max(0, avail))
    let k = 0
    while (k < out.length && i < end && i + H < bufStart + bufLen) {
      const base = i - H + 1 - bufStart
      const c0 = ph * T
      let s = 0
      for (let t = 0; t < T; t++)
        s += buf[base + t] * coef[c0 + t]
      out[k++] = s
      ph += M
      if (ph >= L) {
        i += Math.floor(ph / L)
        ph %= L
      }
    }
    return k === out.length ? out : out.subarray(0, k)
  }

  return {
    push(x: Float32Array) {
      append(x)
      inCount += x.length
      return produce(Infinity)
    },
    flush() {
      append(new Float32Array(H + 1))
      return produce(inCount)
    },
  }
}
