import type { ParsedAxis } from '../src/lib/funscriptParser'
import type { ScriptFile } from '../src/stores/scriptStore'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/idb', () => ({
  videoMetaDb: { get: async () => undefined, set: async () => {} },
}))
vi.mock('~/composables/useToast', () => ({
  toast: Object.assign(vi.fn(), { warn: vi.fn(), error: vi.fn(), success: vi.fn() }),
}))

const { useScriptStore, sourceOf } = await import('../src/stores/scriptStore')
const { useScriptEditStore } = await import('../src/stores/scriptEditStore')
const { mayLeave } = await import('../src/lib/leaveGuard')

function file(actions: { at: number, pos: number }[]): ScriptFile {
  const parsed: ParsedAxis = {
    channel: 'L0',
    axisKey: 'default',
    label: 'Stroke',
    axisDef: { channel: 'L0', label: 'Stroke', defaultPos: 0.5, isLinear: true },
    actions,
    filePath: 'clip.funscript',
    duration: actions.at(-1)?.at ?? 0,
  }
  return { path: 'clip.funscript', filename: 'clip.funscript', channel: 'L0', axisKey: 'default', label: 'Stroke', enabled: true, isAlt: false, altName: '', offsetMs: 0, parsed }
}

const POINTS = [{ at: 0, pos: 0 }, { at: 500, pos: 1 }, { at: 1000, pos: 0 }]

describe('script edit store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('edits the open axis, undoes and redoes, and plays every step', () => {
    const scripts = useScriptStore()
    scripts.setScripts([file(POINTS)])
    const edit = useScriptEditStore()
    edit.openEditor()
    expect(edit.open).toBe(true)
    edit.setSelection([1])
    edit.nudge(0, -20)
    expect(scripts.scripts[0].parsed.actions[1].pos).toBeCloseTo(0.8)
    expect(edit.dirty).toBe(true)
    edit.insertAt(250)
    expect(edit.points.map(p => p.at)).toEqual([0, 250, 500, 1000])
    expect(edit.selection).toEqual([1])
    edit.deleteSelected()
    edit.undo()
    edit.undo()
    expect(edit.points.map(p => p.at)).toEqual([0, 500, 1000])
    edit.undo()
    expect(edit.points[1].pos).toBe(1)
    expect(edit.dirty).toBe(false)
    edit.redo()
    expect(edit.points[1].pos).toBeCloseTo(0.8)
  })

  it('a drag previews without history, and its commit is one undo step', () => {
    const scripts = useScriptStore()
    scripts.setScripts([file(POINTS)])
    const edit = useScriptEditStore()
    edit.openEditor()
    const before = edit.points.slice()
    const mid = before.map((p, i) => (i === 1 ? { at: 600, pos: 1 } : p))
    const end = before.map((p, i) => (i === 1 ? { at: 700, pos: 1 } : p))
    edit.preview(mid)
    expect(scripts.scripts[0].parsed.actions[1].at).toBe(600)
    expect(edit.canUndo).toBe(false)
    edit.commit(end, [1], before, [1])
    edit.undo()
    expect(edit.points[1].at).toBe(500)
    expect(edit.canUndo).toBe(false)
  })

  it('asks before leaving with unsaved edits; a video ending never moves on', async () => {
    const scripts = useScriptStore()
    scripts.setScripts([file(POINTS)])
    const edit = useScriptEditStore()
    edit.openEditor()
    expect(await mayLeave('Play another video')).toBe(true)
    edit.insertAt(250)

    expect(await mayLeave('Play the next video', true)).toBe(false)

    const asked = mayLeave('Play another video')
    expect(edit.leavePrompt?.action).toBe('Play another video')
    edit.answerLeave('cancel')
    expect(await asked).toBe(false)
    expect(edit.points).toHaveLength(4)

    const again = mayLeave('Play another video')
    edit.answerLeave('discard')
    expect(await again).toBe(true)
    expect(edit.dirty).toBe(false)
    expect(sourceOf(scripts.scripts[0]).actions).toHaveLength(3)
    expect(scripts.scripts[0].edited).toBe(false)
  })
})
