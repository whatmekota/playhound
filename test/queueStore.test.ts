import type { VideoEntry } from '../src/stores/libraryStore'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadSavedQueue, useQueueStore } from '../src/stores/queueStore'

function entry(name: string): VideoEntry {
  return {
    file: new File([], name),
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

const names = (list: { name: string }[] | VideoEntry[]) => list.map(e => e.name)
const LIB = ['a', 'b', 'c', 'd', 'e', 'f'].map(n => entry(`${n}.mp4`))

describe('queueStore', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  function fresh() {
    const q = useQueueStore()
    q.setShuffle(false)
    q.setRepeat('off')
    return q
  }

  it('starts at the chosen entry with the rest of the list around it', () => {
    const q = fresh()
    q.setQueue(LIB, LIB[2], 'Library')
    expect(q.current?.name).toBe('c.mp4')
    expect(names(q.history.map(i => i.entry))).toEqual(['a.mp4', 'b.mp4'])
    expect(names(q.upcoming.map(i => i.entry))).toEqual(['d.mp4', 'e.mp4', 'f.mp4'])
    expect(q.sourceLabel).toBe('Library')
  })

  it('walks forward and back, and stops at both ends', () => {
    const q = fresh()
    q.setQueue(LIB, LIB[0])
    expect(q.hasPrev).toBe(false)
    expect(q.prev()).toBeNull()
    for (const n of ['b', 'c', 'd', 'e', 'f'])
      expect(q.next()?.name).toBe(`${n}.mp4`)
    expect(q.hasNext).toBe(false)
    expect(q.next()).toBeNull()
    expect(q.current?.name).toBe('f.mp4')
    expect(q.prev()?.name).toBe('e.mp4')
  })

  it('shuffling keeps history and the current item, and only reorders what is ahead', () => {
    const q = fresh()
    q.setQueue(LIB, LIB[0])
    q.next()
    q.next() // on c, history a b
    q.setShuffle(true)
    expect(q.current?.name).toBe('c.mp4')
    expect(names(q.history.map(i => i.entry))).toEqual(['a.mp4', 'b.mp4'])
    expect(names(q.upcoming.map(i => i.entry)).sort()).toEqual(['d.mp4', 'e.mp4', 'f.mp4'])
  })

  it('previous under shuffle returns to what actually played', () => {
    const q = fresh()
    q.setShuffle(true)
    q.setQueue(LIB, LIB[3])
    const played = [q.current!.name]
    played.push(q.next()!.name)
    played.push(q.next()!.name)
    expect(q.prev()?.name).toBe(played[1])
    expect(q.prev()?.name).toBe(played[0])
    expect(q.prev()).toBeNull()
  })

  it('un-shuffling restores source order after the current item', () => {
    const q = fresh()
    q.setShuffle(true)
    q.setQueue(LIB, LIB[2])
    q.setShuffle(false)
    expect(q.current?.name).toBe('c.mp4')
    // What came after c in the source first, then what came before it.
    expect(names(q.upcoming.map(i => i.entry))).toEqual(['d.mp4', 'e.mp4', 'f.mp4', 'a.mp4', 'b.mp4'])
  })

  it('play next inserts right after the current item; add to queue appends', () => {
    const q = fresh()
    q.setQueue(LIB.slice(0, 3), LIB[0])
    q.playNext(entry('x.mp4'))
    q.enqueue(entry('y.mp4'))
    expect(names(q.upcoming.map(i => i.entry))).toEqual(['x.mp4', 'b.mp4', 'c.mp4', 'y.mp4'])
    expect(q.upcoming[0].manual).toBe(true)
    expect(q.next()?.name).toBe('x.mp4')
  })

  it('keeps hand-queued items at the front when shuffle is turned on', () => {
    const q = fresh()
    q.setQueue(LIB, LIB[0])
    q.playNext([entry('x.mp4'), entry('y.mp4')])
    q.setShuffle(true)
    expect(names(q.upcoming.slice(0, 2).map(i => i.entry))).toEqual(['x.mp4', 'y.mp4'])
  })

  it('play now slots in after the current item without losing the queue', () => {
    const q = fresh()
    q.setQueue(LIB.slice(0, 3), LIB[0])
    expect(q.playNow(entry('z.mp4')).name).toBe('z.mp4')
    expect(q.current?.name).toBe('z.mp4')
    expect(q.prev()?.name).toBe('a.mp4')
    q.next()
    expect(names(q.upcoming.map(i => i.entry))).toEqual(['b.mp4', 'c.mp4'])
  })

  it('play now on an empty queue starts one', () => {
    const q = fresh()
    q.playNow(LIB[1])
    expect(q.current?.name).toBe('b.mp4')
    expect(q.length).toBe(1)
  })

  it('repeat-all starts another pass at the end, never repeating back to back', () => {
    const q = fresh()
    q.setRepeat('all')
    q.setQueue(LIB.slice(0, 3), LIB[0])
    q.next()
    q.next() // on c, the end
    expect(q.hasNext).toBe(true)
    expect(q.next()?.name).toBe('a.mp4')
    // History still reads back across the seam.
    expect(q.prev()?.name).toBe('c.mp4')
  })

  it('repeat-all with shuffle reshuffles the next pass and avoids an immediate repeat', () => {
    const q = fresh()
    q.setRepeat('all')
    q.setShuffle(true)
    const two = LIB.slice(0, 2)
    for (let trial = 0; trial < 25; trial++) {
      q.setQueue(two, two[0])
      q.next()
      const last = q.current!.name
      expect(q.next()?.name).not.toBe(last)
    }
  })

  it('removing an item keeps the current one in place', () => {
    const q = fresh()
    q.setQueue(LIB, LIB[2])
    const before = q.history[0].uid
    q.remove(before)
    expect(q.current?.name).toBe('c.mp4')
    expect(q.history).toHaveLength(1)
    // The current item cannot be removed.
    q.remove(q.currentItem!.uid)
    expect(q.current?.name).toBe('c.mp4')
  })

  it('reorders what is ahead', () => {
    const q = fresh()
    q.setQueue(LIB.slice(0, 4), LIB[0])
    q.moveUpcoming(2, 0)
    expect(names(q.upcoming.map(i => i.entry))).toEqual(['d.mp4', 'b.mp4', 'c.mp4'])
    q.moveUpcoming(0, 9) // out of range: ignored
    expect(names(q.upcoming.map(i => i.entry))).toEqual(['d.mp4', 'b.mp4', 'c.mp4'])
  })

  it('jumps by uid, and by entry prefers the copy ahead', () => {
    const q = fresh()
    q.setQueue(LIB.slice(0, 3), LIB[1])
    q.enqueue(LIB[0]) // a appears in history and ahead
    expect(q.jumpTo(LIB[0])?.name).toBe('a.mp4')
    expect(q.pos).toBe(3)
    const uid = q.order[0].uid
    q.jumpTo(uid)
    expect(q.pos).toBe(0)
  })

  it('clears what is ahead or behind', () => {
    const q = fresh()
    q.setQueue(LIB, LIB[2])
    q.clearUpcoming()
    expect(q.upcoming).toHaveLength(0)
    q.clearHistory()
    expect(q.history).toHaveLength(0)
    expect(q.current?.name).toBe('c.mp4')
  })

  it('snapshots by name and restores against the library', () => {
    const q = fresh()
    q.setQueue(LIB, LIB[2], 'Library')
    q.snapshot(42)
    const saved = loadSavedQueue()!
    expect(saved.time).toBe(42)

    setActivePinia(createPinia())
    const r = useQueueStore()
    // One video has gone from the library since; the rest still lines up.
    const lib = LIB.filter(e => e.name !== 'e.mp4')
    expect(r.restore(saved, lib)?.name).toBe('c.mp4')
    expect(names(r.upcoming.map(i => i.entry))).toEqual(['d.mp4', 'f.mp4'])
    expect(r.sourceLabel).toBe('Library')
  })

  it('cycles repeat off → all → one → off and remembers modes', () => {
    const q = fresh()
    q.cycleRepeat()
    expect(q.repeatMode).toBe('all')
    q.cycleRepeat()
    expect(q.repeatMode).toBe('one')
    q.setShuffle(true)
    setActivePinia(createPinia())
    const again = useQueueStore()
    expect(again.repeatMode).toBe('one')
    expect(again.shuffle).toBe(true)
  })
})
