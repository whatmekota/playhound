import type { ChapterIndexRecord } from '../src/lib/chapterIndex'
import type { Programme } from '../src/lib/programme'
import type { VideoEntry } from '../src/stores/libraryStore'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive, ref } from 'vue'

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

type Takeover = null | { label: string, next: () => Promise<boolean> | boolean }
const next = vi.fn(async () => true)
const playAt = vi.fn(async (_e: VideoEntry, _t: number) => {})
const playback = reactive({
  next,
  play: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  playAt,
  currentEntry: null,
  trackSeq: 0,
  loading: false,
  takeover: null as Takeover,
  setTakeover(t: Takeover) {
    playback.takeover = t
  },
})
vi.mock('~/stores/playbackStore', () => ({ usePlaybackStore: () => playback }))

// The chapter index, as if the library had been indexed already.
const records = new Map<string, ChapterIndexRecord>()
vi.mock('~/lib/chapterIndex', () => ({
  CURVE_MS: 5000,
  indexRecord: (f: File | null) => (f ? records.get(f.name) ?? null : null),
  indexRevision: ref(0),
  indexState: { loaded: true, running: false, done: 0, total: 0, failed: 0 },
  buildIndex: vi.fn(async () => {}),
  cancelIndex: vi.fn(),
}))

const { useProgrammeStore } = await import('../src/stores/programmeStore')
const { useAudioStore } = await import('../src/stores/audio')
const { useMotionStore } = await import('../src/stores/motionStore')
const { useSafetyStore } = await import('../src/stores/safetyStore')
const { useLibraryStore } = await import('../src/stores/libraryStore')
const { usePlayerStore } = await import('../src/stores/playerStore')
const { useSessionControlStore } = await import('../src/stores/sessionControlStore')
const { newPhase } = await import('../src/lib/programme')

const CURVE_MS = 5000

