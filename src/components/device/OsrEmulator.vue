<script setup lang="ts">
import type { Corner } from '~/lib/emuPlacement'
import { useLocalStorage } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useCompactLayout, useRailLayout } from '~/composables/useCompactLayout'
import { useEmulatorPhone } from '~/composables/useEmulatorPhone'
import { setEmuInstance } from '~/composables/useTCode'
import { cornerPosition, fitSize, nearestCorner, PHONE_EMU_ASPECT } from '~/lib/emuPlacement'
import { useOccluder } from '~/lib/occluders'
import { useUiStore } from '~/stores/uiStore'

/**
 * Floating 3D preview of an OSR2 / SR6, fed the same TCode as the hardware.
 *
 * The shell mounts this while the window is open; everything about the window
 * itself (model, place, size) is remembered here, so it comes back where it
 * was left. Closing from the title bar plays the exit animation first and only
 * then tells the shell, which unmounts it.
 *
 * In the phone layout it is made for fingers instead: docked by default (a
 * strip above the player bar upright, a panel beside the video sideways; the
 * shell makes the room, #ph-emu-dock-*), or floating in a corner of the stage:
 * the whole title bar drags it, it snaps to the nearest corner when let go,
 * and a big corner handle or a pinch resizes it. The desktop window is as it was.
 */

type Model = 'OSR2' | 'SR6'
interface Saved { model: Model, x: number, y: number, w: number, h: number }

const DEFAULT_W = 280
const DEFAULT_H = 340
const MIN_W = 200
const MIN_H = 220
/** Gap kept between the window and the edge of the screen. */
const EDGE = 8

const ui = useUiStore()
const saved = useLocalStorage<Saved>(
  'ph:emulator',
  { model: 'OSR2', x: -1, y: -1, w: DEFAULT_W, h: DEFAULT_H },
  { mergeDefaults: true },
)

const MODELS = [
  { value: 'OSR2' as const, label: 'OSR2', title: 'OSR2+: stroke, twist, roll, pitch' },
  { value: 'SR6' as const, label: 'SR6', title: 'SR6: adds surge and sway' },
]
const model = computed<Model>({
  get: () => (saved.value.model === 'SR6' ? 'SR6' : 'OSR2'),
  set: v => (saved.value.model = v),
})

// ─── Place and size ───────────────────────────────────────────────────────────
function clamp() {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const s = saved.value
  const w = Math.max(MIN_W, Math.min(s.w, vw - EDGE * 2))
  const h = Math.max(MIN_H, Math.min(s.h, vh - EDGE * 2))
  // First open: tuck it in beside the nav, under the top of the stage.
  let x = s.x < 0 ? 76 : s.x
  let y = s.y < 0 ? 72 : s.y
  x = Math.max(EDGE, Math.min(x, vw - w - EDGE))
  y = Math.max(EDGE, Math.min(y, vh - h - EDGE))
  if (x !== s.x || y !== s.y || w !== s.w || h !== s.h)
    saved.value = { ...s, x, y, w, h }
}

type Gesture = 'move' | 'resize' | null
const gesture = ref<Gesture>(null)

// ─── On a phone ──────────────────────────────────────────────────────────────
const compact = useCompactLayout()
const rail = useRailLayout()
const phone = useEmulatorPhone()
const docked = computed(() => compact.value && phone.value.mode === 'dock')
const phoneFloat = computed(() => compact.value && !docked.value)
/** Where it is while a finger drags it; it snaps to a corner on release. */
const dragAt = ref<{ x: number, y: number } | null>(null)
/** Bumped on rotation and resizes, so the stage is measured again. */
const areaTick = ref(0)

function stageArea() {
  void areaTick.value
  const r = document.querySelector('main')?.getBoundingClientRect()
  return r && r.width > 0
    ? { left: r.left, top: r.top, width: r.width, height: r.height }
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}

const phoneBox = computed(() => {
  const area = stageArea()
  const { w, h } = fitSize(phone.value.w, area)
  const at = dragAt.value ?? cornerPosition(phone.value.corner, w, h, area)
  return { x: at.x, y: at.y, w, h }
})

/** The resize handle goes on the corner facing into the stage. */
const gripCorner = computed<Corner>(() => {
  const c = phone.value.corner
  return `${c[0] === 't' ? 'b' : 't'}${c[1] === 'l' ? 'r' : 'l'}` as Corner
})

