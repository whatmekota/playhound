<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { AXIS_PRIORITY } from '~/lib/axisMap'
import { fastSegments, lowerBound, moveSelection, snapPos } from '~/lib/scriptEdit'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useScriptEditStore } from '~/stores/scriptEditStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useUiStore } from '~/stores/uiStore'
import SavePatternPanel from './SavePatternPanel.vue'
import ScriptEditorCanvas from './ScriptEditorCanvas.vue'
import ScriptFillPanel from './ScriptFillPanel.vue'

/**
 * The script editor, docked along the bottom of the stage with the video
 * above it. Its keys only work while it is open, and are taken before the
 * app's own (see onKey): arrows nudge the selection instead of seeking only
 * while something is selected.
 */

const edit = useScriptEditStore()
const scripts = useScriptStore()
const player = usePlayerStore()
const playback = usePlaybackStore()
const ui = useUiStore()
const safety = useSafetyStore()

const canvas = ref<InstanceType<typeof ScriptEditorCanvas> | null>(null)
const fillPop = ref<InstanceType<typeof UiPopover> | null>(null)

const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

const rank = (c: string) => (AXIS_PRIORITY.includes(c) ? AXIS_PRIORITY.indexOf(c) : 99)
const axisOptions = computed(() => [...edit.editable]
  .sort((a, b) => rank(a.channel) - rank(b.channel))
  .map(s => ({ value: s.channel, label: s.channel, title: s.label })))
const axisModel = computed({
  get: () => edit.channel ?? '',
  set: (v: string) => (edit.channel = v),
})

const selected = computed(() => edit.selection.length)
const single = computed(() => (edit.selection.length === 1 ? edit.points[edit.selection[0]] ?? null : null))

const fast = computed(() => fastSegments(edit.points, edit.prefs.fastLimit))

/** The next segment that is too fast, after the selection or the playhead; selects and shows it. */
function nextFast() {
  const list = fast.value
  if (!list.length)
    return
  const from = edit.selection.length
    ? edit.selection[edit.selection.length - 1]
    : lowerBound(edit.points, edit.playheadMs())
  const i = list.find(k => k >= from) ?? list[0]
  edit.setSelection([i, i + 1])
  canvas.value?.showSelection()
}

// ─── The selected point, typed in ────────────────────────────────────────────
function setSingleTime(raw: string) {
  const i = edit.selection[0]
  const p = single.value
  const v = Number.parseInt(raw, 10)
  if (!p || Number.isNaN(v))
    return
  edit.commit(moveSelection(edit.points, [i], v - p.at, 0), [i])
}
function setSinglePos(raw: string) {
  const i = edit.selection[0]
  const p = single.value
  const v = Number.parseFloat(raw)
  if (!p || Number.isNaN(v))
    return
  edit.commit(moveSelection(edit.points, [i], 0, snapPos(v / 100) - p.pos), [i])
}

// ─── Height ──────────────────────────────────────────────────────────────────
const MIN_H = 200
function startResize(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const y0 = e.clientY
  const h0 = edit.prefs.height
  const max = Math.max(MIN_H, (el.closest('main')?.clientHeight ?? 800) * 0.75)
  const move = (ev: PointerEvent) => {
    edit.prefs.height = Math.round(Math.max(MIN_H, Math.min(max, h0 + (y0 - ev.clientY))))
  }
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}

// ─── Keys ────────────────────────────────────────────────────────────────────
/** One frame at the snapping rate, or 10 ms without frame snapping. */
const timeStep = () => (edit.prefs.snapFrames && edit.prefs.fps > 0 ? Math.round(1000 / edit.prefs.fps) : 10)

function seekToPoint(dir: -1 | 1) {
  const pts = edit.points
  const t = edit.playheadMs()
  let i = lowerBound(pts, t)
  if (dir < 0)
    i = i - 1
  else if (pts[i] && Math.abs(pts[i].at - t) < 1)
    i++
  // Close enough to count as on it already: one more.
  if (dir < 0 && pts[i] && Math.abs(pts[i].at - t) < 1)
    i--
  const p = pts[Math.max(0, Math.min(pts.length - 1, i))]
  if (p)
    playback.seek(Math.max(0, (p.at - (edit.target?.offsetMs ?? 0)) / 1000))
}

/**
 * Taken in the capture phase, ahead of the shell's and the player's keys,
 * and stopped there, so a key the editor uses never also does the app's
 * thing. Esc is never taken: it stays panic.
 */
