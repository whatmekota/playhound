import type { VideoEntry } from './libraryStore'
/**
 * Queue store — manages the current playback queue.
 *
 * The queue is set when the user picks a video from the library or a playlist.
 * It holds the full ordered list of VideoEntry items that were visible at that
 * moment (respecting the active sort / filter / playlist), plus the current
 * index, repeat mode and shuffle state.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type RepeatMode = 'off' | 'one' | 'all'

// Legacy storage key kept so existing data survives the rename.
const LS_KEY = 'mwhoplayer:queue'
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') }
  catch { return {} }
}

export const useQueueStore = defineStore('queue', () => {
  const prefs = loadPrefs()

  const queue = ref<VideoEntry[]>([])
  const currentIdx = ref(-1)
  const repeatMode = ref<RepeatMode>(prefs.repeat ?? 'off')
  const shuffle = ref<boolean>(prefs.shuffle ?? false)
  /** Shuffled index order (indices into queue), rebuilt when shuffle is toggled on */
  const shuffleOrder = ref<number[]>([])

  // ── Persist prefs ─────────────────────────────────────────────────────────
  function savePrefs() {
    localStorage.setItem(LS_KEY, JSON.stringify({ repeat: repeatMode.value, shuffle: shuffle.value }))
  }

  function setRepeat(mode: RepeatMode) {
    repeatMode.value = mode
    savePrefs()
  }

  function setShuffle(on: boolean) {
    shuffle.value = on
    if (on)
      buildShuffleOrder()
    savePrefs()
  }

  function buildShuffleOrder() {
    const order = queue.value.map((_, i) => i).filter(i => i !== currentIdx.value)
    // Fisher-Yates
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    // Put current first so we know where we are
    shuffleOrder.value = [currentIdx.value, ...order]
  }

  // ── Set queue from a list + starting video ────────────────────────────────
  function setQueue(entries: VideoEntry[], startEntry: VideoEntry) {
    queue.value = entries
    const idx = entries.findIndex(e => e.name === startEntry.name)
    currentIdx.value = idx >= 0 ? idx : 0
    if (shuffle.value)
      buildShuffleOrder()
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  const current = computed(() =>
    currentIdx.value >= 0 ? queue.value[currentIdx.value] ?? null : null,
  )

  /** Returns the next VideoEntry to play, or null if nothing follows */
  function peekNext(): VideoEntry | null {
    if (!queue.value.length)
      return null
    if (repeatMode.value === 'one')
      return queue.value[currentIdx.value] ?? null

    if (shuffle.value && shuffleOrder.value.length) {
      const pos = shuffleOrder.value.indexOf(currentIdx.value)
      const nextPos = pos + 1
      if (nextPos < shuffleOrder.value.length) {
        return queue.value[shuffleOrder.value[nextPos]] ?? null
      }
      // Reached end of shuffle order
      if (repeatMode.value === 'all') {
        buildShuffleOrder()
        return queue.value[shuffleOrder.value[1]] ?? null // [0] is current
      }
      return null
    }

    const next = currentIdx.value + 1
    if (next < queue.value.length)
      return queue.value[next] ?? null
    if (repeatMode.value === 'all')
      return queue.value[0] ?? null
    return null
  }

  function peekPrev(): VideoEntry | null {
    if (!queue.value.length)
      return null
    if (repeatMode.value === 'one')
      return queue.value[currentIdx.value] ?? null

    if (shuffle.value && shuffleOrder.value.length) {
      const pos = shuffleOrder.value.indexOf(currentIdx.value)
      const prevPos = pos - 1
      if (prevPos >= 0)
        return queue.value[shuffleOrder.value[prevPos]] ?? null
      if (repeatMode.value === 'all') {
        return queue.value[shuffleOrder.value[shuffleOrder.value.length - 1]] ?? null
      }
      return null
    }

    const prev = currentIdx.value - 1
    if (prev >= 0)
      return queue.value[prev] ?? null
    if (repeatMode.value === 'all')
      return queue.value[queue.value.length - 1] ?? null
    return null
  }

  /** Advance to next and return it */
  function next(): VideoEntry | null {
    const entry = peekNext()
    if (!entry)
      return null
    currentIdx.value = queue.value.indexOf(entry)
    // The shuffle order is deliberately left alone. It used to be rotated so
    // the current item sat at the head, which destroyed the history behind it:
    // peekPrev then computed position 0 minus 1 and always returned null, so
    // "previous" could never work while shuffled. Position is found by lookup
    // anyway, so nothing needs moving.
    return entry
  }

  function prev(): VideoEntry | null {
    const entry = peekPrev()
    if (!entry)
      return null
    currentIdx.value = queue.value.indexOf(entry)
    return entry
  }

  const hasNext = computed(() => peekNext() !== null)
  const hasPrev = computed(() => peekPrev() !== null)

  return {
    queue,
    currentIdx,
    repeatMode,
    shuffle,
    current,
    hasNext,
    hasPrev,
    setQueue,
    next,
    prev,
    peekNext,
    peekPrev,
    setRepeat,
    setShuffle,
  }
})
