<script setup lang="ts">
import type { RemoteAction, RemoteState } from '~/composables/useRemoteLink'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRemoteLink } from '~/composables/useRemoteLink'
import { PAD_KEEPALIVE_MS, PAD_SEND_MS, padHeight } from '~/lib/strokePad'
import { formatTime } from '~/lib/time'

defineOptions({ name: 'RemotePage' })

/**
 * The phone end of the remote.
 *
 * Used one-handed and often without looking, so: few, large targets, the
 * thumb zone at the bottom holds panic, every press buzzes, and nothing
 * depends on reading small text.
 */

const route = useRoute()
const room = computed(() => String(route.query.room ?? ''))

const state = ref<RemoteState | null>(null)

const link = useRemoteLink('remote', () => room.value, (msg) => {
  if (msg?.type === 'state')
    state.value = msg.state
})

const hostOnline = computed(() => link.peers.value.hosts > 0)
const online = computed(() => link.connected.value && hostOnline.value)

const conn = computed<{ tone: 'ok' | 'warn' | 'danger', label: string }>(() => {
  if (!room.value)
    return { tone: 'danger', label: 'No room' }
  if (!link.connected.value)
    return { tone: 'warn', label: 'Connecting' }
  if (!hostOnline.value)
    return { tone: 'warn', label: 'Waiting for desktop' }
  return { tone: 'ok', label: 'Connected' }
})

// A press that lands buzzes; one that cannot (offline) does nothing, so a
// missing buzz is itself the signal.
function send(action: RemoteAction) {
  if (!online.value)
    return
  link.send({ type: 'cmd', action })
  navigator.vibrate?.(action === 'panic' ? [40, 30, 60] : action === 'edge' ? [24, 40, 24] : 12)
}

onMounted(() => {
  if (room.value)
    link.connect()
})
// Ask for the desktop's state once both ends are there: a hello sent before
// the socket opened was lost, and a desktop that comes (back) later has
// never seen one.
watch(online, (on) => {
  if (on)
    link.send({ type: 'hello' })
}, { immediate: true })

const title = computed(() => state.value?.title.replace(/\.[^.]+$/, '') ?? '')
// The knob when the desktop sends one; an older desktop only had the session's.
const intensity = computed(() => Math.round((state.value?.knob ?? state.value?.intensity ?? 0) * 100))

// ─── Edge ─────────────────────────────────────────────────────────────────────
const edge = computed(() => state.value?.edge ?? null)
const edgeActive = computed(() => !!edge.value && edge.value.phase !== 'idle')
const edgeHolding = computed(() => edge.value?.phase === 'falling' || edge.value?.phase === 'holding')
/** Ring fill: what is left of the whole edge. */
const edgeLeft = computed(() => {
  const e = edge.value
  return e && e.total > 0 ? Math.max(0, Math.min(1, e.remaining / e.total)) : 0
})
const edgeText = computed(() => {
  const e = edge.value
  if (!e)
    return ''
  return edgeHolding.value ? `Holding ${formatTime(e.hold, '0:00')}` : `Easing back ${formatTime(e.remaining, '0:00')}`
})
const RING_C = 2 * Math.PI * 17
const phase = computed(() => (state.value?.phase && state.value.phase !== 'idle' ? state.value.phase : ''))

// ─── Keep the screen awake ────────────────────────────────────────────────────
// A remote that locks itself mid-session is no remote. Opt-in, as it costs battery.
const wakeSupported = 'wakeLock' in navigator
const awake = ref(false)
let lock: { release: () => Promise<void> } | null = null

async function acquire() {
  try {
    lock = await (navigator as any).wakeLock.request('screen')
  }
  catch {
    awake.value = false
  }
}
async function toggleAwake() {
  awake.value = !awake.value
  if (awake.value) {
    await acquire()
  }
  else {
    await lock?.release().catch(() => {})
    lock = null
  }
}
// The browser drops the lock whenever the page is hidden; take it back.
function onVisible() {
  if (document.visibilityState === 'visible' && awake.value)
    void acquire()
}
onMounted(() => document.addEventListener('visibilitychange', onVisible))
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisible)
  void lock?.release().catch(() => {})
})

