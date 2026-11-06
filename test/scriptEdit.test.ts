import type { Pt } from '../src/lib/scriptEdit'
import { describe, expect, it } from 'vitest'
import {
  applyPatch,
  cleanSelection,
  combineSelection,
  deletePoints,
  diffPoints,
  dragSelection,
  EditHistory,
  fastSegments,
  hitTest,
  insertPoint,
  lowerBound,
  moveLimits,
  moveSelection,
  positionAt,
  segmentSpeed,
  selectInBox,
  snapPos,
  snapTime,
} from '../src/lib/scriptEdit'

/** 0, 100, 0, 100… every 500 ms. */
const zigzag = (n: number): Pt[] => Array.from({ length: n }, (_, i) => ({ at: i * 500, pos: i % 2 ? 1 : 0 }))

const isSorted = (p: Pt[]) => p.every((x, i) => i === 0 || p[i - 1].at < x.at)

describe('lookup', () => {
  it('finds the first point at or after a time', () => {
    const p = zigzag(5)
    expect(lowerBound(p, -1)).toBe(0)
    expect(lowerBound(p, 500)).toBe(1)
    expect(lowerBound(p, 501)).toBe(2)
    expect(lowerBound(p, 99999)).toBe(5)
  })

  it('interpolates like a device plays', () => {
    const p = zigzag(3)
    expect(positionAt(p, 250)).toBeCloseTo(0.5)
    expect(positionAt(p, -10)).toBe(0)
    expect(positionAt(p, 5000)).toBe(0)
    expect(positionAt([], 10)).toBe(0.5)
  })
})

describe('selection', () => {
  it('box-selects by time and position, corners in any order', () => {
    const p = zigzag(10)
    // 600–2100 ms holds points 2, 3, 4; only the tops (pos 1) are 3.
    expect(selectInBox(p, 600, 2100, 0, 1)).toEqual([2, 3, 4])
    expect(selectInBox(p, 2100, 600, 1, 0.9)).toEqual([3])
    expect(selectInBox(p, 0, 0, 0, 0)).toEqual([0])
  })

  it('replaces, adds or toggles', () => {
    expect(combineSelection([1, 2], [5, 3], 'replace')).toEqual([3, 5])
    expect(combineSelection([1, 2], [2, 3], 'add')).toEqual([1, 2, 3])
    expect(combineSelection([1, 2], [2, 3], 'toggle')).toEqual([1, 3])
  })

  it('cleans indices that no longer exist', () => {
    expect(cleanSelection([3, 1, 1, 9, -1, 2.5], 4)).toEqual([1, 3])
  })

  it('hit-tests the nearest point in pixels', () => {
    const p = zigzag(10)
    const x = (at: number) => at / 10 // 1 px = 10 ms
    const y = (pos: number) => 100 - pos * 100
    const t = (px: number) => px * 10
    expect(hitTest(p, 51, 2, x, y, 6, t)).toBe(1) // (50, 0) is point 1 at the top
    expect(hitTest(p, 75, 50, x, y, 6, t)).toBeNull()
    expect(hitTest(p, 0, 99, x, y, 6, t)).toBe(0)
  })
})

describe('moving a selection', () => {
  it('cannot pass a neighbour outside the selection', () => {
    const p = zigzag(6)
    const lim = moveLimits(p, [2, 3])
    // Point 1 is at 500 and point 4 at 2000; 2 and 3 sit at 1000 and 1500.
    expect(lim.dtMin).toBe(-499)
    expect(lim.dtMax).toBe(499)
    const moved = moveSelection(p, [2, 3], 10_000, 0)
    expect(moved[3].at).toBe(1999)
    expect(isSorted(moved)).toBe(true)
    const back = moveSelection(p, [2, 3], -10_000, 0)
    expect(back[2].at).toBe(501)
    expect(isSorted(back)).toBe(true)
  })

  it('is walled per run when the selection has gaps', () => {
    const p = zigzag(8)
    // Runs [1] and [4, 5]: run [1] is boxed by 0 and 1000, run [4, 5] by 1500 and 3000.
    const lim = moveLimits(p, [1, 4, 5])
    expect(lim.dtMin).toBe(-499)
    expect(lim.dtMax).toBe(499)
  })

  it('stops at time zero', () => {
    const p = zigzag(4)
    expect(moveLimits(p, [0, 1]).dtMin).toBe(0)
    const moved = moveSelection(p, [0], -400, 0)
    expect(moved[0].at).toBe(0)
  })

  it('keeps the group inside 0–100 without squashing it', () => {
    const p: Pt[] = [{ at: 0, pos: 0.2 }, { at: 100, pos: 0.7 }, { at: 200, pos: 0.5 }]
    const moved = moveSelection(p, [0, 1], 0, 0.5)
    expect(moved[0].pos).toBeCloseTo(0.5)
    expect(moved[1].pos).toBeCloseTo(1)
    const down = moveSelection(p, [0, 1], 0, -1)
    expect(down[0].pos).toBeCloseTo(0)
    expect(down[1].pos).toBeCloseTo(0.5)
  })

  it('moves in whole milliseconds and leaves other points as they were', () => {
    const p = zigzag(5)
    const moved = moveSelection(p, [2], 12.6, 0)
    expect(moved[2].at).toBe(1013)
    expect(moved[1]).toBe(p[1])
    expect(p[2].at).toBe(1000) // input untouched
  })

  it('snaps the grabbed point and carries the rest along', () => {
    const p: Pt[] = [{ at: 0, pos: 0 }, { at: 1000, pos: 0.333 }, { at: 1100, pos: 0.555 }, { at: 3000, pos: 0 }]
    const out = dragSelection(p, [1, 2], 1, 47, 0.1, { positions: true, fps: 30 })
    // 1047 snaps to frame 31 at 30 fps = 1033 ms; 0.433 snaps to 0.43.
    expect(out[1].at).toBe(1033)
    expect(out[1].pos).toBeCloseTo(0.43)
    // The other point keeps its distance from the grabbed one.
    expect(out[2].at - out[1].at).toBe(100)
    expect(out[2].pos - out[1].pos).toBeCloseTo(0.222)
  })

  it('snap helpers', () => {
    expect(snapTime(1047, 30)).toBe(1033)
    expect(snapTime(1047.4, 0)).toBe(1047)
    expect(snapPos(0.426)).toBeCloseTo(0.43)
    expect(snapPos(1.2)).toBe(1)
  })
})