function onKey(e: KeyboardEvent) {
  if (!edit.open || !ui.onPlayer || edit.leavePrompt || ui.paletteOpen || ui.settingsOpen || ui.shortcutsOpen || safety.panicked)
    return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))
    return
  const ctrl = e.ctrlKey || e.metaKey
  const has = edit.selection.length > 0
  let run: (() => void) | null = null

  if (ctrl && !e.altKey) {
    if (e.code === 'KeyZ')
      run = e.shiftKey ? edit.redo : edit.undo
    else if (e.code === 'KeyY')
      run = edit.redo
    else if (e.code === 'KeyA')
      run = edit.selectAll
    else if (e.code === 'KeyS')
      run = () => void (e.shiftKey ? edit.saveAs() : edit.save())
  }
  else if (!e.altKey) {
    const big = e.shiftKey ? 10 : 1
    switch (e.code) {
      case 'Delete':
      case 'Backspace':
        if (has)
          run = edit.deleteSelected
        break
      case 'KeyI':
      case 'Insert':
        if (!e.shiftKey)
          run = edit.insertAtPlayhead
        else if (e.code === 'KeyI')
          run = () => edit.openFill()
        break
      case 'ArrowLeft':
      case 'ArrowRight':
        if (has)
          run = () => edit.nudge((e.code === 'ArrowLeft' ? -1 : 1) * timeStep() * big, 0)
        break
      case 'ArrowUp':
      case 'ArrowDown':
        if (has)
          run = () => edit.nudge(0, (e.code === 'ArrowDown' ? -1 : 1) * big)
        break
      case 'Comma':
      case 'Period':
        if (!e.shiftKey)
          run = () => seekToPoint(e.code === 'Comma' ? -1 : 1)
        break
    }
  }
  if (!run)
    return
  e.preventDefault()
  e.stopImmediatePropagation()
  run()
}

onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))

const isTweaked = computed(() => !!edit.channel && scripts.isTweaked(edit.channel))
const fpsOptions = [24, 25, 30, 60].map(v => ({ value: v, label: String(v) }))
</script>

