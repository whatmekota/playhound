<script setup lang="ts">
import type { LatencyEstimate } from '~/lib/latency'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import UiModal from '~/components/ui/UiModal.vue'
import UiProgress from '~/components/ui/UiProgress.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { useTCode } from '~/composables/useTCode'
import { toast } from '~/composables/useToast'
import { useDeviceLatency } from '~/composables/useVideoSync'
import { clampLatency, estimateLatency } from '~/lib/latency'
import { useDeviceStore } from '~/stores/deviceStore'
import { useMotionStore } from '~/stores/motionStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useUiStore } from '~/stores/uiStore'

/**
 * Tap-along latency test.
 *
 * The stroke runs in straight lines between two points, so every turn is a
 * sharp, unmistakable moment, and each move is commanded to take exactly one
 * turn-gap: the device is told to *be* at the turn at send time + gap. The
 * user taps on every turn they see or feel; how far the taps land after the
 * commanded turns is the latency.
 */
const open = defineModel<boolean>('open', { default: false })

const device = useDeviceStore()
const motion = useMotionStore()
const player = usePlayerStore()
const playback = usePlaybackStore()
const safety = useSafetyStore()
const ui = useUiStore()
const { sendPosition, homeAllAxes } = useTCode()
const latency = useDeviceLatency()

const RATES = [
  { value: 40, label: 'Slow', title: '40 strokes a minute' },
  { value: 50, label: 'Medium', title: '50 strokes a minute' },
  { value: 60, label: 'Brisk', title: '60 strokes a minute' },
]
const spm = ref(40)
/** Two turns per stroke. */
const gapMs = computed(() => 60_000 / spm.value / 2)

const LEAD_IN = 4
const MEASURE = 24
/** Turns at the start of the measured run whose taps are thrown away. */
const SKIP_TAPS = 2
/** Gentle travel: this is a metronome, not a session. */
const LOW = 0.2
const HIGH = 0.8

const hardware = computed(() => device.connected && device.deviceEnabled)
const showBar = ref(true)

type Phase = 'ready' | 'leadin' | 'measuring' | 'done'
const phase = ref<Phase>('ready')
const turnIndex = ref(0)
const tapCount = ref(0)
const tapFlash = ref(0)
const result = ref<LatencyEstimate | null>(null)

watch(open, (v) => {
  if (v) {
    // With hardware, tapping to the screen would measure the screen.
    showBar.value = !hardware.value
    phase.value = 'ready'
    result.value = null
    window.addEventListener('keydown', onKey, true)
  }
  else {
    abort()
    window.removeEventListener('keydown', onKey, true)
  }
})

let turns: number[] = []
let taps: number[] = []
let measureFrom = 0
let timer: ReturnType<typeof setTimeout> | null = null
let raf: number | null = null
let restoreMotion = false

// The bar's motion, mirrored from the commands: from `fromPos` at `moveAt`,
// reaching `toPos` one gap later.
let fromPos = 0.5
let toPos = 0.5
let moveAt = 0
const bar = ref<HTMLElement | null>(null)

function drawBar() {
  const el = bar.value
  if (el) {
    const f = Math.min(1, Math.max(0, (performance.now() - moveAt) / gapMs.value))
    const p = fromPos + (toPos - fromPos) * f
    el.style.bottom = `calc(${(p * 100).toFixed(2)}% - 6px)`
  }
  raf = requestAnimationFrame(drawBar)
}

function turn(k: number, t0: number) {
  const now = performance.now()
  const target = k % 2 ? HIGH : LOW
  sendPosition('L0', target, Math.round(gapMs.value))
  fromPos = toPos
  toPos = target
  moveAt = now
  // When the device was told to arrive — the moment the user should tap.
  if (k >= LEAD_IN)
    turns.push(now + gapMs.value)
  if (k === LEAD_IN) {
    phase.value = 'measuring'
    measureFrom = now + gapMs.value / 2
  }
  turnIndex.value = k

  if (k >= LEAD_IN + MEASURE) {
    // Let the last move land and give the user its tap, then wrap up.
    timer = setTimeout(finish, gapMs.value * 1.6)
    return
  }
  // Scheduled against the start rather than the last tick, so timer jitter
  // never accumulates into a drifting tempo.
  timer = setTimeout(() => turn(k + 1, t0), Math.max(0, t0 + (k + 1) * gapMs.value - performance.now()))
}

