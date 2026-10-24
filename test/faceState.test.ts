import type { ExprState, FaceInputs, FaceMessage } from '../src/lib/faceState'
import { describe, expect, it } from 'vitest'
import {
  buildFaceMessage,
  cleanTitle,
  DEFAULT_SIGNALS,
  deriveIntensity,
  derivePhase,
  EXPR_TIMING,
  FACE_KEEPALIVE_MS,
  faceChanged,
  initialExprState,
  ladderStep,
  shouldSend,
  stepExpression,
  TITLE_MAX_BYTES,
} from '../src/lib/faceState'

function inputs(over: Partial<FaceInputs> = {}): FaceInputs {
  return {
    videoPlaying: false,
    title: '',
    panicked: false,
    deviceConnected: false,
    sessionActive: false,
    sessionIntensity: 0.5,
    sessionPhase: 'idle',
    scriptIntensity: null,
    scriptSpm: null,
    motionRunning: false,
    motionSpm: 0,
    motionMaxSpm: 150,
    strokePos: null,
    ...over,
  }
}

/** Feed a constant input for `ms`, sampled every `step` ms, as useFaceLink does. */
function run(state: ExprState, input: { active: boolean, intensity: number, panic: boolean }, from: number, ms: number, step = 100) {
  let s = state
  for (let t = from; t <= from + ms; t += step)
    s = stepExpression(s, input, t)
  return s
}

describe('cleanTitle', () => {
  it('strips the path and extension and turns separators into spaces', () => {
    expect(cleanTitle('C:\\videos\\My_Great.Video.mp4')).toBe('My Great Video')
    expect(cleanTitle('/a/b/clip.webm')).toBe('clip')
    expect(cleanTitle('')).toBe('')
  })

  it('cuts long titles to the firmware buffer without splitting a character', () => {
    const t = cleanTitle(`${'あ'.repeat(40)}.mp4`)
    expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(TITLE_MAX_BYTES)
    expect(t.endsWith('…')).toBe(true)
    expect(t).not.toContain('\uFFFD')
  })
})

describe('deriveIntensity', () => {
  it('prefers a running session', () => {
    const r = deriveIntensity(inputs({ sessionActive: true, sessionIntensity: 0.7, videoPlaying: true, scriptIntensity: 0.2 }))
    expect(r).toMatchObject({ value: 0.7, src: 'session' })
  })

  it('falls back to the playing script, then generated motion', () => {
    expect(deriveIntensity(inputs({ videoPlaying: true, scriptIntensity: 0.4, scriptSpm: 80 })))
      .toEqual({ value: 0.4, src: 'script', spm: 80 })
    expect(deriveIntensity(inputs({ motionRunning: true, motionSpm: 75, motionMaxSpm: 150 })))
      .toEqual({ value: 0.5, src: 'motion', spm: 75 })
  })

  it('a paused script says nothing', () => {
    expect(deriveIntensity(inputs({ scriptIntensity: 0.9 })).src).toBe('none')
  })
})

describe('derivePhase', () => {
  it('passes a known session phase and calls everything else idle', () => {
    expect(derivePhase(inputs({ sessionActive: true, sessionPhase: 'peak' }))).toBe('peak')
    expect(derivePhase(inputs({ sessionActive: true, sessionPhase: 'weird' }))).toBe('idle')
    expect(derivePhase(inputs({ sessionPhase: 'peak' }))).toBe('idle')
  })
})

describe('ladderStep', () => {
  it('climbs on the threshold but needs a margin to come back down', () => {
    expect(ladderStep(0, 0.36)).toBe(1)
    expect(ladderStep(1, 0.34)).toBe(1) // still focused inside the band
    expect(ladderStep(1, 0.26)).toBe(0)
    expect(ladderStep(0, 0.9)).toBe(3) // straight to the top
    expect(ladderStep(3, 0.1)).toBe(0)
  })
})