// ─── Stroke pad ───────────────────────────────────────────────────────────────
// The finger's height is the stroke on the desktop (lib/strokePad): sent at
// most every PAD_SEND_MS while it moves and every PAD_KEEPALIVE_MS while it
// rests, so the desktop lets go if the phone goes quiet. Lifting it hands back.
const padOpen = ref(false)
const padEl = ref<HTMLElement | null>(null)
/** The finger's height, 0–1, while one is down. */
const finger = ref<number | null>(null)
const padAllowed = computed(() => !!state.value?.pad)
let pointer: number | null = null
let lastSentAt = 0
let lastEnd: 'top' | 'bottom' | null = null
let pendingSend: ReturnType<typeof setTimeout> | undefined
let keepAlive: ReturnType<typeof setInterval> | undefined

function sendPad(pos: number) {
  if (!online.value)
    return
  link.send({ type: 'pad', pos: Math.round(pos * 1000) / 1000 })
  lastSentAt = performance.now()
}

function padMove(e: PointerEvent) {
  if (e.pointerId !== pointer || !padEl.value)
    return
  const r = padEl.value.getBoundingClientRect()
  const pos = padHeight(e.clientY, r.top, r.height)
  finger.value = pos
  // A tick at either end, so the range can be felt without looking.
  const end = pos > 0.97 ? 'top' : pos < 0.03 ? 'bottom' : null
  if (end && end !== lastEnd)
    navigator.vibrate?.(8)
  lastEnd = end
  clearTimeout(pendingSend)
  const wait = PAD_SEND_MS - (performance.now() - lastSentAt)
  if (wait <= 0)
    sendPad(pos)
  else
    pendingSend = setTimeout(() => finger.value !== null && sendPad(finger.value), wait)
}

function padDown(e: PointerEvent) {
  if (pointer !== null || !online.value || state.value?.panicked)
    return
  pointer = e.pointerId
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  navigator.vibrate?.(12)
  lastSentAt = 0
  padMove(e)
  clearInterval(keepAlive)
  keepAlive = setInterval(() => finger.value !== null && sendPad(finger.value), PAD_KEEPALIVE_MS)
}

function padUp(e?: PointerEvent) {
  if (e && e.pointerId !== pointer)
    return
  pointer = null
  clearTimeout(pendingSend)
  clearInterval(keepAlive)
  if (finger.value === null)
    return
  finger.value = null
  lastEnd = null
  link.send({ type: 'pad', up: true })
}

function closePad() {
  padUp()
  padOpen.value = false
}

function padPanic() {
  padUp()
  send('panic')
}
onBeforeUnmount(() => padUp())
</script>

