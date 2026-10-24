import type { Programme } from '../src/lib/programme'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

// The programme drives other subsystems; stand them in with just enough to
// observe what it asks of them.
const steer = ref<number | null>(null)
const pickNext = vi.fn(() => null)
vi.mock('~/composables/useAutoDirector', () => ({
  useAutoDirector: () => ({ steer, pickNext, summaries: ref({}), readyCount: () => 0 }),
}))

const listeners = new Map<string, (() => void)[]>()
const applyPhase = vi.fn()
let engineRunning = false
vi.mock('~/composables/useSessionEngine', () => ({
  useSessionEngine: () => ({
    applyPhase,
    isRunning: () => engineRunning,
    stopSession: () => {
      engineRunning = false
      listeners.get('sessionStop')?.forEach(f => f())
    },
    on: (ev: string, fn: () => void) => {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn])
      return () => {}
    },
  }),
}))
vi.mock('~/composables/useBinauralBeats', () => ({
  useBinauralBeats: () => ({ start: vi.fn(), fadeOut: vi.fn() }),
}))
const canDrive = ref(false)
vi.mock('~/composables/useScriptPulse', () => ({
  useScriptPulse: () => ({ canDrive, scriptIntensity: ref(0), locked: ref(false), scriptSpm: ref(0) }),
}))
vi.mock('~/composables/useToast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), warn: vi.fn(), error: vi.fn() })
  return { toast }
})
const next = vi.fn(async () => true)
vi.mock('~/stores/playbackStore', () => ({
  usePlaybackStore: () => ({ next, play: vi.fn(), pause: vi.fn(), resume: vi.fn(), currentEntry: null, trackSeq: 0 }),
}))

const { useProgrammeStore } = await import('../src/stores/programmeStore')
const { useAudioStore } = await import('../src/stores/audio')
const { useMotionStore } = await import('../src/stores/motionStore')
const { useSafetyStore } = await import('../src/stores/safetyStore')
const { newPhase } = await import('../src/lib/programme')

function programme(over: Partial<Programme> = {}): Programme {
  return {
    id: 'test',
    name: 'Test',
    video: 'ended',
    everyMin: 5,
    tone: false,
    phases: [
      newPhase('warmup', { minutes: 1, from: 0.2, to: 0.4, capSpm: 60 }),
      newPhase('peak', { minutes: 1, from: 0.6, to: 0.8, capSpm: null }),
    ],
    ...over,
  }
}

const seconds = (s: number) => vi.advanceTimersByTime(s * 1000)