function setPhoneWidth(w: number) {
  phone.value = { ...phone.value, ...fitSize(w, stageArea()) }
}

// Two fingers anywhere on the floating window resize it.
const fingers = new Map<number, { x: number, y: number }>()
let pinch: { dist: number, w: number } | null = null

function beginPhone(kind: 'move' | 'resize', e: PointerEvent) {
  if (e.button !== 0 || pinch)
    return
  e.preventDefault()
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const start = { mx: e.clientX, my: e.clientY, ...phoneBox.value }
  const c = phone.value.corner
  gesture.value = kind
  const move = (ev: PointerEvent) => {
    if (pinch)
      return
    const dx = ev.clientX - start.mx
    const dy = ev.clientY - start.my
    if (kind === 'move') {
      dragAt.value = { x: start.x + dx, y: start.y + dy }
    }
    else {
      // Growing away from the corner it is pinned to; the bigger pull wins.
      const byX = start.w + (c[1] === 'r' ? -dx : dx)
      const byY = (start.h + (c[0] === 'b' ? -dy : dy)) / PHONE_EMU_ASPECT
      setPhoneWidth(Math.abs(byX - start.w) > Math.abs(byY - start.w) ? byX : byY)
    }
  }
  const up = (ev: PointerEvent) => {
    if (el.hasPointerCapture(ev.pointerId))
      el.releasePointerCapture(ev.pointerId)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    if (kind === 'move' && dragAt.value) {
      const b = phoneBox.value
      phone.value = { ...phone.value, corner: nearestCorner(b.x + b.w / 2, b.y + b.h / 2, stageArea()) }
    }
    dragAt.value = null
    gesture.value = null
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}

function spread() {
  const [a, b] = [...fingers.values()]
  return Math.hypot(a.x - b.x, a.y - b.y)
}
function onPinchDown(e: PointerEvent) {
  if (!phoneFloat.value || e.pointerType !== 'touch')
    return
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (fingers.size === 2) {
    pinch = { dist: Math.max(1, spread()), w: phoneBox.value.w }
    dragAt.value = null
    gesture.value = 'resize'
  }
}
function onPinchMove(e: PointerEvent) {
  if (!fingers.has(e.pointerId))
    return
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pinch && fingers.size === 2) {
    e.preventDefault()
    setPhoneWidth(pinch.w * spread() / pinch.dist)
  }
}
function onPinchUp(e: PointerEvent) {
  fingers.delete(e.pointerId)
  if (pinch && fingers.size < 2) {
    pinch = null
    gesture.value = null
  }
}

function dock(on: boolean) {
  phone.value = { ...phone.value, mode: on ? 'dock' : 'float' }
}

const box = computed(() => {
  if (docked.value)
    return {}
  if (phoneFloat.value) {
    const b = phoneBox.value
    return { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }
  }
  return {
    left: `${saved.value.x}px`,
    top: `${saved.value.y}px`,
    width: `${saved.value.w}px`,
    height: `${saved.value.h}px`,
  }
})

function begin(kind: Exclude<Gesture, null>, e: PointerEvent) {
  if (e.button !== 0)
    return
  e.preventDefault()
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const start = { mx: e.clientX, my: e.clientY, ...saved.value }
  gesture.value = kind

  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - start.mx
    const dy = ev.clientY - start.my
    if (kind === 'move')
      saved.value = { ...saved.value, x: start.x + dx, y: start.y + dy }
    else
      saved.value = { ...saved.value, w: Math.max(MIN_W, start.w + dx), h: Math.max(MIN_H, start.h + dy) }
    clamp()
  }
  const up = (ev: PointerEvent) => {
    el.releasePointerCapture(ev.pointerId)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    gesture.value = null
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}

function resetSize() {
  saved.value = { ...saved.value, w: DEFAULT_W, h: DEFAULT_H }
  clamp()
}

