import type { VideoEntry } from './libraryStore'
/**
 * Queue store — what is playing, what has played, and what plays next.
 *
 * The model is a single play order: `order` holds every queued entry in the
 * sequence it will be (or was) played, and `pos` points at the current one.
 * Everything before `pos` is history, everything after it is up next. That one
 * list is what makes prev/next behave the same whether shuffle is on or off:
 *
 * - shuffling only reorders what is *after* `pos`, so history survives and
 *   "previous" always walks back through what actually played
 * - un-shuffling restores the source order of the remaining items and keeps
 *   the current one where it is
 * - "play next" and "add to queue" insert into the same list, so the up-next
 *   strip, the queue panel and the transport never disagree
 *
 * `source` keeps the list the queue was started from (the library as sorted
 * and filtered at that moment, or a playlist), so un-shuffle and repeat-all
 * have something to return to.
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

export type RepeatMode = 'off' | 'one' | 'all'

export interface QueueItem {
  /** Unique per insertion, so the same video can sit in the queue twice. */
  uid: number
  entry: VideoEntry
  /** Added by hand (play next / add to queue) rather than from the source list. */
  manual: boolean
}

// Legacy storage key kept so existing data survives the rename.
const LS_KEY = 'ph:queue.prefs'
/** Names only; the files themselves have to come back from the library. */
const LS_SESSION = 'ph:queue.session'

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') }
  catch { return {} }
}

export interface SavedQueue {
  names: string[]
  pos: number
  sourceLabel: string
  time: number
}

export function loadSavedQueue(): SavedQueue | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_SESSION) ?? 'null')
    return raw && Array.isArray(raw.names) ? raw : null
  }
  catch { return null }
}

let uidSeq = 1