<template>
  <div class="remote text-fg bg-surface-950 flex flex-col min-h-[100dvh] w-full select-none overflow-x-hidden">
    <!-- ─── Header ────────────────────────────────────────────────────────── -->
    <header class="px-5 pb-2 pt-4 flex shrink-0 gap-3 items-center">
      <span class="text-[17px] tracking-[-0.02em] font-bold">play<span class="text-accent-300">hound</span></span>
      <span
        class="text-[12px] font-medium ml-auto px-2.5 rounded-full flex gap-1.5 h-7 transition-colors duration-300 items-center"
        :class="conn.tone === 'ok' ? 'bg-ok/12 text-ok' : conn.tone === 'warn' ? 'bg-warn/12 text-warn' : 'bg-danger/12 text-danger'"
      >
        <span class="rounded-full bg-current h-1.5 w-1.5" :class="conn.tone !== 'danger' ? 'animate-pulse-dot' : ''" />
        {{ conn.label }}
      </span>
      <button
        v-if="wakeSupported && room"
        type="button"
        class="rounded-full center h-9 w-9 transition-colors"
        :class="awake ? 'bg-accent-soft text-accent-300' : 'text-fg-faint bg-surface-850'"
        :aria-pressed="awake"
        aria-label="Keep screen awake"
        @click="toggleAwake"
      >
        <span :class="awake ? 'i-carbon-light-filled' : 'i-carbon-light'" class="text-[17px]" />
      </button>
    </header>

    <!-- ─── No room ───────────────────────────────────────────────────────── -->
    <main v-if="!room" class="px-8 text-center flex flex-1 flex-col gap-4 animate-rise items-center justify-center">
      <div class="text-fg-muted rounded-[var(--radius-xl)] bg-surface-850 center h-16 w-16 ring-1 ring-edge">
        <span class="i-carbon-link text-[28px]" />
      </div>
      <p class="text-[18px] font-semibold">
        This link is missing its room
      </p>
      <p class="text-[14px] text-fg-muted leading-relaxed max-w-[300px]">
        On the desktop, open the Remote panel, switch it on, and open the link it shows on this phone.
      </p>
    </main>

    <template v-else>
      <!-- ─── Now playing ─────────────────────────────────────────────────── -->
      <section class="mx-4 mt-2 p-4 card flex shrink-0 flex-col gap-3 animate-rise">
        <div class="flex gap-2 items-center">
          <span class="eyebrow">Now playing</span>
          <span
            v-if="state"
            class="text-[11px] font-medium ml-auto px-2 rounded-full flex gap-1 h-5 items-center"
            :class="state.playing ? 'bg-accent-soft text-accent-300' : 'bg-fg/7 text-fg-muted'"
          >
            <span :class="state.playing ? 'i-carbon-play-filled-alt' : 'i-carbon-pause-filled'" class="text-[10px]" />
            {{ state.playing ? 'Playing' : 'Paused' }}
          </span>
        </div>
        <p class="text-[17px] leading-snug font-semibold min-h-[2.75em] break-words line-clamp-2" :class="title ? 'text-fg' : 'text-fg-faint'">
          {{ title || (online ? 'Nothing playing' : '—') }}
        </p>
        <div class="flex flex-wrap gap-1.5">
          <span v-if="phase" class="chip capitalize">
            <span class="i-carbon-time-plot" /> {{ phase }}
          </span>
          <span v-if="state?.motion" class="chip text-ok">
            <span class="i-carbon-wave-height" /> <span class="num">{{ Math.round(state.spm) }}</span> spm
          </span>
          <span v-if="state?.audio" class="chip text-info">
            <span class="i-carbon-headphones" /> Audio
          </span>
        </div>
      </section>

      <!-- ─── Transport ───────────────────────────────────────────────────── -->
      <section class="py-6 flex shrink-0 gap-5 items-center justify-center" :class="online ? '' : 'opacity-40'">
        <button type="button" class="rc-round h-16 w-16" :disabled="!online" aria-label="Previous" @click="send('prev')">
          <span class="i-carbon-skip-back-filled text-[26px]" />
        </button>
        <button
          type="button"
          class="rc-round text-accent-contrast bg-accent h-24 w-24 shadow-[0_12px_32px_-10px_var(--accent)]"
          :disabled="!online"
          :aria-label="state?.playing ? 'Pause' : 'Play'"
          @click="send('togglePlay')"
        >
          <Transition name="t-pop" mode="out-in">
            <span :key="String(state?.playing)" :class="state?.playing ? 'i-carbon-pause-filled' : 'i-carbon-play-filled-alt'" class="text-[38px]" />
          </Transition>
        </button>
        <button type="button" class="rc-round h-16 w-16" :disabled="!online" aria-label="Next" @click="send('next')">
          <span class="i-carbon-skip-forward-filled text-[26px]" />
        </button>
      </section>

      <!-- ─── Toggles ─────────────────────────────────────────────────────── -->
      <section class="px-4 shrink-0 gap-3 grid grid-cols-3" :class="online ? '' : 'opacity-40'">
        <button type="button" class="rc-tile" :disabled="!online" @click="send('random')">
          <span class="i-carbon-shuffle text-[22px]" />
          <span>Random</span>
        </button>
        <button
          type="button"
          class="rc-tile"
          :class="state?.motion ? 'is-on text-ok' : ''"
          :disabled="!online"
          :aria-pressed="!!state?.motion"
          @click="send('motionToggle')"
        >
          <span class="i-carbon-wave-height text-[22px]" />
          <span>Motion</span>
        </button>
        <button
          type="button"
          class="rc-tile"
          :class="state?.audio ? 'is-on text-info' : ''"
          :disabled="!online"
          :aria-pressed="!!state?.audio"
          @click="send('audioToggle')"
        >
          <span class="i-carbon-headphones text-[22px]" />
          <span>Audio</span>
        </button>
      </section>

      <!-- ─── Stroke pad: opens a screen of its own ──────────────────────── -->
      <section v-if="padAllowed" class="mx-4 mt-3 shrink-0" :class="online ? '' : 'opacity-40'">
        <button type="button" class="rc-tile rc-wide px-4 h-14 w-full" :disabled="!online" @click="padOpen = true">
          <span class="i-carbon-touch-1 text-[22px] text-accent-300" />
          <span class="text-[15px] text-fg font-semibold">Stroke pad</span>
          <span class="text-[12px] ml-auto truncate">Drive it with a finger</span>
        </button>
      </section>

      <!-- ─── Edge: big, near the thumb, above panic (gone while edges are off) ─ -->
      <section v-if="state?.edges !== false" class="mx-4 mt-3 flex shrink-0 gap-3" :class="online ? '' : 'opacity-40'">
        <button
          type="button"
          class="rc-edge rounded-[var(--radius-xl)] flex flex-1 gap-3 h-[4.5rem] min-w-0 items-center"
          :class="edgeActive ? 'is-live px-4' : 'justify-center'"
          :disabled="!online"
          :aria-label="edgeActive ? 'Still close: edge again' : 'Edge: back everything off'"
          @click="send('edge')"
        >
          <template v-if="edgeActive && edge">
            <span class="shrink-0 h-11 w-11 relative">
              <svg viewBox="0 0 40 40" class="h-full w-full -rotate-90" aria-hidden="true">
                <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="3" />
                <circle
                  class="rc-ring" cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
                  :stroke-dasharray="RING_C" :stroke-dashoffset="RING_C * (1 - edgeLeft)"
                />
              </svg>
              <span class="text-[13px] font-semibold num center inset-0 absolute">{{ edge.count }}</span>
            </span>
            <span class="text-left flex flex-col min-w-0">
              <span class="text-[16px] font-semibold num truncate">{{ edgeText }}</span>
              <span class="text-[12px] opacity-75 truncate">Tap again if still close</span>
            </span>
          </template>
          <template v-else>
            <span class="i-carbon-temperature-hot text-[24px]" />
            <span class="text-[17px] font-semibold">Edge</span>
          </template>
        </button>
        <Transition name="t-pop">
          <button
            v-if="edgeHolding"
            type="button"
            class="rc-round text-ok px-4 rounded-[var(--radius-xl)] flex-col gap-0.5 h-[4.5rem] w-[5.5rem]"
            :disabled="!online"
            aria-label="I'm OK: end the hold"
            @click="send('edgeRelease')"
          >
            <span class="i-carbon-checkmark-outline text-[22px]" />
            <span class="text-[12.5px] font-medium">I’m OK</span>
          </button>
        </Transition>
      </section>

      <!-- ─── Intensity ───────────────────────────────────────────────────── -->
      <section class="mx-4 mt-3 p-3 card flex shrink-0 gap-3 items-center" :class="online ? '' : 'opacity-40'">
        <button type="button" class="rc-round h-14 w-14" :disabled="!online" aria-label="Less intense" @click="send('intensityDown')">
          <span class="i-carbon-subtract text-[24px]" />
        </button>
        <div class="flex flex-1 flex-col gap-2 min-w-0">
          <div class="flex items-baseline justify-between">
            <span class="eyebrow">Intensity</span>
            <span class="text-[20px] tracking-[-0.02em] font-semibold num">{{ intensity }}<span class="text-[12px] text-fg-faint">%</span></span>
          </div>
          <div class="rounded-full bg-surface-700 h-2 overflow-hidden">
            <div class="rounded-full bg-accent h-full transition-[width] duration-300 ease-[var(--ease-out)]" :style="{ width: `${intensity}%` }" />
          </div>
        </div>
        <button type="button" class="rc-round h-14 w-14" :disabled="!online" aria-label="More intense" @click="send('intensityUp')">
          <span class="i-carbon-add text-[24px]" />
        </button>
      </section>

      <div class="flex-1 min-h-4" />

      <!-- ─── Offline note ────────────────────────────────────────────────── -->
      <Transition name="t-fade">
        <p v-if="!online" class="text-[13px] text-fg-muted px-6 pb-3 text-center">
          {{ link.connected.value ? 'Open the Remote panel on the desktop and switch it on.' : 'Reaching the relay… check you are on the same network.' }}
        </p>
      </Transition>

      <!-- ─── Panic: biggest target, in the thumb zone ────────────────────── -->
      <section class="panic-wrap px-4 pt-1 shrink-0">
        <button
          type="button"
          class="rc-panic text-[17px] font-semibold rounded-[var(--radius-xl)] flex gap-2.5 h-[4.5rem] w-full items-center justify-center"
          :class="state?.panicked ? 'bg-ok/16 text-ok ring-1 ring-ok/30' : 'bg-danger text-surface-950 shadow-[0_12px_32px_-12px_var(--danger)]'"
          :disabled="!online"
          @click="send('panic')"
        >
          <span :class="state?.panicked ? 'i-carbon-play-filled-alt' : 'i-carbon-warning-alt'" class="text-[22px]" />
          {{ state?.panicked ? 'Resume' : 'Panic' }}
        </button>
        <p class="text-[11.5px] text-fg-faint mt-2 text-center">
          {{ state?.panicked ? 'Everything is stopped and covered on the desktop' : 'Stops video, audio and device at once' }}
        </p>
      </section>

      <!-- ─── The stroke pad's own screen ─────────────────────────────────── -->
      <Transition name="t-fade">
        <div v-if="padOpen" class="pad-screen bg-surface-950 flex flex-col inset-0 fixed z-50">
          <header class="px-5 pb-3 pt-4 flex shrink-0 gap-3 items-center">
            <span class="text-[17px] font-semibold">Stroke pad</span>
            <span class="chip" :class="state?.padHeld ? 'text-ok' : ''">
              {{ !online ? 'Offline' : state?.panicked ? 'Panic is on' : state?.padHeld ? 'You have it' : 'Touch to take over' }}
            </span>
            <button type="button" class="rc-round ml-auto h-10 w-10" aria-label="Close the stroke pad" @click="closePad">
              <span class="i-carbon-close text-[20px]" />
            </button>
          </header>
          <div
            ref="padEl"
            class="pad mx-4 rounded-[var(--radius-xl)] flex-1 relative overflow-hidden"
            :class="[finger !== null ? 'is-down' : '', online && !state?.panicked ? '' : 'opacity-40']"
            @pointerdown="padDown"
            @pointermove="padMove"
            @pointerup="padUp"
            @pointercancel="padUp"
            @lostpointercapture="padUp"
          >
            <span class="pad-label top-3">Top</span>
            <span class="pad-label bottom-3">Bottom</span>
            <template v-if="finger !== null">
              <div class="pad-fill inset-x-0 bottom-0 absolute" :style="{ height: `${finger * 100}%` }" />
              <div class="pad-line inset-x-0 absolute" :style="{ bottom: `${finger * 100}%` }" />
            </template>
            <p v-else class="text-[14px] text-fg-muted leading-relaxed px-10 text-center flex items-center inset-0 justify-center absolute">
              Slide up and down: the stroke follows your finger. Lift it to hand back to what was playing.
            </p>
          </div>
          <section class="panic-wrap px-4 pt-3 shrink-0">
            <button
              type="button"
              class="rc-panic text-[17px] font-semibold rounded-[var(--radius-xl)] flex gap-2.5 h-16 w-full items-center justify-center"
              :class="state?.panicked ? 'bg-ok/16 text-ok ring-1 ring-ok/30' : 'bg-danger text-surface-950'"
              :disabled="!online"
              @click="padPanic"
            >
              <span :class="state?.panicked ? 'i-carbon-play-filled-alt' : 'i-carbon-warning-alt'" class="text-[22px]" />
              {{ state?.panicked ? 'Resume' : 'Panic' }}
            </button>
          </section>
        </div>
      </Transition>
    </template>
  </div>
