import type { FunscriptAction } from '~/lib/funscriptParser'
import type { Pt } from '~/lib/scriptEdit'
import type { ScriptFile } from '~/stores/scriptStore'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, markRaw, ref, shallowRef, toRaw, watch } from 'vue'
import { toast } from '~/composables/useToast'
import { fileHandleOf } from '~/lib/browserApi'
import { stringifyFunscript, writeAxes } from '~/lib/funscriptWrite'
import { setLeaveGuard } from '~/lib/leaveGuard'
import { KEYS } from '~/lib/persist'
import { isAndroidApp } from '~/lib/platform'
import {
  cleanSelection,
  deletePoints,
  EditHistory,
  insertPoint,
  moveSelection,
  positionAt,
  snapPos,
  snapTime,
} from '~/lib/scriptEdit'
import { backupOnce, saveTextAs, takeName, writeTextFile, writeToHandle } from '~/lib/scriptFiles'
import { applyTweaks, bakeOffset, shapeIsIdentity } from '~/lib/scriptTweaks'
import { useLibraryStore } from './libraryStore'
import { usePlayerStore } from './playerStore'
import { sourceOf, useScriptStore } from './scriptStore'

/**
 * The script editor: which axis is open, what is selected, undo, and getting
 * edits onto disk. The points themselves live in the script store (each
 * axis's `source`), so whatever the editor changes plays at once, on every
 * device and for plugins.
 */

export interface EditorPrefs {
  snapPositions: boolean
  snapFrames: boolean
  fps: number
  /** Segments faster than this (units/s) are marked. */
  fastLimit: number
  /** The panel's height, px. */
  height: number
  /** What Fill was last set to. */
  fill: FillPrefs
}

/** Fill and Insert pattern, as last set. Ranges are 0–100. */
export interface FillPrefs {
  /** `shape:<name>` or a pattern's id. */
  source: string
  lo: number
  hi: number
  rate: 'spm' | 'count' | 'beats' | 'own'
  spm: number
  ramp: boolean
  spmTo: number
  /** Repeats per minute for a pattern. */
  patternSpm: number
  /** Strokes, for a shape. */
  count: number
  /** Repeats, for a pattern: 1 stretches it across the span. */
  repeats: number
  perBeat: number
  /** Whole strokes, ending on the end point. */
  fit: boolean
  /** A stretch of time's ends: the script's position there, or the fill's own. */
  edges: 'script' | 'fill'
}

export const FILL_DEFAULTS: FillPrefs = {
  source: 'shape:sine',
  lo: 5,
  hi: 95,
  rate: 'spm',
  spm: 90,
  ramp: false,
  spmTo: 140,
  patternSpm: 20,
  count: 8,
  repeats: 1,
  perBeat: 1,
  fit: true,
  edges: 'script',
}

/** Histories follow the script object itself: Save as renames it, a new video replaces it. */
const keyOf = (s: ScriptFile): object => toRaw(s)

type LeaveChoice = 'save' | 'discard' | 'cancel'