function programme(over: Partial<Programme> = {}): Programme {
  return {
    id: 'test',
    name: 'Test',
    reel: true,
    clipSec: [20, 180],
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

/** A library video with one script and an index record: 60 s chapters of the given intensities. */
function indexed(name: string, levels: number[]): VideoEntry {
  const script = new File(['{}'], `${name}.funscript`)
  const chapters = levels.map((v, i) => ({
    start: i * 60_000,
    end: (i + 1) * 60_000,
    intensity: v,
    speed: 1 + v * 3.2,
    spm: 60,
    kind: 'medium' as const,
    name: `ch${i}`,
    source: 'auto' as const,
  }))
  const durationMs = levels.length * 60_000
  records.set(script.name, {
    v: 1,
    video: `${name}.mp4`,
    durationMs,
    chapters,
    cuts: Array.from({ length: durationMs / 500 }, (_, i) => i * 500 + 250),
    curve: Array.from({ length: durationMs / CURVE_MS }, (_, k) => chapters[Math.floor((k * CURVE_MS) / 60_000)].speed),
    creator: null,
    tags: [],
    at: 0,
  })
  return {
    file: new File(['x'], `${name}.mp4`),
    name: `${name}.mp4`,
    basename: name,
    hasScript: true,
    scriptCount: 1,
    altCount: 0,
    scriptFiles: [script],
    scriptMatches: [{ file: script, isAlt: false, altName: '' }],
    thumbnailUrl: null,
    duration: durationMs / 1000,
    scriptType: 'single',
    starred: false,
  }
}

function fillLibrary(n = 10) {
  records.clear()
  useLibraryStore().videos = Array.from({ length: n }, (_, i) =>
    indexed(`v${i}`, [0.1 + i * 0.02, 0.35 + i * 0.02, 0.6 + i * 0.02, 0.85 + i * 0.01]))
}

const seconds = (s: number) => vi.advanceTimersByTime(s * 1000)

/** Long enough for a reel of several clips. */
const long = () => programme({ phases: [newPhase('warmup', { minutes: 6, from: 0.1, to: 0.4 }), newPhase('peak', { minutes: 6, from: 0.6, to: 0.9 })] })

function reset() {
  vi.useFakeTimers()
  localStorage.clear()
  setActivePinia(createPinia())
  steer.value = null
  engineRunning = false
  canDrive.value = false
  listeners.clear()
  applyPhase.mockClear()
  next.mockClear()
  playAt.mockClear()
  playback.takeover = null
  playback.trackSeq = 0
  records.clear()
  const audio = useAudioStore()
  audio.sessionActive.value = false
  audio.intensity.value = 0.5
  audio.phase.value = 'idle'
}

describe('programme runtime', () => {
  beforeEach(reset)

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

  it('falls back to whole videos while the chapter pool is too small', () => {
    const prog = useProgrammeStore()
    prog.start(programme())
    expect(prog.mode).toBe('videos')
    expect(playAt).not.toHaveBeenCalled()
    expect(playback.takeover).toBeNull()
  })
})

describe('highlight reel', () => {
  beforeEach(() => {
    reset()
    fillLibrary()
    const player = usePlayerStore()
    player.videoUrl = 'blob:x'
    player.isPlaying = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Pretend the player reached video time `t`. */
  async function at(t: number) {
    usePlayerStore().currentTime = t
    await nextTick()
  }

  it('plans clips that follow the arc and plays the first one', () => {
    const prog = useProgrammeStore()
    prog.start(programme({ phases: [newPhase('warmup', { minutes: 3, from: 0.1, to: 0.2 }), newPhase('peak', { minutes: 3, from: 0.8, to: 0.9 })] }))
    expect(prog.mode).toBe('reel')
    expect(prog.reel.length).toBeGreaterThan(1)
    const first = prog.reel[0]
    expect(playAt).toHaveBeenCalledTimes(1)
    expect(playAt.mock.calls[0][0].name).toBe(first.video)
    expect(playAt.mock.calls[0][1]).toBe(first.start)
    expect(steer.value).toBeNull()
    expect(playback.takeover?.label).toBe('Programme')
    // Warm-up clips are gentler than peak ones.
    const mean = (cs: typeof prog.reel) => cs.reduce((n, c) => n + c.intensity, 0) / cs.length
    expect(mean(prog.reel.filter(c => c.at < 180))).toBeLessThan(mean(prog.reel.filter(c => c.at >= 180)) - 0.4)
  })

  it('switches to the next clip when this one reaches its end', async () => {
    const prog = useProgrammeStore()
    prog.start(programme())
    const first = prog.reel[0]
    await at(first.start + 1)
    expect(prog.clipIndex).toBe(0)
    await at(first.end - 1.5)
    // Inside the last two seconds a timer makes the cut land exactly.
    vi.advanceTimersByTime(1600)
    await nextTick()
    expect(playAt).toHaveBeenCalledTimes(2)
    expect(prog.clipIndex).toBe(1)
    expect(playAt.mock.calls[1][0].name).toBe(prog.reel[1].video)
  })

  it('takes over Next, and hands it back when the run ends', async () => {
    const prog = useProgrammeStore()
    prog.start(programme())
    await at(prog.reel[0].start + 1)
    await playback.takeover!.next()
    expect(prog.clipIndex).toBe(1)
    prog.halt()
    expect(playback.takeover).toBeNull()
  })

  it('stretches the current clip on request and moves the rest along', async () => {
    const prog = useProgrammeStore()
    prog.start(programme({ clipSec: [20, 40] }))
    const first = prog.reel[0]
    await at(first.start + 1)
    prog.keepLonger(60)
    expect(prog.reel[0].end).toBeGreaterThan(first.end + 30)
    expect(prog.reel[1].at).toBeGreaterThan(prog.reel[0].at + 40)
  })

  it('skips a planned clip and fills its slot with another', () => {
    const prog = useProgrammeStore()
    prog.start(long())
    const victim = prog.reel[2]
    prog.skipClip(victim.id)
    expect(prog.reel.some(c => c.key === victim.key)).toBe(false)
    expect(prog.reel[2].at).toBeCloseTo(victim.at, 0)
  })

  it('locks a clip so a reshuffle keeps it', () => {
    const prog = useProgrammeStore()
    prog.start(long())
    const keep = prog.reel[2]
    prog.toggleLock(keep.id)
    prog.regenerate()
    expect(prog.reel.find(c => c.id === keep.id)?.locked).toBe(true)
  })

  it('previews the selected programme before it starts, and starts with that plan', () => {
    const prog = useProgrammeStore()
    prog.planPreview()
    expect(prog.canReel).toBe(true)
    expect(prog.reel.length).toBeGreaterThan(3)
    const planned = prog.reel.map(c => c.key)
    prog.start()
    expect(prog.reel.map(c => c.key)).toEqual(planned)
  })

  it('lets the user wander off and come back with Next', async () => {
    const prog = useProgrammeStore()
    prog.start(programme())
    await at(prog.reel[0].start + 1)
    playback.trackSeq++
    await nextTick()
    expect(prog.offReel).toBe(true)
    await prog.nextClip()
    expect(prog.offReel).toBe(false)
  })

  it('counts a real edge in an edged phase: the pass ends and the reel cuts to calmer clips', async () => {
    const prog = useProgrammeStore()
    const control = useSessionControlStore()
    prog.start(programme({ phases: [newPhase('peak', { minutes: 10, from: 0.5, to: 0.9, edges: 3 })] }))
    seconds(100)
    const playing = prog.currentClip!
    await at(playing.start + 1)
    control.edge('key')
    await nextTick()
    expect(prog.liveEdges[0]?.at).toHaveLength(1)
    expect(prog.edgeState?.kind).toBe('retreat')
    // The clip playing now ends within a few seconds, and what follows is calmer.
    expect(prog.reel[prog.clipIndex].end).toBeLessThan(playing.start + 1 + 5)
    expect(prog.reel[prog.clipIndex + 1].target).toBeLessThan(0.6)
  })

  it('retreats on its own when nobody edges, and tells everything else to back off', () => {
    const prog = useProgrammeStore()
    const control = useSessionControlStore()
    prog.start(programme({ phases: [newPhase('peak', { minutes: 10, from: 0.5, to: 0.9, edges: 3 })] }))
    // Rise 120 s + planned hold 40 s + the wait for a real edge.
    seconds(120 + 40 + 125)
    expect(prog.liveEdges[0]?.at).toHaveLength(1)
    expect(control.edges.at(-1)?.source).toBe('programme')
  })

  it('holds the clock through an edge in a plain phase', () => {
    const prog = useProgrammeStore()
    const control = useSessionControlStore()
    prog.start(programme())
    seconds(10)
    control.edge('key')
    const held = prog.elapsed
    seconds(5)
    expect(prog.elapsed).toBeCloseTo(held, 0)
  })
})
