import type { VideoEntry } from '../src/stores/libraryStore'
import type { PlayerControls } from '../src/stores/playbackStore'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// Script parsing and the director read files and IndexedDB; neither matters to
// the navigation rules under test.
const directorPick = ref<VideoEntry | null>(null)
const directorOn = ref(false)
vi.mock('~/composables/useFunscript', () => ({
  useFunscript: () => ({
    autoDetectFromFiles: vi.fn(async () => []),
    lastRawMetadata: ref(null),
  }),
}))
vi.mock('~/composables/useAutoDirector', () => ({
  useAutoDirector: () => ({
    enabled: directorOn,
    pickNext: () => directorPick.value,
    summarise: vi.fn(async () => null),
  }),
}))

const { usePlaybackStore } = await import('../src/stores/playbackStore')
const { usePlayerStore } = await import('../src/stores/playerStore')
const { useQueueStore } = await import('../src/stores/queueStore')
const { useLibraryStore } = await import('../src/stores/libraryStore')

function entry(name: string): VideoEntry {
  return {
    file: new File(['x'], name),
    name,
    basename: name.replace(/\.[^.]+$/, ''),
    hasScript: true,
    scriptCount: 1,
    altCount: 0,
    scriptFiles: [],
    scriptMatches: [],
    thumbnailUrl: null,
    duration: null,
    scriptType: 'single',
    starred: false,
  }
}

const LIB = ['a', 'b', 'c'].map(n => entry(`${n}.mp4`))

function controls(): PlayerControls & Record<string, ReturnType<typeof vi.fn>> {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    togglePlay: vi.fn(),
    seek: vi.fn(),
    seekRelative: vi.fn(),
    setSpeed: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    toggleFullscreen: vi.fn(),
  } as any
}

describe('playbackStore', () => {
  let c: ReturnType<typeof controls>

  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    directorOn.value = false
    directorPick.value = null
    globalThis.URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`)
    globalThis.URL.revokeObjectURL = vi.fn()
    c = controls()
    usePlaybackStore().bindPlayer(c)
    useQueueStore().setShuffle(false)
    useQueueStore().setRepeat('off')
    useLibraryStore().videos = LIB
  })

  it('playing with a context builds the queue from it', async () => {
    const pb = usePlaybackStore()
    await pb.play(LIB[1], LIB, 'Library')
    expect(useQueueStore().current?.name).toBe('b.mp4')
    expect(usePlayerStore().videoPath).toBe('b.mp4')
    expect(pb.currentEntry?.name).toBe('b.mp4')
  })

  it('autoplays once the new video reports its duration', async () => {
    const pb = usePlaybackStore()
    await pb.play(LIB[0], LIB)
    expect(c.play).not.toHaveBeenCalled()
    usePlayerStore().videoDuration = 30
    await Promise.resolve()
    expect(c.play).toHaveBeenCalledOnce()
  })

  it('next and prev move through the queue', async () => {
    const pb = usePlaybackStore()
    await pb.play(LIB[0], LIB)
    await pb.next()
    expect(usePlayerStore().videoPath).toBe('b.mp4')
    await pb.prev()
    expect(usePlayerStore().videoPath).toBe('a.mp4')
  })

  it('previous restarts the current video when a few seconds in', async () => {
    const pb = usePlaybackStore()
    await pb.play(LIB[0], LIB)
    await pb.next()
    usePlayerStore().currentTime = 12
    await pb.prev()
    expect(c.seek).toHaveBeenCalledWith(0)
    expect(usePlayerStore().videoPath).toBe('b.mp4')
  })

  it('next at the end of the queue stays put and reports it', async () => {
    const pb = usePlaybackStore()
    await pb.play(LIB[2], LIB)
    expect(await pb.next()).toBe(false)
    expect(usePlayerStore().videoPath).toBe('c.mp4')
  })

  it('repeat-one loops the video on end instead of advancing', async () => {
    const pb = usePlaybackStore()
    await pb.play(LIB[0], LIB)
    useQueueStore().setRepeat('one')
    await pb.onEnded()
    expect(c.seek).toHaveBeenCalledWith(0)
    expect(c.play).toHaveBeenCalled()
    expect(usePlayerStore().videoPath).toBe('a.mp4')
  })

  it('the director picks next when it is on, and history still works', async () => {
    const pb = usePlaybackStore()
    await pb.play(LIB[0], LIB)
    directorOn.value = true
    directorPick.value = LIB[2]
    await pb.next()
    expect(usePlayerStore().videoPath).toBe('c.mp4')
    directorOn.value = false
    await pb.prev()
    expect(usePlayerStore().videoPath).toBe('a.mp4')
  })

  it('a loose file that is in the library plays as that entry', async () => {
    const pb = usePlaybackStore()
    await pb.playFile(LIB[1].file)
    expect(pb.currentEntry?.name).toBe('b.mp4')
    expect(useQueueStore().current?.name).toBe('b.mp4')
  })

  it('random never picks what is already playing', async () => {
    const pb = usePlaybackStore()
    await pb.play(LIB[0], LIB)
    for (let i = 0; i < 20; i++) {
      const before = usePlayerStore().videoPath
      await pb.random()
      expect(usePlayerStore().videoPath).not.toBe(before)
    }
  })
})