function begin() {
  turns = []
  taps = []
  tapCount.value = 0
  result.value = null
  turnIndex.value = 0
  phase.value = 'leadin'

  // Nothing else may move the stroke axis while the test does.
  if (player.isPlaying)
    playback.pause()
  restoreMotion = motion.enabled
  motion.enabled = false

  if (raf === null)
    raf = requestAnimationFrame(drawBar)

  // Start from the bottom, and leave pausing a moment to send its own home.
  sendPosition('L0', LOW, 500)
  fromPos = 0.5
  toPos = LOW
  moveAt = performance.now()
  timer = setTimeout(() => turn(1, performance.now() - gapMs.value), 700)
}

function teardown() {
  if (timer !== null)
    clearTimeout(timer)
  timer = null
  if (raf !== null)
    cancelAnimationFrame(raf)
  raf = null
  if (restoreMotion)
    motion.enabled = true
  restoreMotion = false
}

function finish() {
  teardown()
  void homeAllAxes(500)
  result.value = estimateLatency(turns, taps, { turnGapMs: gapMs.value, skipFirst: SKIP_TAPS })
  phase.value = 'done'
}

function abort() {
  const running = phase.value === 'leadin' || phase.value === 'measuring'
  teardown()
  if (running) {
    void homeAllAxes(500)
    phase.value = 'ready'
  }
}

function tap() {
  if (phase.value !== 'leadin' && phase.value !== 'measuring')
    return
  const t = performance.now()
  tapFlash.value++
  if (phase.value === 'measuring' && t >= measureFrom) {
    taps.push(t)
    tapCount.value++
  }
}

// Capture on window, ahead of the shell's own Space (play/pause) handler —
// for as long as the dialog is open, so a stray press never starts the video.
function onKey(e: KeyboardEvent) {
  if (e.code !== 'Space' && e.key !== ' ')
    return
  e.preventDefault()
  e.stopImmediatePropagation()
  if (!e.repeat)
    tap()
}

watch(() => safety.panicked, (p) => {
  if (p && open.value) {
    abort()
    open.value = false
  }
})

onBeforeUnmount(() => {
  abort()
  window.removeEventListener('keydown', onKey, true)
})

// ── Readout ──────────────────────────────────────────────────────────────────
const progress = computed(() => phase.value === 'measuring'
  ? Math.min(1, (turnIndex.value - LEAD_IN) / MEASURE)
  : 0)

const signed = (ms: number) => `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${Math.abs(ms)}`

const CONFIDENCE = {
  high: { tone: 'ok' as const, label: 'High confidence', note: 'Your taps were tight and consistent.' },
  medium: { tone: 'warn' as const, label: 'Medium confidence', note: 'Usable. Another run would firm it up.' },
  low: { tone: 'danger' as const, label: 'Low confidence', note: 'Taps were scattered. Try again, perhaps slower.' },
}

/** Strip plot: x is the offset across the matching window (±half a gap). */
const plot = computed(() => {
  const r = result.value
  if (!r)
    return null
  const half = gapMs.value / 2
  const x = (ms: number) => 4 + ((Math.max(-half, Math.min(half, ms)) + half) / (2 * half)) * 292
  return {
    dots: r.samples.map((s, i) => ({ x: x(s.offsetMs), y: 10 + ((i * 7) % 17), kept: s.kept })),
    median: x(r.offsetMs),
    zero: x(0),
    band: { x: x(r.offsetMs - r.spreadMs), w: x(r.offsetMs + r.spreadMs) - x(r.offsetMs - r.spreadMs) },
  }
})

function apply() {
  const r = result.value
  if (!r)
    return
  const before = latency.value
  latency.value = clampLatency(r.offsetMs)
  open.value = false
  toast.success(`Device latency set to ${signed(latency.value)} ms`, {
    icon: 'i-carbon-time',
    key: 'latency',
    action: { label: 'Undo', run: () => (latency.value = before) },
  })
}

