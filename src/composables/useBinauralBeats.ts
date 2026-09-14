// Singleton Web Audio context
let audioCtx: AudioContext | null = null
let masterGain: GainNode | null = null
let merger: ChannelMergerNode | null = null

// Base binaural pair (L/R channels via merger)
let baseOscL: OscillatorNode | null = null
let baseOscR: OscillatorNode | null = null
let baseGainL: GainNode | null = null
let baseGainR: GainNode | null = null

// Harmonic stack — 2 extra octave pairs, gain starts at 0
let h1OscL: OscillatorNode | null = null
let h1OscR: OscillatorNode | null = null
let h1GainL: GainNode | null = null
let h1GainR: GainNode | null = null
let h2OscL: OscillatorNode | null = null
let h2OscR: OscillatorNode | null = null
let h2GainL: GainNode | null = null
let h2GainR: GainNode | null = null

// Noise layer — 3 types running simultaneously, crossfade via gains
let noiseSrcW: AudioBufferSourceNode | null = null
let noiseSrcP: AudioBufferSourceNode | null = null
let noiseSrcBr: AudioBufferSourceNode | null = null
let noiseGainW: GainNode | null = null
let noiseGainP: GainNode | null = null
let noiseGainBr: GainNode | null = null
let noiseMasterGain: GainNode | null = null

// Beat-layer amplitude modulation (isochronic mode) and the shared session pulse
let beatAmGain: GainNode | null = null
let beatAmLfo: OscillatorNode | null = null
let beatAmDepthGain: GainNode | null = null

let pulseGain: GainNode | null = null
let pulseLfo: OscillatorNode | null = null
let pulseDepthGain: GainNode | null = null

// Analytic mirror of the pulse LFO so other subsystems can phase-lock to it.
let pulseStartedAt = 0
let pulseRateHz = 0
let pulseDepth = 0

// Breath pacing: slow asymmetric swell on the noise bed
let breathLfo: OscillatorNode | null = null
let breathDepthGain: GainNode | null = null

export type BeatMode = 'binaural' | 'monaural' | 'isochronic'
let _mode: BeatMode = 'binaural'

// Timers
let beatDriftTimer: number | null = null
let morphTimer: number | null = null
let fadeOutTimer: number | null = null

// Current audio state (for drift/morph reference)
let _baseFreq = 200
let _delta = 6

/**
 * Build a PeriodicWave matching an arbitrary single-cycle shape.
 *
 * Used for the isochronic pulse (a band-limited pulse has much steeper onsets
 * than a sine, and steep onsets are what actually drive the auditory system)
 * and for the breath cue, where the exhale needs to be longer than the inhale.
 */
function makeCurveWave(ctx: AudioContext, shape: (t: number) => number, harmonics = 24): PeriodicWave {
  const N = 512
  const real = new Float32Array(harmonics + 1)
  const imag = new Float32Array(harmonics + 1)

  for (let k = 1; k <= harmonics; k++) {
    let re = 0
    let im = 0
    for (let n = 0; n < N; n++) {
      const v = shape(n / N)
      const ang = (2 * Math.PI * k * n) / N
      re += v * Math.cos(ang)
      im -= v * Math.sin(ang)
    }
    real[k] = (2 * re) / N
    imag[k] = (2 * im) / N
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false })
}

/** Band-limited pulse: fast attack, short hold, smooth decay. */
function pulseShape(t: number): number {
  if (t < 0.08)
    return t / 0.08
  if (t < 0.28)
    return 1
  if (t < 0.62)
    return 1 - (t - 0.28) / 0.34
  return 0
}

/**
 * Breath envelope with a longer exhale than inhale — the asymmetry is the part
 * with actual evidence behind it, not the absolute rate.
 */
function breathShape(inhaleRatio: number) {
  return (t: number): number => {
    if (t < inhaleRatio)
      return 0.5 - 0.5 * Math.cos((Math.PI * t) / inhaleRatio)
    const u = (t - inhaleRatio) / (1 - inhaleRatio)
    return 0.5 + 0.5 * Math.cos(Math.PI * u)
  }
}

function getAC(): typeof AudioContext {
  return (window as any).AudioContext ?? (window as any).webkitAudioContext
}

function createNoiseBuffer(ctx: AudioContext, type: 'white' | 'pink' | 'brown'): AudioBuffer {
  const len = ctx.sampleRate * 3
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)

  if (type === 'white') {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  }
  else if (type === 'brown') {
    let last = 0
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1
      last = (last + 0.02 * w) / 1.02
      d[i] = last * 3.5
    }
  }
  else {
    // Pink noise: Paul Kellett's method
    let b0 = 0; let b1 = 0; let b2 = 0; let b3 = 0; let b4 = 0; let b5 = 0; let b6 = 0
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.96900 * b2 + w * 0.1538520
      b3 = 0.86650 * b3 + w * 0.3104856
      b4 = 0.55000 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.0168980
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
      b6 = w * 0.115926
    }
  }
  return buf
}