</template>

<style scoped>
.remote {
  /* Fast taps must never zoom the page. */
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  padding-top: env(safe-area-inset-top);
}

.panic-wrap {
  padding-bottom: max(16px, env(safe-area-inset-bottom));
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--text) 6%, transparent);
  font-size: 12px;
  color: var(--text-muted);
}
.chip.text-ok {
  color: var(--ok);
}
.chip.text-info {
  color: var(--info);
}

.rc-round,
.rc-tile,
.rc-edge,
.rc-panic {
  transition:
    transform var(--dur-fast) var(--ease-out),
    background-color var(--dur) var(--ease-out),
    color var(--dur) var(--ease-out),
    opacity var(--dur);
}
.rc-round:active:not(:disabled),
.rc-tile:active:not(:disabled),
.rc-edge:active:not(:disabled),
.rc-panic:active:not(:disabled) {
  transform: scale(0.94);
}

.rc-round {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 9999px;
}
.rc-round:not(.bg-accent) {
  background: var(--bg-850);
  box-shadow: inset 0 0 0 1px var(--border-strong);
  color: var(--text);
}
.rc-round:not(.bg-accent):active:not(:disabled) {
  background: var(--bg-700);
}

.rc-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 5rem;
  min-width: 0;
  border-radius: var(--radius-lg);
  background: var(--bg-850);
  box-shadow: inset 0 0 0 1px var(--border);
  color: var(--text-muted);
  font-size: 12.5px;
  font-weight: 500;
}
.rc-tile.is-on {
  background: color-mix(in srgb, currentColor 12%, var(--bg-850));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 30%, transparent);
}
.rc-tile:active:not(:disabled) {
  background: var(--bg-700);
}