describe('insert and delete', () => {
  it('inserts in order, or moves a point already in that millisecond', () => {
    const p = zigzag(3)
    const a = insertPoint(p, 750.4, 0.25)
    expect(a.index).toBe(2)
    expect(a.points.map(x => x.at)).toEqual([0, 500, 750, 1000])
    const b = insertPoint(p, 500, 0.3)
    expect(b.points).toHaveLength(3)
    expect(b.points[1].pos).toBe(0.3)
    expect(insertPoint(p, -20, 2).points[0]).toEqual({ at: 0, pos: 1 })
  })

  it('deletes the selection', () => {
    expect(deletePoints(zigzag(5), [1, 3]).map(x => x.at)).toEqual([0, 1000, 2000])
  })
})

describe('speed', () => {
  it('measures in funscript units per second', () => {
    expect(segmentSpeed({ at: 0, pos: 0 }, { at: 250, pos: 1 })).toBe(400)
    expect(segmentSpeed({ at: 0, pos: 0 }, { at: 0, pos: 1 })).toBe(Number.POSITIVE_INFINITY)
  })

  it('flags segments over the limit', () => {
    const p: Pt[] = [{ at: 0, pos: 0 }, { at: 500, pos: 1 }, { at: 600, pos: 0 }, { at: 1100, pos: 1 }]
    expect(fastSegments(p, 500)).toEqual([1])
    expect(fastSegments(p, 500, 2)).toEqual([])
  })
})

describe('undo', () => {
  it('diffs only what changed', () => {
    const p = zigzag(1000)
    const moved = moveSelection(p, [500, 501], 10, 0)
    const d = diffPoints(p, moved)!
    expect(d.start).toBe(500)
    expect(d.removed).toHaveLength(2)
    expect(d.inserted).toHaveLength(2)
    expect(applyPatch(p, d)).toEqual(moved)
    expect(applyPatch(moved, d, true)).toEqual(p)
    expect(diffPoints(p, p.slice())).toBeNull()
  })

  it('diffs inserts and deletes', () => {
    const p = zigzag(10)
    const ins = insertPoint(p, 1250, 0.5).points
    const d = diffPoints(p, ins)!
    expect(d.removed).toHaveLength(0)
    expect(d.inserted).toEqual([{ at: 1250, pos: 0.5 }])
    const del = deletePoints(p, [0, 9])
    expect(applyPatch(applyPatch(p, diffPoints(p, del)!), diffPoints(p, del)!, true)).toEqual(p)
  })

  it('undoes and redoes with the selection, and knows when it is back to saved', () => {
    const h = new EditHistory()
    const p0 = zigzag(6)
    const p1 = moveSelection(p0, [2], 100, 0)
    const p2 = deletePoints(p1, [4])
    expect(h.record(p0, p1, [], [2])).toBe(true)
    expect(h.record(p1, p2, [2], [])).toBe(true)
    expect(h.dirty).toBe(true)
    expect(h.record(p2, p2.slice(), [], [])).toBe(false)

    const u1 = h.undo(p2)!
    expect(u1.points).toEqual(p1)
    expect(u1.selection).toEqual([2])
    const u2 = h.undo(u1.points)!
    expect(u2.points).toEqual(p0)
    expect(h.dirty).toBe(false)
    expect(h.undo(u2.points)).toBeNull()

    const r1 = h.redo(u2.points)!
    expect(r1.points).toEqual(p1)
    expect(r1.selection).toEqual([2])
    h.markSaved()
    expect(h.dirty).toBe(false)
    // A new edit drops the redo branch.
    const p3 = insertPoint(r1.points, 10, 0.5).points
    h.record(r1.points, p3, [], [1])
    expect(h.canRedo).toBe(false)
    expect(h.dirty).toBe(true)
    h.undo(p3)
    expect(h.dirty).toBe(false)
  })

  it('keeps a bounded history', () => {
    const h = new EditHistory(3)
    let p = zigzag(4)
    for (let i = 0; i < 6; i++) {
      const next = moveSelection(p, [1], 1, 0)
      h.record(p, next, [], [])
      p = next
    }
    let undos = 0
    while (h.undo(p)) undos++
    expect(undos).toBe(3)
  })
})