describe('stepExpression', () => {
  const active = (intensity: number) => ({ active: true, intensity, panic: false })

  it('waits out the dwell before changing', () => {
    let s = initialExprState(0)
    s = stepExpression(s, active(0.7), 0)
    expect(s.expr).toBe('calm')
    expect(s.pending).toBe('excited')
    s = run(s, active(0.7), 100, EXPR_TIMING.dwellMs)
    expect(s.expr).toBe('excited')
  })

  it('does not flicker when intensity jitters across a threshold', () => {
    let s = run(initialExprState(0), active(0.65), 0, 3000)
    expect(s.expr).toBe('excited')
    const seen = new Set<string>()
    for (let t = 3000; t < 13000; t += 100) {
      s = stepExpression(s, active(0.6 + Math.sin(t) * 0.05), t)
      seen.add(s.expr)
    }
    expect([...seen]).toEqual(['excited'])
  })

  it('a blip shorter than the dwell never shows', () => {
    let s = run(initialExprState(0), active(0.2), 0, 2000)
    s = run(s, active(0.95), 2100, EXPR_TIMING.dwellMs - 300)
    s = run(s, active(0.2), 3100, 2000)
    expect(s.expr).toBe('calm')
  })

  it('panic is instant, and lingers after it lifts', () => {
    let s = run(initialExprState(0), active(0.5), 0, 2000)
    s = stepExpression(s, { active: true, intensity: 0.5, panic: true }, 2100)
    expect(s.expr).toBe('shocked')
    s = run(s, { active: false, intensity: 0, panic: true }, 2200, 20_000)
    // Lifted: still shocked through the hold, then calm after the dwell.
    s = run(s, { active: false, intensity: 0, panic: false }, 22_300, EXPR_TIMING.shockHoldMs - 200)
    expect(s.expr).toBe('shocked')
    s = run(s, { active: false, intensity: 0, panic: false }, 22_300 + EXPR_TIMING.shockHoldMs, EXPR_TIMING.dwellMs + 200)
    expect(s.expr).toBe('calm')
  })

  it('nods off after a while with nothing going on, and wakes up', () => {
    const idle = { active: false, intensity: 0, panic: false }
    let s = run(initialExprState(0), idle, 0, EXPR_TIMING.sleepAfterMs - 1000, 500)
    expect(s.expr).toBe('calm')
    s = run(s, idle, EXPR_TIMING.sleepAfterMs, EXPR_TIMING.dwellMs + 500, 500)
    expect(s.expr).toBe('sleepy')
    s = run(s, active(0.7), 60_000, EXPR_TIMING.dwellMs + 200)
    expect(s.expr).toBe('excited')
  })
})

describe('buildFaceMessage', () => {
  it('carries every signal by default, rounded', () => {
    const m = buildFaceMessage(inputs({
      videoPlaying: true,
      title: 'x/clip.mp4',
      scriptIntensity: 0.4567,
      scriptSpm: 83.6,
      strokePos: 0.123456,
      deviceConnected: true,
    }), 'focused')
    expect(m).toEqual({
      type: 'face',
      v: 1,
      playing: true,
      panic: false,
      expr: 'focused',
      intensity: 0.46,
      src: 'script',
      strokePos: 0.12,
      spm: 84,
      phase: 'idle',
      deviceConnected: true,
      title: 'clip',
    })
  })

  it('leaves switched-off signals out entirely', () => {
    const m = buildFaceMessage(inputs({ strokePos: 0.5 }), 'calm', { ...DEFAULT_SIGNALS, strokePos: false, title: false, spm: false })
    expect('strokePos' in m).toBe(false)
    expect('title' in m).toBe(false)
    expect('spm' in m).toBe(false)
    expect(m.intensity).toBe(0)
  })

  it('goes blank on panic', () => {
    const m = buildFaceMessage(inputs({ panicked: true, videoPlaying: true, title: 'secret.mp4', scriptIntensity: 0.9, strokePos: 0.3 }), 'shocked')
    expect(m).toMatchObject({ panic: true, intensity: 0, src: 'none', spm: 0, title: '' })
    expect('strokePos' in m).toBe(false)
  })

  it('stays well under the firmware JSON budget', () => {
    const m = buildFaceMessage(inputs({ title: `${'W'.repeat(200)}.mp4`, videoPlaying: true, scriptIntensity: 1, scriptSpm: 180, strokePos: 1, deviceConnected: true }), 'flustered')
    expect(new TextEncoder().encode(JSON.stringify(m)).length).toBeLessThan(300)
  })
})

describe('faceChanged / shouldSend', () => {
  const base: FaceMessage = { type: 'face', v: 1, playing: true, panic: false, expr: 'calm', intensity: 0.5, strokePos: 0.5, spm: 60 }

  it('ignores movement under the epsilons', () => {
    expect(faceChanged(base, { ...base, intensity: 0.51, strokePos: 0.51, spm: 61 })).toBe(false)
    expect(faceChanged(base, { ...base, strokePos: 0.53 })).toBe(true)
    expect(faceChanged(base, { ...base, expr: 'focused' })).toBe(true)
    expect(faceChanged(null, base)).toBe(true)
  })

  it('notices a field appearing or disappearing', () => {
    const { strokePos: _, ...noPos } = base
    expect(faceChanged(base, noPos)).toBe(true)
  })

  it('holds to the rate, sends on change, and keeps alive', () => {
    const moved = { ...base, strokePos: 0.9 }
    expect(shouldSend(base, moved, 1050, 1000, 10)).toBe(false) // 50ms < 100ms
    expect(shouldSend(base, moved, 1100, 1000, 10)).toBe(true)
    expect(shouldSend(base, base, 1100, 1000, 10)).toBe(false) // unchanged
    expect(shouldSend(base, base, 1000 + FACE_KEEPALIVE_MS, 1000, 10)).toBe(true)
    expect(shouldSend(base, base, 1001, 1000, 10, true)).toBe(true) // hello
  })

  it('clamps silly rates', () => {
    const moved = { ...base, strokePos: 0.9 }
    // 100 Hz is clamped to 10.
    expect(shouldSend(base, moved, 1020, 1000, 100)).toBe(false)
  })
})