export function useBinauralBeats() {
  function start(baseFreq: number, delta: number, vol: number, waveType: OscillatorType = 'sine') {
    stop()
    _baseFreq = baseFreq
    _delta = delta

    const AC = getAC()
    audioCtx = new AC()

    merger = audioCtx.createChannelMerger(2)
    masterGain = audioCtx.createGain()
    masterGain.gain.value = 0 // start silent — fade in below

    // merger -> beat AM (isochronic only) -> session pulse AM -> master
    beatAmGain = audioCtx.createGain()
    beatAmGain.gain.value = 1
    pulseGain = audioCtx.createGain()
    pulseGain.gain.value = 1

    merger.connect(beatAmGain)
    beatAmGain.connect(pulseGain)
    pulseGain.connect(masterGain)
    masterGain.connect(audioCtx.destination)

    // Beat-layer modulator: only audible in isochronic mode, where the pulse
    // rate *is* the beat frequency.
    beatAmLfo = audioCtx.createOscillator()
    beatAmLfo.setPeriodicWave(makeCurveWave(audioCtx, pulseShape))
    beatAmLfo.frequency.value = Math.max(0.1, delta)
    beatAmDepthGain = audioCtx.createGain()
    beatAmDepthGain.gain.value = 0
    beatAmLfo.connect(beatAmDepthGain)
    beatAmDepthGain.connect(beatAmGain.gain)
    beatAmLfo.start()

    // Session pulse: the shared clock. Silent until setPulse() raises depth.
    pulseLfo = audioCtx.createOscillator()
    pulseLfo.setPeriodicWave(makeCurveWave(audioCtx, pulseShape))
    pulseLfo.frequency.value = 1
    pulseDepthGain = audioCtx.createGain()
    pulseDepthGain.gain.value = 0
    pulseLfo.connect(pulseDepthGain)
    pulseDepthGain.connect(pulseGain.gain)
    pulseLfo.start()
    pulseStartedAt = audioCtx.currentTime
    pulseRateHz = 1
    pulseDepth = 0

    // Base binaural pair
    baseGainL = audioCtx.createGain()
    baseGainR = audioCtx.createGain()
    baseGainL.gain.value = 1
    baseGainR.gain.value = 1
    baseOscL = audioCtx.createOscillator()
    baseOscR = audioCtx.createOscillator()
    baseOscL.type = baseOscR.type = waveType
    baseOscL.frequency.value = baseFreq
    baseOscR.frequency.value = baseFreq + delta
    baseOscL.connect(baseGainL)
    baseOscR.connect(baseGainR)
    applyRouting(_mode)

    // Harmonic 1 (+1 octave, gain=0)
    h1GainL = audioCtx.createGain()
    h1GainR = audioCtx.createGain()
    h1GainL.gain.value = 0
    h1GainR.gain.value = 0
    h1OscL = audioCtx.createOscillator()
    h1OscR = audioCtx.createOscillator()
    h1OscL.type = h1OscR.type = waveType
    h1OscL.frequency.value = baseFreq * 2
    h1OscR.frequency.value = (baseFreq + delta) * 2
    h1OscL.connect(h1GainL)
    h1OscR.connect(h1GainR)
    h1GainL.connect(merger, 0, 0)
    h1GainR.connect(merger, 0, 1)

    // Harmonic 2 (+2 octaves, gain=0)
    h2GainL = audioCtx.createGain()
    h2GainR = audioCtx.createGain()
    h2GainL.gain.value = 0
    h2GainR.gain.value = 0
    h2OscL = audioCtx.createOscillator()
    h2OscR = audioCtx.createOscillator()
    h2OscL.type = h2OscR.type = waveType
    h2OscL.frequency.value = baseFreq * 4
    h2OscR.frequency.value = (baseFreq + delta) * 4
    h2OscL.connect(h2GainL)
    h2OscR.connect(h2GainR)
    h2GainL.connect(merger, 0, 0)
    h2GainR.connect(merger, 0, 1)

    ;[baseOscL, baseOscR, h1OscL, h1OscR, h2OscL, h2OscR].forEach(o => o?.start())

    // Fade in over ~1.5s (tau = 0.5s → 95% at 1.5s)
    masterGain.gain.setTargetAtTime(vol, audioCtx.currentTime + 0.01, 0.5)
  }

  function stop() {
    if (fadeOutTimer !== null) { clearTimeout(fadeOutTimer); fadeOutTimer = null }
    stopBeatDrift()
    stopMorph()
    ;[baseOscL, baseOscR, h1OscL, h1OscR, h2OscL, h2OscR, beatAmLfo, pulseLfo, breathLfo].forEach((o) => {
      try { o?.stop() }
      catch {}
    })
    stopNoise()
    audioCtx?.close()
    audioCtx = null
    masterGain = null
    merger = null
    baseOscL = baseOscR = null
    baseGainL = baseGainR = null
    h1OscL = h1OscR = null
    h1GainL = h1GainR = null
    h2OscL = h2OscR = null
    h2GainL = h2GainR = null
    beatAmGain = beatAmDepthGain = null
    beatAmLfo = null
    pulseGain = pulseDepthGain = null
    pulseLfo = null
    breathLfo = null
    breathDepthGain = null
    pulseRateHz = 0
    pulseDepth = 0
  }

  // Fade out master + noise, then stop the audio context
  function fadeOut(fadeSec = 2.0, onDone?: () => void) {
    if (!masterGain || !audioCtx) { stop(); onDone?.(); return }
    if (fadeOutTimer !== null) { clearTimeout(fadeOutTimer); fadeOutTimer = null }
    const t = audioCtx.currentTime
    masterGain.gain.cancelScheduledValues(t)
    masterGain.gain.setTargetAtTime(0, t, fadeSec / 3)
    if (noiseMasterGain) {
      noiseMasterGain.gain.cancelScheduledValues(t)
      noiseMasterGain.gain.setTargetAtTime(0, t, fadeSec / 3)
    }
    fadeOutTimer = window.setTimeout(() => {
      stop()
      onDone?.()
      fadeOutTimer = null
    }, fadeSec * 1200)
  }

  function setVolume(vol: number) {
    if (masterGain && audioCtx)
      masterGain.gain.setTargetAtTime(vol, audioCtx.currentTime, 0.05)
  }

  function setFrequencies(baseFreq: number, delta: number, rampSec = 0.1) {
    _baseFreq = baseFreq
    _delta = delta
    if (!audioCtx)
      return
    const t = audioCtx.currentTime
    const tau = rampSec / 3

    baseOscL?.frequency.setTargetAtTime(baseFreq, t, tau)
    baseOscR?.frequency.setTargetAtTime(baseFreq + delta, t, tau)
    h1OscL?.frequency.setTargetAtTime(baseFreq * 2, t, tau)
    h1OscR?.frequency.setTargetAtTime((baseFreq + delta) * 2, t, tau)
    h2OscL?.frequency.setTargetAtTime(baseFreq * 4, t, tau)
    h2OscR?.frequency.setTargetAtTime((baseFreq + delta) * 4, t, tau)
    // In isochronic mode the gate rate is the beat, so it tracks delta too.
    beatAmLfo?.frequency.setTargetAtTime(Math.max(0.1, delta), t, tau)
  }

  function setWaveType(type: OscillatorType) {
    ;[baseOscL, baseOscR, h1OscL, h1OscR, h2OscL, h2OscR].forEach((o) => {
      if (o)
        o.type = type
    })
  }

  function setHarmonics(enabled: boolean) {
    if (!audioCtx || !h1GainL || !h1GainR || !h2GainL || !h2GainR)
      return
    const t = audioCtx.currentTime
    const tau = 0.8
    h1GainL.gain.setTargetAtTime(enabled ? 0.35 : 0, t, tau)
    h1GainR.gain.setTargetAtTime(enabled ? 0.35 : 0, t, tau)
    h2GainL.gain.setTargetAtTime(enabled ? 0.18 : 0, t, tau)
    h2GainR.gain.setTargetAtTime(enabled ? 0.18 : 0, t, tau)
  }

  // --- Noise layer ---

  function startNoise(vol: number) {
    if (!audioCtx)
      return
    stopNoise()

    noiseMasterGain = audioCtx.createGain()
    noiseMasterGain.gain.value = 0
    noiseMasterGain.connect(audioCtx.destination)

    noiseGainW = audioCtx.createGain()
    noiseGainP = audioCtx.createGain()
    noiseGainBr = audioCtx.createGain()
    noiseGainW.gain.value = 0
    noiseGainP.gain.value = 0
    noiseGainBr.gain.value = 1 // default brown
    noiseGainW.connect(noiseMasterGain)
    noiseGainP.connect(noiseMasterGain)
    noiseGainBr.connect(noiseMasterGain)

    noiseSrcW = audioCtx.createBufferSource()
    noiseSrcP = audioCtx.createBufferSource()
    noiseSrcBr = audioCtx.createBufferSource()
    noiseSrcW.buffer = createNoiseBuffer(audioCtx, 'white')
    noiseSrcP.buffer = createNoiseBuffer(audioCtx, 'pink')
    noiseSrcBr.buffer = createNoiseBuffer(audioCtx, 'brown')
    noiseSrcW.loop = noiseSrcP.loop = noiseSrcBr.loop = true
    noiseSrcW.connect(noiseGainW)
    noiseSrcP.connect(noiseGainP)
    noiseSrcBr.connect(noiseGainBr)
    noiseSrcW.start()
    noiseSrcP.start()
    noiseSrcBr.start()

    // Fade in over 1.5s
    noiseMasterGain.gain.setTargetAtTime(vol, audioCtx.currentTime, 0.5)
  }

  function stopNoise() {
    ;[noiseSrcW, noiseSrcP, noiseSrcBr].forEach((s) => {
      try { s?.stop() }
      catch {}
    })
    noiseSrcW = noiseSrcP = noiseSrcBr = null
    noiseGainW = noiseGainP = noiseGainBr = null
    noiseMasterGain?.disconnect()
    noiseMasterGain = null
  }

  function setNoiseVolume(vol: number) {
    if (noiseMasterGain && audioCtx)
      noiseMasterGain.gain.setTargetAtTime(vol, audioCtx.currentTime, 0.3)
  }

  function morphNoise(type: 'white' | 'pink' | 'brown', duration = 3) {
    if (!audioCtx || !noiseGainW || !noiseGainP || !noiseGainBr)
      return
    const t = audioCtx.currentTime
    const tau = duration / 3
    noiseGainW.gain.setTargetAtTime(type === 'white' ? 1 : 0, t, tau)
    noiseGainP.gain.setTargetAtTime(type === 'pink' ? 1 : 0, t, tau)
    noiseGainBr.gain.setTargetAtTime(type === 'brown' ? 1 : 0, t, tau)
  }

  // --- Beat drift: micro-random variation ---

  function startBeatDrift(
    getBase: () => number,
    getDelta: () => number,
    onUpdate: (newDelta: number) => void,
  ) {
    stopBeatDrift()

    function driftTick() {
      const variation = (Math.random() * 2 - 1) * 0.4
      const next = Math.max(0.5, Math.min(40, getDelta() + variation))
      setFrequencies(getBase(), next, 3)
      onUpdate(next)
      beatDriftTimer = window.setTimeout(driftTick, 2500 + Math.random() * 3500)
    }

    beatDriftTimer = window.setTimeout(driftTick, 1500 + Math.random() * 2000)
  }

  function stopBeatDrift() {
    if (beatDriftTimer !== null) {
      clearTimeout(beatDriftTimer)
      beatDriftTimer = null
    }
  }

  // --- Smooth morph to target frequencies ---

  function morphTo(targetBase: number, targetDelta: number, durationSec = 5) {
    stopMorph()
    if (!audioCtx)
      return

    const startBase = _baseFreq
    const startDelta = _delta
    const steps = 40
    const stepMs = (durationSec * 1000) / steps
    let step = 0

    morphTimer = window.setInterval(() => {
      step++
      const p = step / steps
      const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2
      const newBase = startBase + (targetBase - startBase) * eased
      const newDelta = startDelta + (targetDelta - startDelta) * eased
      setFrequencies(newBase, newDelta, stepMs / 1000)
      if (step >= steps)
        stopMorph()
    }, stepMs) as unknown as number
  }

  function stopMorph() {
    if (morphTimer !== null) {
      clearInterval(morphTimer)
      morphTimer = null
    }
  }

  /**
   * Route the tone pair according to the beat mode.
   *
   * - binaural   — one tone per ear; the beat exists only in the listener's head
   *                and is the weakest of the three at driving a cortical response
   * - monaural   — both tones to both ears, so they physically interfere and the
   *                beat is a real acoustic event
   * - isochronic — a single tone gated on and off at the beat rate; steep onsets
   *                give the strongest response of the three, at the cost of being
   *                impossible to ignore
   */
  function applyRouting(mode: BeatMode) {
    if (!merger || !baseGainL || !baseGainR)
      return
    _mode = mode

    try {
      baseGainL.disconnect()
      baseGainR.disconnect()
    }
    catch {}

    if (mode === 'binaural') {
      baseGainL.connect(merger, 0, 0)
      baseGainR.connect(merger, 0, 1)
      baseGainL.gain.value = 1
      baseGainR.gain.value = 1
      if (beatAmDepthGain && audioCtx)
        beatAmDepthGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1)
    }
    else if (mode === 'monaural') {
      // Both tones into both ears so the beat is physically present.
      baseGainL.connect(merger, 0, 0)
      baseGainL.connect(merger, 0, 1)
      baseGainR.connect(merger, 0, 0)
      baseGainR.connect(merger, 0, 1)
      baseGainL.gain.value = 0.5
      baseGainR.gain.value = 0.5
      if (beatAmDepthGain && audioCtx)
        beatAmDepthGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1)
    }
    else {
      // Single carrier, gated by the beat-rate modulator.
      baseGainL.connect(merger, 0, 0)
      baseGainL.connect(merger, 0, 1)
      baseGainL.gain.value = 1
      baseGainR.gain.value = 0
      if (beatAmDepthGain && audioCtx && beatAmGain) {
        beatAmGain.gain.setTargetAtTime(0.5, audioCtx.currentTime, 0.1)
        beatAmDepthGain.gain.setTargetAtTime(0.5, audioCtx.currentTime, 0.1)
      }
    }
  }

  function setMode(mode: BeatMode) {
    applyRouting(mode)
  }

  /**
   * Set the session pulse — the slow swell everything else locks to.
   *
   * `rateHz` is changed without resetting the oscillator's phase, and the
   * analytic mirror is re-anchored to match, so `getPulseClock()` stays exact
   * across tempo changes and nothing jumps.
   */
  function setPulse(rateHz: number, depth: number, rampSec = 0.6) {
    if (!audioCtx || !pulseLfo || !pulseDepthGain || !pulseGain)
      return
    const now = audioCtx.currentTime
    const r = Math.max(0.05, Math.min(8, rateHz))
    const d = Math.max(0, Math.min(1, depth))

    // Preserve phase across a rate change.
    const phase = ((now - pulseStartedAt) * pulseRateHz) % 1
    pulseStartedAt = now - phase / r
    pulseRateHz = r
    pulseDepth = d

    pulseLfo.frequency.setTargetAtTime(r, now, 0.05)
    // Centre the carrier so the modulator swings between 1-d and 1.
    pulseGain.gain.setTargetAtTime(1 - d / 2, now, rampSec / 3)
    pulseDepthGain.gain.setTargetAtTime(d / 2, now, rampSec / 3)
  }

  /**
   * Current pulse phase, for anything that needs to move in time with the
   * audio — the device stroke, the slideshow, the visual LFO. Returns null when
   * the engine is not running.
   */
  function getPulseClock(): { phase: number, rateHz: number, depth: number } | null {
    if (!audioCtx || pulseRateHz <= 0)
      return null
    const raw = (audioCtx.currentTime - pulseStartedAt) * pulseRateHz
    return { phase: ((raw % 1) + 1) % 1, rateHz: pulseRateHz, depth: pulseDepth }
  }

  /**
   * Breath cue on the noise bed. The default 0.1 Hz (six per minute) with a
   * longer exhale is the one part of this stack with a solid mechanism behind
   * it — baroreflex resonance — rather than entrainment folklore.
   */
  function setBreath(enabled: boolean, periodSec = 10, inhaleRatio = 0.4, depth = 0.5) {
    if (!audioCtx || !noiseMasterGain)
      return
    const now = audioCtx.currentTime

    if (!enabled) {
      if (breathDepthGain)
        breathDepthGain.gain.setTargetAtTime(0, now, 0.5)
      return
    }

    if (!breathLfo) {
      breathLfo = audioCtx.createOscillator()
      breathDepthGain = audioCtx.createGain()
      breathDepthGain.gain.value = 0
      breathLfo.connect(breathDepthGain)
      breathDepthGain.connect(noiseMasterGain.gain)
      breathLfo.start()
    }
    breathLfo.setPeriodicWave(makeCurveWave(audioCtx, breathShape(inhaleRatio), 16))
    breathLfo.frequency.setTargetAtTime(1 / Math.max(2, periodSec), now, 0.5)
    breathDepthGain!.gain.setTargetAtTime(Math.max(0, Math.min(1, depth)), now, 1.5)
  }

  return {
    start,
    setMode,
    setPulse,
    getPulseClock,
    setBreath,
    stop,
    fadeOut,
    setVolume,
    setFrequencies,
    setWaveType,
    setHarmonics,
    startNoise,
    stopNoise,
    setNoiseVolume,
    morphNoise,
    startBeatDrift,
    stopBeatDrift,
    morphTo,
    stopMorph,
  }
}