export const useScriptEditStore = defineStore('scriptEdit', () => {
  const scripts = useScriptStore()
  const player = usePlayerStore()
  const library = useLibraryStore()

  const open = ref(false)
  /** The axis being edited. */
  const channel = ref<string | null>(null)
  const selection = shallowRef<number[]>([])
  const prefs = useLocalStorage<EditorPrefs>(KEYS.scriptEditor.key, {
    snapPositions: true,
    snapFrames: false,
    fps: 30,
    fastLimit: 500,
    height: 300,
    fill: { ...FILL_DEFAULTS },
  }, {
    // One level deeper than the default merge, so a fill setting added later gets its default.
    mergeDefaults: (stored, defaults) => ({ ...defaults, ...stored, fill: { ...defaults.fill, ...stored?.fill } }),
  })
  const saving = ref(false)

  /** What the unsaved-edits dialog is asking, while it is up. */
  const leavePrompt = shallowRef<{ action: string, resolve: (c: LeaveChoice) => void } | null>(null)

  // Undo history and the last saved points, per axis. Not reactive (big,
  // and only read through the counter below); weak, so a video's go with it.
  const histories = new WeakMap<object, EditHistory>()
  const pristine = new WeakMap<object, FunscriptAction[]>()
  /** Bumped on every history change, so canUndo / canRedo recompute. */
  const tick = ref(0)

  const editable = computed(() => scripts.activeScripts)
  const target = computed<ScriptFile | null>(() =>
    editable.value.find(s => s.channel === channel.value) ?? null)
  const points = computed<readonly Pt[]>(() => (target.value ? toRaw(sourceOf(target.value)).actions : []))
  /** What plays, when tweaks make it differ from the points being edited. */
  const played = computed<readonly Pt[] | null>(() => {
    const s = target.value
    return s && toRaw(s.parsed) !== toRaw(sourceOf(s)) ? toRaw(s.parsed).actions : null
  })

  function history(s: ScriptFile): EditHistory {
    const k = keyOf(s)
    let h = histories.get(k)
    if (!h) {
      h = markRaw(new EditHistory())
      histories.set(k, h)
      pristine.set(k, toRaw(sourceOf(s)).actions)
    }
    return h
  }

  const canUndo = computed(() => {
    void tick.value
    return !!target.value && !!histories.get(keyOf(target.value))?.canUndo
  })
  const canRedo = computed(() => {
    void tick.value
    return !!target.value && !!histories.get(keyOf(target.value))?.canRedo
  })
  const dirtyScripts = computed(() => scripts.scripts.filter(s => s.edited))
  const dirty = computed(() => dirtyScripts.value.length > 0)

  // ─── Fill and patterns ──────────────────────────────────────────────────
  /** The Fill / Insert pattern popover is up. */
  const fillOpen = ref(false)
  /** Where an insert with no span goes (script ms), fixed when the popover opens. */
  const fillAt = ref(0)
  /** Opened for a moment (the context menu's "Insert a pattern here") rather than for whatever is selected. */
  const fillPrefer = ref<'auto' | 'at'>('auto')
  /** What a fill would put in, drawn on the canvas until it is applied or closed. */
  const fillPreview = shallowRef<{ from: number, to: number, points: readonly Pt[] } | null>(null)
  /** A stretch of time marked by Alt-dragging, to fill with no points chosen. Script ms. */
  const markedRange = shallowRef<{ t0: number, t1: number } | null>(null)
  /** The Save as pattern popover is up. */
  const patternSaveOpen = ref(false)

  watch(fillOpen, (o) => {
    if (!o)
      fillPreview.value = null
  })

  // New scripts (another video): what was selected means nothing now.
  watch(() => scripts.scripts, () => {
    if (channel.value && !editable.value.some(s => s.channel === channel.value))
      channel.value = editable.value[0]?.channel ?? null
    selection.value = []
    markedRange.value = null
    tick.value++
  })
  watch(channel, () => {
    selection.value = []
    markedRange.value = null
  })

  // ─── Opening ────────────────────────────────────────────────────────────
  function openEditor(ch?: string) {
    // Not in the Android app: a point editor wants a mouse and a big screen.
    if (isAndroidApp)
      return
    const pick = (ch && editable.value.find(s => s.channel === ch)) || target.value || editable.value[0]
    if (!pick) {
      toast('Load a script to edit it', { icon: 'i-carbon-chart-line', key: 'edit' })
      return
    }
    channel.value = pick.channel
    open.value = true
  }

  async function closeEditor() {
    if (!await confirmLeave('Close the editor'))
      return false
    open.value = false
    selection.value = []
    fillOpen.value = false
    patternSaveOpen.value = false
    markedRange.value = null
    return true
  }

  // ─── Changing points ────────────────────────────────────────────────────
  function setSelection(sel: Iterable<number>) {
    selection.value = cleanSelection(sel, points.value.length)
  }

  /**
   * Live update while dragging: the device follows, nothing is recorded.
   * `commit` with the points from before the drag records it when it ends.
   */
  function preview(next: Pt[]) {
    const s = target.value
    if (!s)
      return
    // Before the first change: what "discard" goes back to.
    history(s)
    scripts.setSourceActions(s, next as FunscriptAction[], true)
  }

  /** Record an edit (from `before`, which defaults to the points now) and play it. */
  function commit(next: Pt[], sel: number[], before: readonly Pt[] = points.value, selBefore: readonly number[] = selection.value) {
    const s = target.value
    if (!s)
      return
    const h = history(s)
    const changed = h.record(before, next, selBefore, sel)
    scripts.setSourceActions(s, next as FunscriptAction[], h.dirty)
    selection.value = cleanSelection(sel, next.length)
    if (changed)
      tick.value++
  }

  function undo() {
    const s = target.value
    const h = s && histories.get(keyOf(s))
    const r = h?.undo(points.value)
    if (!s || !h || !r)
      return
    scripts.setSourceActions(s, r.points as FunscriptAction[], h.dirty)
    selection.value = cleanSelection(r.selection, r.points.length)
    tick.value++
  }

  function redo() {
    const s = target.value
    const h = s && histories.get(keyOf(s))
    const r = h?.redo(points.value)
    if (!s || !h || !r)
      return
    scripts.setSourceActions(s, r.points as FunscriptAction[], h.dirty)
    selection.value = cleanSelection(r.selection, r.points.length)
    tick.value++
  }

  /** The playhead in script time: the device reads the script at video time + offset. */
  const playheadMs = () => player.currentTime * 1000 + (target.value?.offsetMs ?? 0)

  function snapAt(t: number) {
    return prefs.value.snapFrames ? snapTime(t, prefs.value.fps) : Math.round(t)
  }

  /** A point at `at` (script ms); at the script's own position there unless `pos` is given. */
  function insertAt(at: number, pos?: number) {
    if (!target.value)
      return
    const t = Math.max(0, snapAt(at))
    let p = pos ?? positionAt(points.value, t)
    if (prefs.value.snapPositions || pos === undefined)
      p = snapPos(p)
    const r = insertPoint(points.value, t, p)
    // Indices after the new point shift by one; keep the rest of the selection out of it.
    commit(r.points, [r.index])
  }

  function insertAtPlayhead() {
    insertAt(playheadMs())
  }

  function deleteSelected() {
    if (!selection.value.length)
      return
    commit(deletePoints(points.value, selection.value), [])
  }

  /** Arrow keys: time in ms or position in units, the selection as one. */
  function nudge(dtMs: number, dUnits: number) {
    if (!selection.value.length)
      return
    commit(moveSelection(points.value, selection.value, dtMs, dUnits / 100), selection.value)
  }

  function selectAll() {
    selection.value = points.value.map((_, i) => i)
  }

  /**
   * Fill between the selected points (or a marked stretch, or the A–B loop),
   * or insert a pattern. With `at` (script ms), insert there.
   */
  function openFill(at?: number) {
    if (!target.value)
      return
    fillAt.value = Math.max(0, Math.round(at ?? playheadMs()))
    fillPrefer.value = at === undefined ? 'auto' : 'at'
    patternSaveOpen.value = false
    fillOpen.value = true
  }

  function openPatternSave() {
    if (selection.value.length < 2)
      return
    fillOpen.value = false
    patternSaveOpen.value = true
  }

  // ─── Saving ─────────────────────────────────────────────────────────────
  function markSaved(list: ScriptFile[]) {
    for (const s of list) {
      const k = keyOf(s)
      histories.get(k)?.markSaved()
      pristine.set(k, toRaw(sourceOf(s)).actions)
      s.edited = false
    }
    tick.value++
  }

  /** The axes of `list` as they would be written: by axis key, edited points. */
  function axesOf(list: ScriptFile[], played = false) {
    const out = new Map<string, Pt[]>()
    for (const s of list) {
      const src = toRaw(sourceOf(s)).actions
      if (!played) {
        out.set(s.axisKey, src)
        continue
      }
      const t = scripts.tweaksFor(s.channel)
      const shaped = shapeIsIdentity(t) ? src : applyTweaks(src, t)
      out.set(s.axisKey, bakeOffset(shaped, t.offsetMs))
    }
    return out
  }

  /** Scripts that live in the same file, which are written together. */
  function byFile(list: ScriptFile[]) {
    const groups = new Map<unknown, ScriptFile[]>()
    for (const s of list) {
      const k = s.handle ?? s.file ?? s.path
      groups.set(k, [...(groups.get(k) ?? []), s])
    }
    return [...groups.values()]
  }

  /** What the file says now, to write the edited axes into. */
  async function readRaw(s: ScriptFile, dir?: FileSystemDirectoryHandle | null): Promise<unknown> {
    try {
      if (s.handle)
        return JSON.parse(await (await s.handle.getFile()).text())
      if (dir && s.file)
        return JSON.parse(await (await (await dir.getFileHandle(s.file.name)).getFile()).text())
      if (s.file)
        return JSON.parse(await s.file.text())
    }
    catch {}
    return { version: '1.0' }
  }

  function rebind(group: ScriptFile[], file: File, handle?: FileSystemFileHandle) {
    for (const s of group) {
      if (s.file && s.file !== file && !handle)
        library.swapFile(s.file, file)
      s.file = file
      if (handle) {
        s.handle = handle
        s.filename = file.name
        s.path = file.name
      }
    }
  }

  /**
   * Save every edited axis into the file it came from. Next to the video
   * that is the file itself, after keeping the original once as `.bak`;
   * where the app cannot write there, it asks where to save instead.
   */
  async function save(): Promise<boolean> {
    const list = dirtyScripts.value
    if (!list.length)
      return true
    saving.value = true
    try {
      for (const group of byFile(list)) {
        const first = group[0]
        if (first.handle) {
          const text = stringifyFunscript(writeAxes(await readRaw(first), axesOf(group)))
          rebind(group, await writeToHandle(first.handle, text), first.handle)
          markSaved(group)
          continue
        }
        const dir = first.file ? await library.writableDirOf(first.file) : null
        if (dir && first.file) {
          const name = first.file.name
          const raw = await readRaw(first, dir)
          const kept = await backupOnce(dir, name)
          const fresh = await writeTextFile(dir, name, stringifyFunscript(writeAxes(raw, axesOf(group))))
          rebind(group, fresh)
          markSaved(group)
          toast.success('Script saved', { detail: kept ? `${name} · the original is kept as ${name}.bak` : name, icon: 'i-carbon-save', key: 'script-save' })
          continue
        }
        // Nowhere to write in place (not from a library folder, or no
        // permission): the same as Save as.
        if (!await saveGroupAs(group, first.filename))
          return false
      }
      return true
    }
    catch (err) {
      console.error('Script save failed', err)
      toast.error('Could not save the script', { detail: (err as Error)?.message })
      return false
    }
    finally {
      saving.value = false
    }
  }

  async function saveGroupAs(group: ScriptFile[], name: string, played = false): Promise<boolean> {
    const first = group[0]
    const startIn = (first.file && (fileHandleOf(first.file) ?? await library.writableDirOf(first.file, false))) || null
    const text = stringifyFunscript(writeAxes(await readRaw(first), axesOf(group, played)))
    const r = await saveTextAs(text, name, startIn as FileSystemDirectoryHandle | null)
    if (r.kind === 'cancelled')
      return false
    if (!played) {
      if (r.kind === 'file')
        rebind(group, r.file, r.handle)
      markSaved(group)
    }
    toast.success(r.kind === 'download' ? 'Script downloaded' : 'Script saved', {
      detail: r.kind === 'file' ? r.file.name : name,
      icon: 'i-carbon-save',
      key: 'script-save',
    })
    return true
  }

  /** Save the axis being edited (and any axis in the same file) under a new name. */
  async function saveAs(): Promise<boolean> {
    const s = target.value
    if (!s)
      return false
    saving.value = true
    try {
      const group = byFile(scripts.activeScripts).find(g => g.includes(s)) ?? [s]
      return await saveGroupAs(group, takeName(s.filename, 'edited'))
    }
    catch (err) {
      toast.error('Could not save the script', { detail: (err as Error)?.message })
      return false
    }
    finally {
      saving.value = false
    }
  }

  /**
   * The playing axes with their tweaks (and offset) baked in, as a new file,
   * for using the tweaked script elsewhere.
   */
  async function exportTweaked(): Promise<boolean> {
    const list = scripts.activeScripts.filter(s => scripts.isTweaked(s.channel))
    if (!list.length)
      return false
    try {
      // Every playing axis of a tweaked file goes in, tweaked or not, so the export is whole.
      for (const group of byFile(scripts.activeScripts).filter(g => g.some(s => list.includes(s)))) {
        if (!await saveGroupAs(group, takeName(group[0].filename, 'tweaked'), true))
          return false
      }
      return true
    }
    catch (err) {
      toast.error('Could not export the script', { detail: (err as Error)?.message })
      return false
    }
  }

  /** Throw the edits away: every axis back to what was last saved. */
  function discard() {
    for (const s of dirtyScripts.value) {
      const k = keyOf(s)
      const saved = pristine.get(k)
      if (saved)
        scripts.setSourceActions(s, saved, false)
      s.edited = false
      histories.delete(k)
      pristine.delete(k)
    }
    selection.value = []
    tick.value++
  }

  // ─── Leaving with unsaved edits ─────────────────────────────────────────
  /**
   * Ask before something replaces or closes edited scripts. `action` names
   * what is about to happen ("Play another video"). With `auto` (a video
   * ending on its own) it never asks: it just says no, so nothing moves on
   * under someone mid-edit.
   */
  async function confirmLeave(action: string, auto = false): Promise<boolean> {
    if (!dirty.value)
      return true
    if (auto) {
      toast.warn('Stopped: the script has unsaved edits', { icon: 'i-carbon-edit', key: 'edit-leave' })
      return false
    }
    // Already asking (a second click while the dialog is up): this one waits its turn by saying no.
    if (leavePrompt.value)
      return false
    const choice = await new Promise<LeaveChoice>((resolve) => {
      leavePrompt.value = { action, resolve }
    })
    leavePrompt.value = null
    if (choice === 'cancel')
      return false
    if (choice === 'save')
      return save()
    discard()
    return true
  }

  function answerLeave(choice: LeaveChoice) {
    leavePrompt.value?.resolve(choice)
  }

  setLeaveGuard(confirmLeave)

  return {
    open,
    channel,
    selection,
    prefs,
    saving,
    leavePrompt,
    editable,
    target,
    points,
    played,
    canUndo,
    canRedo,
    dirty,
    dirtyScripts,
    openEditor,
    closeEditor,
    setSelection,
    selectAll,
    preview,
    commit,
    undo,
    redo,
    playheadMs,
    snapAt,
    insertAt,
    insertAtPlayhead,
    deleteSelected,
    nudge,
    fillOpen,
    fillAt,
    fillPrefer,
    fillPreview,
    markedRange,
    patternSaveOpen,
    openFill,
    openPatternSave,
    save,
    saveAs,
    exportTweaked,
    discard,
    confirmLeave,
    answerLeave,
  }
})