function onResize() {
  clamp()
  areaTick.value++
}
onMounted(() => {
  clamp()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => window.removeEventListener('resize', onResize))

// ─── Open / close ─────────────────────────────────────────────────────────────
const shown = ref(true)
const windowEl = ref<HTMLElement | null>(null)
// It floats over the stage and stays open while you browse: a plugin's web
// page under it moves into the room beside it rather than hiding.
useOccluder(() => shown.value, () => windowEl.value, 'dodge')
function close() {
  shown.value = false
}
function afterLeave() {
  if (ui.isFloatingOpen('emulator'))
    ui.toggleFloating('emulator')
}

// ─── Emulator ─────────────────────────────────────────────────────────────────
const container = ref<HTMLDivElement | null>(null)
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const error = ref('')
let emu: { write: (s: string) => void, destroy: () => void } | null = null
let disposed = false

function teardown() {
  setEmuInstance(null)
  try {
    emu?.destroy()
  }
  catch {}
  emu = null
  if (container.value)
    container.value.replaceChildren()
}

async function init() {
  teardown()
  phase.value = 'loading'
  error.value = ''
  try {
    // Three.js and the model are heavy; only pay for them once the window opens.
    // The shim in shims.d.ts predates the options argument and destroy().
    const { OSREmulator } = await import('osr-emu') as unknown as { OSREmulator: new (el: HTMLElement, opts: { model: Model }) => NonNullable<typeof emu> }
    await nextTick()
    if (disposed || !container.value)
      return
    emu = new OSREmulator(container.value, { model: model.value })
    // Hand the raw instance to useTCode: going through a Vue proxy costs a
    // reactive lookup on every command, sixty times a second.
    setEmuInstance(emu)
    phase.value = 'ready'
  }
  catch (e: any) {
    error.value = e?.message ?? 'The 3D preview could not start'
    phase.value = 'error'
  }
}

onMounted(() => void init())
watch(model, () => void init())
onBeforeUnmount(() => {
  disposed = true
  teardown()
})
</script>

<template>
  <!-- Docked on a phone: into the room the shell makes for it (pages/index.vue). -->
  <Teleport :to="rail ? '#ph-emu-dock-side' : '#ph-emu-dock-strip'" defer :disabled="!docked">
    <Transition name="emu" appear @after-leave="afterLeave">
      <div
        v-if="shown"
        ref="windowEl"
        class="emu-window flex flex-col overflow-hidden"
        :class="[
          gesture ? 'select-none' : '',
          docked ? 'is-docked bg-surface-900 h-full w-full relative'
          : 'rounded-[var(--radius-lg)] glass ring-1 ring-edge-strong shadow-[var(--shadow-lg)] fixed',
          // On a phone it floats over panels (600) but under sheets (640),
          // the bar (650) and dialogs: those always come out on top.
          !docked && (compact ? 'z-[620]' : 'z-[700]'),
          phoneFloat ? 'is-phone' : '',
          phoneFloat && !gesture ? 'is-snapping' : '',
        ]"
        :style="box"
        role="dialog"
        aria-label="OSR emulator"
        @pointerdown.capture="onPinchDown"
        @pointermove.capture="onPinchMove"
        @pointerup.capture="onPinchUp"
        @pointercancel.capture="onPinchUp"
      >
        <!-- On a phone: a title bar a finger can hold, and docking -->
        <header
          v-if="compact"
          class="emu-phone-bar pl-3 border-b border-edge flex shrink-0 gap-1 h-11 items-center"
          :class="docked ? '' : gesture === 'move' ? 'cursor-grabbing' : 'cursor-grab'"
          @pointerdown="!docked && beginPhone('move', $event)"
        >
          <span class="i-carbon-cube text-[15px] text-accent-300 shrink-0" />
          <!-- Floating it is small: the bar is a handle, the model is picked docked. -->
          <span v-if="docked" class="text-[13px] text-fg font-semibold truncate">Emulator</span>
          <span v-else class="i-carbon-draggable text-[16px] text-fg-faint" aria-hidden="true" />
          <div class="ml-auto flex gap-0.5 items-center" @pointerdown.stop>
            <UiSegmented v-if="docked" v-model="model" :options="MODELS" size="sm" />
            <UiIconButton
              :icon="docked ? 'i-carbon-launch' : rail ? 'i-carbon-open-panel-right' : 'i-carbon-open-panel-bottom'"
              :label="docked ? 'Float it over the video' : rail ? 'Dock it beside the video' : 'Dock it above the player bar'"
              size="lg"
              @click="dock(!docked)"
            />
            <UiIconButton icon="i-carbon-close" label="Close emulator" size="lg" @click="close" />
          </div>
        </header>
        <!-- Title bar: the whole bar drags, the controls on it do not -->
        <header
          v-else
          class="pl-3 pr-1.5 border-b border-edge flex shrink-0 gap-2 h-9 items-center"
          :class="gesture === 'move' ? 'cursor-grabbing' : 'cursor-grab'"
          @pointerdown="begin('move', $event)"
          @dblclick="resetSize"
        >
          <span class="i-carbon-cube text-[14px] text-accent-300 shrink-0" />
          <span class="text-[12.5px] text-fg font-semibold truncate">Emulator</span>
          <div class="ml-auto flex gap-1 cursor-default items-center" @pointerdown.stop @dblclick.stop>
            <UiSegmented v-model="model" :options="MODELS" size="xs" />
            <UiIconButton icon="i-carbon-close" label="Close emulator" size="xs" tip="bottom" @click="close" />
          </div>
        </header>

        <div class="flex-1 min-h-0 relative">
          <div ref="container" class="h-full w-full" :class="gesture ? 'pointer-events-none' : ''" />

          <Transition name="t-fade">
            <div v-if="phase === 'loading'" class="flex flex-col gap-2 items-center inset-0 justify-center absolute">
              <UiSpinner :size="18" class="text-fg-faint" />
              <span class="text-[11.5px] text-fg-faint">Loading {{ model }}…</span>
            </div>
          </Transition>
          <div v-if="phase === 'error'" class="p-4 text-center flex flex-col gap-2 items-center inset-0 justify-center absolute">
            <span class="i-carbon-warning-alt text-[22px] text-danger" />
            <span class="text-[12px] text-fg-muted">{{ error }}</span>
            <UiButton size="xs" icon="i-carbon-renew" @click="init">
              Try again
            </UiButton>
          </div>
        </div>

        <!-- On a phone: a corner a thumb can find, facing into the stage -->
        <div
          v-if="phoneFloat"
          class="emu-phone-grip absolute z-10"
          :class="[`is-${gripCorner}`, gesture === 'resize' ? 'is-active' : '']"
          aria-hidden="true"
          @pointerdown="beginPhone('resize', $event)"
        >
          <span class="i-carbon-maximize" />
        </div>
        <!-- Resize grip -->
        <div
          v-else-if="!compact"
          class="emu-grip h-4 w-4 cursor-se-resize bottom-0 right-0 absolute z-10"
          :class="gesture === 'resize' ? 'opacity-100' : 'opacity-50 hover:opacity-100'"
          aria-hidden="true"
          @pointerdown="begin('resize', $event)"
        />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.emu-grip {
  background: linear-gradient(
    135deg,
    transparent 0 55%,
    var(--text-faint) 55% 62%,
    transparent 62% 72%,
    var(--text-faint) 72% 79%,
    transparent 79%
  );
  transition: opacity var(--dur-fast);
}