function shuffled<T>(list: T[]): T[] {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export const useQueueStore = defineStore('queue', () => {
  const prefs = loadPrefs()

  const order = ref<QueueItem[]>([])
  const pos = ref(-1)
  const source = ref<VideoEntry[]>([])
  /** Where the queue came from, for the queue panel header ("Library", a playlist name…). */
  const sourceLabel = ref('')
  const repeatMode = ref<RepeatMode>(prefs.repeat === 'one' || prefs.repeat === 'all' ? prefs.repeat : 'off')
  const shuffle = ref<boolean>(prefs.shuffle ?? false)

  function savePrefs() {
    localStorage.setItem(LS_KEY, JSON.stringify({ repeat: repeatMode.value, shuffle: shuffle.value }))
  }

  function item(entry: VideoEntry, manual = false): QueueItem {
    return { uid: uidSeq++, entry, manual }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const currentItem = computed(() => order.value[pos.value] ?? null)
  const current = computed(() => currentItem.value?.entry ?? null)
  const history = computed(() => (pos.value > 0 ? order.value.slice(0, pos.value) : []))
  const upcoming = computed(() => order.value.slice(pos.value + 1))
  const length = computed(() => order.value.length)

  // Kept for the existing callers; index mirrors pos.
  const currentIdx = pos
  const queue = computed(() => order.value.map(i => i.entry))

  // ── Building ──────────────────────────────────────────────────────────────
  /**
   * Start a new queue from `entries`, playing `start`.
   * With shuffle on, history is empty and everything else is shuffled behind
   * the starting item.
   */
  function setQueue(entries: VideoEntry[], start: VideoEntry, label = '') {
    source.value = entries.slice()
    sourceLabel.value = label
    let startIdx = entries.findIndex(e => e.name === start.name)
    const list = entries.slice()
    if (startIdx < 0) {
      list.unshift(start)
      startIdx = 0
    }
    if (shuffle.value) {
      const rest = list.filter((_, i) => i !== startIdx)
      order.value = [item(list[startIdx]), ...shuffled(rest).map(e => item(e))]
      pos.value = 0
    }
    else {
      order.value = list.map(e => item(e))
      pos.value = startIdx
    }
  }

  /** Play this entry right now, keeping the rest of the queue intact. */
  function playNow(entry: VideoEntry): VideoEntry {
    if (!order.value.length) {
      setQueue([entry], entry)
      return entry
    }
    // Already the very next item? Just step onto it.
    if (order.value[pos.value + 1]?.entry.name === entry.name) {
      pos.value++
      return entry
    }
    order.value.splice(pos.value + 1, 0, item(entry, true))
    pos.value++
    return entry
  }

  /** Insert after the current item. */
  function playNext(entries: VideoEntry | VideoEntry[]) {
    const list = Array.isArray(entries) ? entries : [entries]
    if (!list.length)
      return
    if (!order.value.length) {
      order.value = list.map(e => item(e, true))
      pos.value = -1
      return
    }
    order.value.splice(pos.value + 1, 0, ...list.map(e => item(e, true)))
  }

  /** Append to the end of the queue. */
  function enqueue(entries: VideoEntry | VideoEntry[]) {
    const list = Array.isArray(entries) ? entries : [entries]
    if (!list.length)
      return
    order.value.push(...list.map(e => item(e, true)))
  }

  function remove(uid: number) {
    const i = order.value.findIndex(q => q.uid === uid)
    if (i < 0 || i === pos.value)
      return
    order.value.splice(i, 1)
    if (i < pos.value)
      pos.value--
  }

  /** Move an upcoming item to a new upcoming slot (indices into `upcoming`). */
  function moveUpcoming(from: number, to: number) {
    const base = pos.value + 1
    const len = upcoming.value.length
    if (from < 0 || from >= len || to < 0 || to >= len || from === to)
      return
    const [it] = order.value.splice(base + from, 1)
    order.value.splice(base + to, 0, it)
  }

  function clearUpcoming() {
    order.value.splice(pos.value + 1)
  }

  function clearHistory() {
    if (pos.value <= 0)
      return
    order.value.splice(0, pos.value)
    pos.value = 0
  }

  function clear() {
    order.value = []
    pos.value = -1
    source.value = []
    sourceLabel.value = ''
  }

  // ── Modes ─────────────────────────────────────────────────────────────────
  function setRepeat(mode: RepeatMode) {
    repeatMode.value = mode
    savePrefs()
  }

  /** Off → all → one → off, the order people expect from a player. */
  function cycleRepeat() {
    setRepeat(repeatMode.value === 'off' ? 'all' : repeatMode.value === 'all' ? 'one' : 'off')
  }

  function setShuffle(on: boolean) {
    if (shuffle.value === on)
      return
    shuffle.value = on
    savePrefs()
    if (pos.value < 0 && !order.value.length)
      return

    const head = order.value.slice(0, pos.value + 1)
    const rest = order.value.slice(pos.value + 1)
    if (on) {
      // Hand-queued items keep their place at the front; they were asked for.
      const manual = rest.filter(q => q.manual)
      const auto = rest.filter(q => !q.manual)
      order.value = [...head, ...manual, ...shuffled(auto)]
    }
    else {
      // Restore source order for what is left, after anything queued by hand.
      const manual = rest.filter(q => q.manual)
      const restNames = new Set(rest.filter(q => !q.manual).map(q => q.entry.name))
      const cur = current.value
      const curIdx = cur ? source.value.findIndex(e => e.name === cur.name) : -1
      const after = curIdx >= 0 ? source.value.slice(curIdx + 1) : source.value
      const ordered = after.filter(e => restNames.has(e.name))
      // Anything that was already before the current item in the source list
      // stays queued, behind the rest, rather than silently disappearing.
      const tail = source.value.slice(0, Math.max(0, curIdx)).filter(e => restNames.has(e.name))
      const byName = new Map(rest.map(q => [q.entry.name, q]))
      order.value = [...head, ...manual, ...[...ordered, ...tail].map(e => byName.get(e.name)!).filter(Boolean)]
    }
  }

  function toggleShuffle() {
    setShuffle(!shuffle.value)
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  /** The entry `next()` would land on, without moving. Repeat-one is the caller's business. */
  function peekNext(): VideoEntry | null {
    if (!order.value.length)
      return null
    if (pos.value + 1 < order.value.length)
      return order.value[pos.value + 1].entry
    if (repeatMode.value === 'all' && source.value.length)
      return shuffle.value ? null : source.value[0] ?? null
    return null
  }

  function peekPrev(): VideoEntry | null {
    if (pos.value > 0)
      return order.value[pos.value - 1].entry
    return null
  }

  /** The next `count` entries, for the up-next strip. */
  function peekUpcoming(count = 4): VideoEntry[] {
    return upcoming.value.slice(0, count).map(q => q.entry)
  }

  /**
   * Step forward. At the end, repeat-all starts a fresh pass over the source
   * list (reshuffled when shuffle is on), appended so history still reads back.
   */
  function next(): VideoEntry | null {
    if (pos.value + 1 < order.value.length) {
      pos.value++
      return current.value
    }
    if (repeatMode.value === 'all' && source.value.length) {
      const pass = shuffle.value ? shuffled(source.value) : source.value.slice()
      // Never repeat the same video back to back across the seam.
      if (pass.length > 1 && pass[0].name === current.value?.name)
        pass.push(pass.shift()!)
      order.value.push(...pass.map(e => item(e)))
      // History would otherwise grow without bound over a long session.
      if (pos.value > 500) {
        order.value.splice(0, pos.value - 200)
        pos.value = 200
      }
      pos.value++
      return current.value
    }
    return null
  }

  function prev(): VideoEntry | null {
    if (pos.value > 0) {
      pos.value--
      return current.value
    }
    return null
  }

  /** Jump to an item already in the queue, by uid or by entry. */
  function jumpTo(target: VideoEntry | number): VideoEntry | null {
    let idx: number
    if (typeof target === 'number') {
      idx = order.value.findIndex(q => q.uid === target)
    }
    else {
      // Prefer the upcoming copy, so jumping ahead does not rewind into history.
      idx = order.value.findIndex((q, i) => i > pos.value && q.entry.name === target.name)
      if (idx < 0)
        idx = order.value.findIndex(q => q.entry.name === target.name)
    }
    if (idx < 0)
      return null
    pos.value = idx
    return current.value
  }

  const hasNext = computed(() =>
    pos.value + 1 < order.value.length || (repeatMode.value === 'all' && source.value.length > 0))
  const hasPrev = computed(() => pos.value > 0)

  // ── Session persistence ───────────────────────────────────────────────────
  /** Remember the queue by name so it can be rebuilt once the library is back. */
  let lastTime = 0
  function snapshot(time?: number) {
    if (time !== undefined)
      lastTime = time
    if (!order.value.length) {
      localStorage.removeItem(LS_SESSION)
      return
    }
    // Keep it small: a little history, the current item, and what follows.
    const start = Math.max(0, pos.value - 20)
    const slice = order.value.slice(start, start + 500)
    const saved: SavedQueue = {
      names: slice.map(q => q.entry.name),
      pos: pos.value - start,
      sourceLabel: sourceLabel.value,
      time: lastTime,
    }
    localStorage.setItem(LS_SESSION, JSON.stringify(saved))
  }

  /** Rebuild from a snapshot against the library's current entries. */
  function restore(saved: SavedQueue, library: VideoEntry[]): VideoEntry | null {
    const byName = new Map(library.map(v => [v.name, v]))
    const items: QueueItem[] = []
    let newPos = -1
    saved.names.forEach((n, i) => {
      const e = byName.get(n)
      if (!e)
        return
      if (i === saved.pos)
        newPos = items.length
      items.push(item(e))
    })
    if (!items.length || newPos < 0)
      return null
    order.value = items
    pos.value = newPos
    source.value = items.map(q => q.entry)
    sourceLabel.value = saved.sourceLabel
    return current.value
  }

  watch([() => order.value.map(q => q.uid).join(','), pos], () => snapshot())

  return {
    order,
    pos,
    source,
    sourceLabel,
    repeatMode,
    shuffle,
    currentItem,
    current,
    history,
    upcoming,
    length,
    queue,
    currentIdx,
    hasNext,
    hasPrev,
    setQueue,
    playNow,
    playNext,
    enqueue,
    remove,
    moveUpcoming,
    clearUpcoming,
    clearHistory,
    clear,
    setRepeat,
    cycleRepeat,
    setShuffle,
    toggleShuffle,
    peekNext,
    peekPrev,
    peekUpcoming,
    next,
    prev,
    jumpTo,
    snapshot,
    restore,
  }
})