const running = computed(() => phase.value === 'leadin' || phase.value === 'measuring')
</script>

<template>
  <UiModal
    v-model:open="open"
    title="Calibrate latency"
    subtitle="Tap along with the stroke, and playhound works out how late the device runs."
    icon="i-carbon-time"
    width="440px"
  >
    <div class="flex flex-col gap-4">
      <!-- What to watch -->
      <div
        class="text-[12.5px] px-3 py-2.5 rounded-[var(--radius-md)] flex gap-2.5 items-start"
        :class="hardware ? 'bg-ok/10 text-fg ring-1 ring-ok/20' : 'bg-info/10 text-fg ring-1 ring-info/20'"
      >
        <span :class="hardware ? 'i-carbon-plug-filled text-ok' : 'i-carbon-view text-info'" class="text-[15px] mt-px shrink-0" />
        <span v-if="hardware">
          Device connected. Watch or feel <b class="font-semibold">the device</b>, not the screen, and tap the instant it turns at the top and at the bottom.
        </span>
        <span v-else>
          No device connected, so this follows the bar below<template v-if="ui.isFloatingOpen('emulator')"> and the emulator</template>.
          The result is your own timing against the screen — good for trying it out, not for a real device.
        </span>
      </div>

      <!-- Stage: the bar and the tap pad -->
      <div class="gap-3 grid grid-cols-[56px_1fr]">
        <div class="well h-44 relative overflow-hidden" :class="showBar ? '' : 'opacity-35'">
          <div class="border-t border-edge-strong border-dashed inset-x-2 top-[20%] absolute" />
          <div class="border-t border-edge-strong border-dashed inset-x-2 bottom-[20%] absolute" />
          <div
            v-show="showBar"
            ref="bar"
            class="rounded-full bg-accent h-3 shadow-[0_0_14px_var(--accent)] inset-x-2 absolute"
            style="bottom: calc(50% - 6px)"
          />
          <span v-if="!showBar" class="i-carbon-view-off text-[18px] text-fg-faint left-1/2 top-1/2 absolute -translate-x-1/2 -translate-y-1/2" />
        </div>

        <button
          type="button"
          class="tap-pad focusable rounded-[var(--radius-lg)] bg-surface-800 flex flex-col gap-2 h-44 ring-1 ring-edge transition-colors items-center justify-center relative overflow-hidden"
          :class="running ? 'cursor-pointer hover:bg-surface-700' : 'cursor-default'"
          :disabled="!running"
          aria-label="Tap"
          @pointerdown.prevent="tap"
        >
          <span :key="tapFlash" class="flash rounded-[inherit] pointer-events-none inset-0 absolute" :class="tapFlash ? 'is-on' : ''" />
          <Transition name="t-fade" mode="out-in">
            <div v-if="phase === 'ready'" key="ready" class="px-4 text-center flex flex-col gap-1.5 items-center">
              <span class="i-carbon-touch-1 text-[26px] text-fg-faint" />
              <span class="text-[12.5px] text-fg-muted">Press <UiKbd>Space</UiKbd> or tap here on every turn</span>
            </div>
            <div v-else-if="phase === 'leadin'" key="leadin" class="text-center flex flex-col gap-1 items-center">
              <span class="text-[13px] text-fg font-medium">Find the rhythm</span>
              <span class="text-[12px] text-fg-muted num">starting in {{ Math.max(1, LEAD_IN - turnIndex) }}…</span>
            </div>
            <div v-else-if="phase === 'measuring'" key="measuring" class="text-center flex flex-col gap-1 items-center">
              <span class="text-[28px] text-fg leading-none font-semibold num">{{ tapCount }}</span>
              <span class="text-[11.5px] text-fg-muted">taps · keep going</span>
            </div>
            <div v-else key="done" class="text-center flex flex-col gap-1 items-center">
              <span class="i-carbon-checkmark-outline text-[24px] text-ok" />
              <span class="text-[12px] text-fg-muted">Done</span>
            </div>
          </Transition>
        </button>
      </div>

      <UiProgress v-if="running" :value="progress" />

      <!-- Settings, before a run -->
      <div v-if="phase === 'ready'" class="flex flex-col gap-2.5">
        <div class="flex gap-3 items-center justify-between">
          <span class="label">Tempo</span>
          <UiSegmented v-model="spm" :options="RATES" size="xs" />
        </div>
        <UiSwitch
          v-model="showBar"
          size="sm"
          label="Show the bar"
          :hint="hardware ? 'Off is better: the bar is the command, not the device' : 'Without a device it is the thing to follow'"
        />
        <UiButton
          v-if="!hardware && !ui.isFloatingOpen('emulator')"
          size="xs"
          variant="ghost"
          icon="i-carbon-cube"
          class="self-start"
          @click="ui.toggleFloating('emulator')"
        >
          Show the emulator too
        </UiButton>
      </div>

      <!-- Result -->
      <Transition name="t-collapse">
        <div v-if="phase === 'done'">
          <div class="min-h-0 overflow-hidden">
            <div v-if="result" class="p-3 card flex flex-col gap-3">
              <div class="flex gap-3 items-end justify-between">
                <div>
                  <p class="eyebrow">
                    Measured latency
                  </p>
                  <p class="text-[30px] text-fg leading-tight tracking-[-0.02em] font-semibold num">
                    {{ signed(result.offsetMs) }}<span class="text-[14px] text-fg-muted font-normal ml-1">ms</span>
                  </p>
                </div>
                <div class="pb-1 flex flex-col gap-1 items-end">
                  <UiBadge :tone="CONFIDENCE[result.confidence].tone" dot>
                    {{ CONFIDENCE[result.confidence].label }}
                  </UiBadge>
                  <span class="text-[11.5px] text-fg-faint num">±{{ result.spreadMs }} ms · {{ result.kept }}/{{ result.total }} taps</span>
                </div>
              </div>

              <svg v-if="plot" viewBox="0 0 300 36" class="h-9 w-full" aria-hidden="true">
                <line :x1="plot.zero" :x2="plot.zero" y1="2" y2="34" class="stroke-fg-faint" stroke-width="1" stroke-dasharray="2 2" />
                <rect :x="plot.band.x" y="4" :width="Math.max(1, plot.band.w)" height="28" rx="3" class="fill-accent/15" />
                <line :x1="plot.median" :x2="plot.median" y1="2" y2="34" class="stroke-accent" stroke-width="2" />
                <circle
                  v-for="(d, i) in plot.dots"
                  :key="i"
                  :cx="d.x"
                  :cy="d.y + 4"
                  r="2.6"
                  :class="d.kept ? 'fill-accent-300' : 'fill-fg-faint'"
                  :opacity="d.kept ? 0.9 : 0.6"
                />
              </svg>

              <p class="hint">
                {{ CONFIDENCE[result.confidence].note }}
                Currently {{ signed(latency) }} ms.
              </p>
            </div>

            <div v-else class="text-[12.5px] text-fg px-3 py-2.5 rounded-[var(--radius-md)] bg-warn/10 flex gap-2.5 ring-1 ring-warn/20">
              <span class="i-carbon-warning-alt text-[15px] text-warn mt-px shrink-0" />
              <span>Not enough taps to tell. Tap once on every turn, top and bottom, all the way through.</span>
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <template #footer>
      <template v-if="phase === 'ready'">
        <UiButton variant="ghost" @click="open = false">
          Cancel
        </UiButton>
        <UiButton variant="primary" icon="i-carbon-play-filled-alt" @click="begin">
          Start
        </UiButton>
      </template>
      <template v-else-if="running">
        <UiButton variant="secondary" icon="i-carbon-stop-filled-alt" @click="abort">
          Stop
        </UiButton>
      </template>
      <template v-else>
        <UiButton variant="ghost" @click="open = false">
          Cancel
        </UiButton>
        <UiButton icon="i-carbon-restart" @click="begin">
          Again
        </UiButton>
        <UiButton variant="primary" icon="i-carbon-checkmark" :disabled="!result" @click="apply">
          Apply
        </UiButton>
      </template>
    </template>
  </UiModal>
</template>

<style scoped>
.flash {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  opacity: 0;
}
.flash.is-on {
  animation: tap-flash 260ms var(--ease-out);
}
@keyframes tap-flash {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
</style>