.rc-edge {
  background: color-mix(in srgb, var(--warn) 14%, var(--bg-850));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warn) 35%, transparent);
  color: var(--warn);
}
.rc-edge.is-live {
  background: color-mix(in srgb, var(--warn) 22%, var(--bg-850));
}
.rc-wide {
  flex-direction: row;
  justify-content: flex-start;
  gap: 10px;
}

.pad-screen {
  padding-top: env(safe-area-inset-top);
}
.pad {
  /* The finger owns the pad: no scrolling, no zoom, no text selection. */
  touch-action: none;
  background:
    repeating-linear-gradient(to top, transparent 0 calc(25% - 1px), var(--border) calc(25% - 1px) 25%),
    linear-gradient(to top, color-mix(in srgb, var(--accent) 8%, var(--bg-850)), var(--bg-850));
  box-shadow: inset 0 0 0 1px var(--border-strong);
  transition: box-shadow var(--dur) var(--ease-out);
}
.pad.is-down {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
}
.pad-label {
  position: absolute;
  left: 16px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
  pointer-events: none;
}
.pad-fill {
  background: linear-gradient(
    to top,
    color-mix(in srgb, var(--accent) 30%, transparent),
    color-mix(in srgb, var(--accent) 8%, transparent)
  );
  pointer-events: none;
}
.pad-line {
  height: 4px;
  margin-bottom: -2px;
  background: var(--accent);
  box-shadow: 0 0 18px var(--accent);
  pointer-events: none;
}

/* The host sends the countdown once a second; glide between the ticks. */
.rc-ring {
  transition: stroke-dashoffset 1s linear;
}
</style>