<template>
  <section class="border-t border-edge bg-surface-900 flex flex-col" aria-label="Script editor">
    <!-- Drag to resize -->
    <div
      class="h-1.5 cursor-ns-resize inset-x-0 absolute z-10 hover:bg-accent/30 -top-1"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the editor"
      @pointerdown="startResize"
    />

    <header class="px-3 border-b border-edge flex shrink-0 gap-2 h-10 items-center">
      <span class="i-carbon-edit text-[15px] text-accent-300 shrink-0" />
      <span class="text-[13px] text-fg font-medium shrink-0">Edit script</span>
      <UiSegmented v-if="axisOptions.length > 1" v-model="axisModel" :options="axisOptions" size="xs" class="num" />
      <UiBadge v-else-if="edit.target" size="xs" tone="accent" class="num">
        {{ edit.target.channel }}
      </UiBadge>
      <span v-if="edit.target" v-tip="edit.target.filename" class="text-[11.5px] text-fg-faint max-w-48 truncate">{{ edit.target.filename }}</span>
      <UiBadge v-if="edit.dirty" tone="warn" size="xs" dot>
        Unsaved
      </UiBadge>
      <UiBadge v-if="isTweaked" v-tip="'Tweaks from the Scripts panel play on top of these points. The dashed line is what plays.'" tone="info" size="xs">
        Tweaked
      </UiBadge>

      <div class="mx-1 divider-x" />
      <UiIconButton icon="i-carbon-undo" label="Undo" :kbd="`${mod} Z`" size="sm" :disabled="!edit.canUndo" @click="edit.undo" />
      <UiIconButton icon="i-carbon-redo" label="Redo" :kbd="`${mod} Shift Z`" size="sm" :disabled="!edit.canRedo" @click="edit.redo" />
      <UiIconButton icon="i-carbon-add-alt" label="Add a point at the playhead" kbd="I" size="sm" :disabled="!edit.target" @click="edit.insertAtPlayhead" />
      <UiIconButton icon="i-carbon-trash-can" label="Delete selected" kbd="Del" size="sm" :disabled="!selected" @click="edit.deleteSelected" />

      <div class="mx-1 divider-x" />
      <UiPopover ref="fillPop" v-model:open="edit.fillOpen" placement="top" align="start" width="600px">
        <template #trigger>
          <UiButton
            v-tip="{ text: selected >= 2 ? 'Fill between the selected points' : 'Fill a stretch, or insert a pattern at the playhead', kbd: 'Shift I' }"
            variant="ghost"
            size="sm"
            icon="i-carbon-chart-line-smooth"
            :active="edit.fillOpen"
            :disabled="!edit.target"
            @click="edit.fillOpen ? (edit.fillOpen = false) : edit.openFill()"
          >
            Fill…
          </UiButton>
        </template>
        <ScriptFillPanel @close="edit.fillOpen = false" @show="(a, b) => canvas?.showSpan(a, b)" @resize="fillPop?.place()" />
      </UiPopover>
      <UiPopover v-model:open="edit.patternSaveOpen" placement="top" align="start" width="280px">
        <template #trigger>
          <UiIconButton
            icon="i-carbon-save-series"
            label="Save the selection as a pattern"
            size="sm"
            :active="edit.patternSaveOpen"
            :disabled="selected < 2"
            @click="edit.patternSaveOpen ? (edit.patternSaveOpen = false) : edit.openPatternSave()"
          />
        </template>
        <SavePatternPanel @close="edit.patternSaveOpen = false" />
      </UiPopover>

      <div class="mx-1 divider-x" />
      <UiPopover placement="top" align="start" width="272px">
        <template #trigger="{ toggle, open }">
          <UiButton
            variant="ghost"
            size="sm"
            icon="i-carbon-grid"
            :active="open || edit.prefs.snapPositions || edit.prefs.snapFrames"
            @click="toggle"
          >
            Snap
          </UiButton>
        </template>
        <div class="p-1 flex flex-col gap-3">
          <UiSwitch v-model="edit.prefs.snapPositions" size="sm" label="Whole positions" hint="Points land on 0–100 in steps of 1" />
          <UiSwitch v-model="edit.prefs.snapFrames" size="sm" label="Video frames" hint="Points land on frame boundaries" />
          <div v-if="edit.prefs.snapFrames" class="flex gap-2 items-center justify-between">
            <span class="label">Frame rate</span>
            <UiSegmented v-model="edit.prefs.fps" :options="fpsOptions" size="xs" class="num" />
          </div>
          <div class="pt-2.5 border-t border-edge">
            <UiSlider
              v-model="edit.prefs.fastLimit"
              label="Too fast over"
              :min="200"
              :max="1000"
              :step="50"
              :reset="500"
              :format="v => `${v} /s`"
              tone="danger"
              hint="Segments faster than this are marked red. Most strokers top out around 400–600."
            />
          </div>
        </div>
      </UiPopover>
      <UiIconButton icon="i-carbon-zoom-out" label="Zoom out" size="sm" @click="canvas?.zoomOut()" />
      <UiIconButton icon="i-carbon-zoom-in" label="Zoom in" size="sm" @click="canvas?.zoomIn()" />
      <UiIconButton icon="i-carbon-zoom-fit" label="Show the whole script" size="sm" @click="canvas?.fitAll()" />

      <div class="ml-auto flex shrink-0 gap-2 items-center">
        <button
          v-if="fast.length"
          v-tip="'Jump to the next one'"
          type="button"
          class="focusable rounded-[var(--radius-sm)] pressable"
          @click="nextFast"
        >
          <UiBadge tone="danger" size="xs" icon="i-carbon-warning-alt" class="num">
            {{ fast.length }} too fast
          </UiBadge>
        </button>
        <span class="text-[11.5px] text-fg-faint num hidden lg:inline">
          {{ edit.points.length.toLocaleString() }} pts<template v-if="selected"> · {{ selected.toLocaleString() }} selected</template>
        </span>
        <UiButton variant="ghost" size="sm" :disabled="!edit.target || edit.saving" @click="edit.saveAs()">
          Save as…
        </UiButton>
        <UiButton
          v-tip="{ text: 'Save next to the video; the original is kept once as .bak', kbd: `${mod} S` }"
          variant="primary"
          size="sm"
          icon="i-carbon-save"
          :loading="edit.saving"
          :disabled="!edit.dirty"
          @click="edit.save()"
        >
          Save
        </UiButton>
        <UiIconButton icon="i-carbon-close" label="Close the editor" size="sm" @click="edit.closeEditor()" />
      </div>
    </header>

    <ScriptEditorCanvas v-if="edit.target" ref="canvas" class="flex-1 min-h-0" />
    <div v-else class="text-[12.5px] text-fg-muted center flex-1">
      No script on this video to edit.
    </div>

    <footer class="text-[11px] text-fg-faint px-3 border-t border-edge flex shrink-0 gap-3 h-8 items-center">
      <template v-if="single">
        <label class="flex gap-1.5 items-center">
          <span>Time</span>
          <input
            type="number"
            :value="single.at"
            step="1"
            aria-label="Time of the selected point, ms"
            class="text-[11.5px] text-fg num px-1.5 focusable border border-edge-strong rounded-[var(--radius-xs)] bg-surface-850 h-6 w-24"
            @change="setSingleTime(($event.target as HTMLInputElement).value)"
          >
          <span>ms</span>
        </label>
        <label class="flex gap-1.5 items-center">
          <span>Position</span>
          <input
            type="number"
            :value="Math.round(single.pos * 100)"
            min="0"
            max="100"
            step="1"
            aria-label="Position of the selected point, 0 to 100"
            class="text-[11.5px] text-fg num px-1.5 focusable border border-edge-strong rounded-[var(--radius-xs)] bg-surface-850 h-6 w-16"
            @change="setSinglePos(($event.target as HTMLInputElement).value)"
          >
        </label>
        <span class="divider-x" />
      </template>
      <span class="truncate">
        Click a point to select · Shift or {{ mod }} to add · drag empty space to box-select · Alt + drag to mark a stretch · drag points to move · double-click or I to add · Shift I to fill · arrows nudge · , . jump between points
      </span>
      <span v-if="!player.isPlaying && player.videoUrl" class="ml-auto shrink-0">Space plays</span>
    </footer>
  </section>
</template>