.emu-enter-active {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur-slow) var(--ease-spring);
}
.emu-leave-active {
  transition:
    opacity var(--dur-fast) ease-in,
    transform var(--dur-fast) ease-in;
}
.emu-enter-from,
.emu-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.94);
}
.emu-window {
  transform-origin: top left;
}

/* ── On a phone ── */
.emu-phone-bar,
.emu-phone-grip,
.emu-window.is-phone {
  /* A drag or a pinch here moves the window, never the page. */
  touch-action: none;
}
.emu-window.is-snapping {
  transition:
    left var(--dur) var(--ease-out),
    top var(--dur) var(--ease-out);
}
.emu-phone-grip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  font-size: 15px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--bg-900) 75%, transparent);
  border: 1px solid var(--border-strong);
}
.emu-phone-grip.is-active {
  color: var(--accent-light);
}
.emu-phone-grip.is-br {
  right: 0;
  bottom: 0;
  border-radius: 12px 0 0 0;
}
.emu-phone-grip.is-bl {
  left: 0;
  bottom: 0;
  border-radius: 0 12px 0 0;
  transform: scaleX(-1);
}
.emu-phone-grip.is-tr {
  right: 0;
  top: 44px;
  border-radius: 0 0 0 12px;
  transform: scaleY(-1);
}
.emu-phone-grip.is-tl {
  left: 0;
  top: 44px;
  border-radius: 0 0 12px 0;
  transform: scale(-1);
}
</style>