describe('programme runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    setActivePinia(createPinia())
    steer.value = null
    engineRunning = false
    canDrive.value = false
    listeners.clear()
    applyPhase.mockClear()
    next.mockClear()
    const audio = useAudioStore()
    audio.sessionActive.value = false
    audio.intensity.value = 0.5
    audio.phase.value = 'idle'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('owns the session and drives intensity along the curve', () => {
    const prog = useProgrammeStore()
    const audio = useAudioStore()
    prog.start(programme())
    expect(prog.status).toBe('running')
    expect(audio.sessionActive.value).toBe(true)
    expect(audio.intensity.value).toBeCloseTo(0.2)
    expect(applyPhase).toHaveBeenCalledWith('entry', { beatRange: undefined })

    seconds(30)
    expect(audio.intensity.value).toBeGreaterThan(0.25)
    expect(audio.intensity.value).toBeLessThan(0.4)
    // The director is steered to the same target.
    expect(steer.value).toBeCloseTo(prog.target)
  })

  it('enters the next phase on the clock, gliding rather than jumping', () => {
    const prog = useProgrammeStore()
    const audio = useAudioStore()
    prog.start(programme())
    seconds(61)
    expect(prog.phaseIndex).toBe(1)
    expect(applyPhase).toHaveBeenLastCalledWith('peak', { beatRange: undefined })
    // Curve stepped from 0.4 to 0.6; the written value is still on its way.
    expect(prog.target).toBeGreaterThanOrEqual(0.6)
    expect(audio.intensity.value).toBeLessThan(prog.target)
  })

  it('lowers the motion ceiling for a capped phase, and puts it back', () => {
    const prog = useProgrammeStore()
    const motion = useMotionStore()
    motion.maxSpm = 150
    prog.start(programme())
    expect(motion.maxSpm).toBe(60)
    seconds(61)
    expect(motion.maxSpm).toBe(150)
    prog.halt()
    expect(motion.maxSpm).toBe(150)
  })

  it('never raises the ceiling above the user\'s', () => {
    const prog = useProgrammeStore()
    const motion = useMotionStore()
    motion.maxSpm = 40
    prog.start(programme())
    expect(motion.maxSpm).toBe(40)
  })

  it('keeps a ceiling changed by hand during the run', async () => {
    const prog = useProgrammeStore()
    const motion = useMotionStore()
    motion.maxSpm = 150
    prog.start(programme())
    motion.maxSpm = 50
    await nextTick()
    prog.halt()
    expect(motion.maxSpm).toBe(50)
  })

  it('stops by easing intensity down before letting the session go', () => {
    const prog = useProgrammeStore()
    const audio = useAudioStore()
    prog.start(programme())
    seconds(61)
    prog.stop()
    expect(prog.status).toBe('stopping')
    expect(audio.sessionActive.value).toBe(true)
    const before = audio.intensity.value
    seconds(1)
    expect(audio.intensity.value).toBeLessThan(before)
    expect(audio.intensity.value).toBeGreaterThan(0)
    seconds(20)
    expect(prog.status).toBe('idle')
    expect(audio.sessionActive.value).toBe(false)
    expect(audio.intensity.value).toBe(0)
    expect(steer.value).toBeNull()
  })

  it('stops at once on panic', async () => {
    const prog = useProgrammeStore()
    const audio = useAudioStore()
    const motion = useMotionStore()
    motion.maxSpm = 150
    prog.start(programme())
    useSafetyStore().panicked = true
    await nextTick()
    expect(prog.status).toBe('idle')
    expect(audio.sessionActive.value).toBe(false)
    expect(motion.maxSpm).toBe(150)
  })

  it('refuses to start while panicked', () => {
    const prog = useProgrammeStore()
    useSafetyStore().panicked = true
    prog.start(programme())
    expect(prog.status).toBe('idle')
  })

  it('takes over from a running engine session without ending itself', () => {
    const prog = useProgrammeStore()
    engineRunning = true
    prog.start(programme())
    expect(engineRunning).toBe(false)
    expect(prog.status).toBe('running')
  })

  it('ends when the session is ended elsewhere', () => {
    const prog = useProgrammeStore()
    prog.start(programme())
    listeners.get('sessionStop')?.forEach(f => f())
    expect(prog.status).toBe('idle')
  })

  it('holds the clock while paused', () => {
    const prog = useProgrammeStore()
    prog.start(programme())
    seconds(10)
    prog.pause()
    const at = prog.elapsed
    seconds(30)
    expect(prog.elapsed).toBe(at)
    prog.resume()
    seconds(5)
    expect(prog.elapsed).toBeGreaterThan(at)
  })

  it('skips and extends phases', () => {
    const prog = useProgrammeStore()
    prog.start(programme())
    prog.extendPhase()
    expect(prog.total).toBe(120 + 300)
    prog.skipPhase()
    expect(prog.phaseIndex).toBe(1)
    prog.skipPhase()
    expect(prog.status).toBe('stopping')
  })

  it('finishes on its own at the end', () => {
    const prog = useProgrammeStore()
    prog.start(programme({ phases: [newPhase('cooldown', { minutes: 1, from: 0.2, to: 0.05 })] }))
    seconds(62)
    seconds(5)
    expect(prog.status).toBe('idle')
    expect(prog.finished).toBe(true)
  })

  it('leaves intensity to the script while Follow script drives it, but still steers', () => {
    const prog = useProgrammeStore()
    const audio = useAudioStore()
    canDrive.value = true
    audio.scriptDriveIntensity.value = true
    audio.intensity.value = 0.9
    prog.start(programme())
    seconds(5)
    expect(audio.intensity.value).toBe(0.9)
    expect(steer.value).toBeCloseTo(prog.target)
  })

  it('saves edited programmes and sanitises them', () => {
    const prog = useProgrammeStore()
    const saved = prog.save(programme({ id: 'mine', name: 'Mine', everyMin: 0 }))!
    expect(saved.everyMin).toBe(1)
    expect(prog.userProgrammes.map(p => p.id)).toEqual(['mine'])
    expect(prog.selectedId).toBe('mine')
    prog.remove('mine')
    expect(prog.userProgrammes).toHaveLength(0)
    expect(prog.selectedId).not.toBe('mine')
  })
})
