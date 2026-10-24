<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { setEmuInstance } from '~/composables/useTCode'
import { useUiStore } from '~/stores/uiStore'

/**
 * Floating 3D preview of an OSR2 / SR6, fed the same TCode as the hardware.
 *
 * The shell mounts this while the window is open; everything about the window
 * itself (model, place, size) is remembered here, so it comes back where it
 * was left. Closing from the title bar plays the exit animation first and only
 * then tells the shell, which unmounts it.
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
  'ph-emulator',
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

const box = computed(() => ({
  left: `${saved.value.x}px`,
  top: `${saved.value.y}px`,
  width: `${saved.value.w}px`,
  height: `${saved.value.h}px`,
}))

type Gesture = 'move' | 'resize' | null
const gesture = ref<Gesture>(null)

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

onMounted(() => {
  clamp()
  window.addEventListener('resize', clamp)
})
onBeforeUnmount(() => window.removeEventListener('resize', clamp))

// ─── Open / close ─────────────────────────────────────────────────────────────
const shown = ref(true)
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
  <Transition name="emu" appear @after-leave="afterLeave">
    <div
      v-if="shown"
      class="emu-window rounded-[var(--radius-lg)] glass flex flex-col ring-1 ring-edge-strong shadow-[var(--shadow-lg)] fixed z-[700] overflow-hidden"
      :class="gesture ? 'select-none' : ''"
      :style="box"
      role="dialog"
      aria-label="OSR emulator"
    >
      <!-- Title bar: the whole bar drags, the controls on it do not -->
      <header
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

      <!-- Resize grip -->
      <div
        class="emu-grip h-4 w-4 cursor-se-resize bottom-0 right-0 absolute z-10"
        :class="gesture === 'resize' ? 'opacity-100' : 'opacity-50 hover:opacity-100'"
        aria-hidden="true"
        @pointerdown="begin('resize', $event)"
      />
    </div>
  </Transition>
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
</style>
