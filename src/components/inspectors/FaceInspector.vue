<script setup lang="ts">
import type { FaceExpression, FaceSignals } from '~/lib/faceState'
import type { KerfusColor } from '~/lib/kerfus'
import { computed, ref } from 'vue'
import KerfusFace from '~/components/face/KerfusFace.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiPanel from '~/components/ui/UiPanel.vue'
import UiSection from '~/components/ui/UiSection.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { useFaceLink } from '~/composables/useFaceLink'
import { closeFaceWindow, faceScreenSettings, openFaceWindow } from '~/composables/useFaceScreen'
import { RC_PORT, remoteRoom } from '~/composables/useRemoteLink'
import { toast } from '~/composables/useToast'
import { FACE_RATE_MAX, FACE_RATE_MIN } from '~/lib/faceState'
import { KERFUS_COLORS } from '~/lib/kerfus'
import { remoteEnabled } from '~/stores/remoteStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'

const face = useFaceLink()
face.watchPreview()
const cfg = face.settings

// ─── Status ──────────────────────────────────────────────────────────────────
type Tone = 'off' | 'warn' | 'info' | 'ok'
const remotes = computed(() => face.peers.value.remotes)
const status = computed<{ tone: Tone, label: string, detail: string }>(() => {
  if (!cfg.value.enabled)
    return { tone: 'off', label: 'Off', detail: 'Turn on to have the CYD face follow the session' }
  if (!remoteEnabled.value)
    return { tone: 'warn', label: 'Remote relay is off', detail: 'The face listens on the same relay as the phone remote' }
  if (!face.relayConnected.value)
    return { tone: 'warn', label: 'Relay not reachable', detail: `Start it with pnpm dev:proxy (port ${RC_PORT})` }
  if (face.faceSeen.value)
    return { tone: 'ok', label: 'Face connected', detail: `${face.sentCount.value} frames sent` }
  if (remotes.value) {
    return {
      tone: 'info',
      label: `${remotes.value} remote${remotes.value === 1 ? '' : 's'} in the room`,
      detail: `${face.sentCount.value} frames sent · the relay cannot tell a face from a phone`,
    }
  }
  return { tone: 'info', label: 'Waiting for the face', detail: 'Nobody in the room, so nothing is sent' }
})

const TILE: Record<Tone, string> = {
  off: 'bg-surface-800',
  warn: 'bg-warn/10',
  info: 'bg-info/10',
  ok: 'bg-ok/10',
}
const DOT: Record<Tone, string> = {
  off: 'bg-fg-faint',
  warn: 'bg-warn text-warn',
  info: 'bg-info text-info animate-pulse-dot',
  ok: 'bg-ok text-ok animate-pulse-dot',
}

// ─── Preview ─────────────────────────────────────────────────────────────────
const msg = computed(() => face.preview.value)
const expr = computed(() => face.expression.value)

const EXPR_LABEL: Record<FaceExpression, { label: string, tone: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' }> = {
  sleepy: { label: 'Sleepy', tone: 'neutral' },
  calm: { label: 'Calm', tone: 'info' },
  focused: { label: 'Focused', tone: 'accent' },
  excited: { label: 'Excited', tone: 'warn' },
  flustered: { label: 'Flustered', tone: 'danger' },
  shocked: { label: 'Shocked', tone: 'danger' },
}

/** Mock face geometry per expression: how far the lids are down, and the mouth. */
const LOOK: Record<FaceExpression, { lid: number, pupil: number, mouth: string, blush: number }> = {
  sleepy: { lid: 0.78, pupil: 6, mouth: 'M54 63 Q60 64 66 63', blush: 0 },
  calm: { lid: 0.28, pupil: 6.5, mouth: 'M51 61 Q60 67 69 61', blush: 0 },
  focused: { lid: 0.4, pupil: 6, mouth: 'M53 63 L67 63', blush: 0 },
  excited: { lid: 0.08, pupil: 7.5, mouth: 'M49 59 Q60 73 71 59 Z', blush: 0.35 },
  flustered: { lid: 0.46, pupil: 7, mouth: 'M50 63 Q53.5 60 57 63 T64 63 T71 63', blush: 0.75 },
  shocked: { lid: 0, pupil: 3.5, mouth: 'M60 58 a4.5 5.5 0 1 0 0.01 0 Z', blush: 0 },
}
const look = computed(() => LOOK[expr.value])
/** Eyes drift with the stroke: up at the top of it, down at the bottom. */
const gazeY = computed(() => {
  const p = msg.value?.strokePos
  return p === undefined ? 0 : (0.5 - p) * 10
})

const json = computed(() => (msg.value ? JSON.stringify(msg.value, null, 2) : ''))
const bytes = computed(() => (json.value ? new TextEncoder().encode(JSON.stringify(msg.value)).length : 0))

// ─── Screen face ─────────────────────────────────────────────────────────────
const screen = faceScreenSettings()
const ctl = useSessionControlStore()
const edging = computed(() => ctl.phase === 'falling' || ctl.phase === 'holding')
const COLORS = Object.entries(KERFUS_COLORS) as [KerfusColor, string][]

// ─── Sending ─────────────────────────────────────────────────────────────────
const SIGNALS: { key: keyof FaceSignals, label: string, hint: string }[] = [
  { key: 'intensity', label: 'Intensity', hint: '0–1, from the session, the script or generated motion' },
  { key: 'strokePos', label: 'Stroke position', hint: 'Where L0 is, so the eyes can follow it. Most of the traffic' },
  { key: 'spm', label: 'Stroke rate', hint: 'Strokes per minute, for bobbing in time' },
  { key: 'phase', label: 'Session phase', hint: 'Entry, build, peak, descent' },
  { key: 'deviceConnected', label: 'Device connected', hint: 'Whether a stroker is plugged in' },
  { key: 'title', label: 'Video title', hint: 'Off keeps the file name off a screen others can see' },
]
const signalsOn = computed(() => SIGNALS.filter(s => cfg.value.signals[s.key]).length)

// ─── Pairing ─────────────────────────────────────────────────────────────────
const pairingOpen = ref(false)
const isLocalhost = computed(() => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))
const configSnippet = computed(() => [
  `#define PH_HOST  "${isLocalhost.value ? '<this PC\'s LAN address>' : location.hostname}"`,
  `#define PH_PORT  ${RC_PORT}`,
  `#define PH_ROOM  "${remoteRoom.value}"`,
].join('\n'))

async function copySnippet() {
  try {
    await navigator.clipboard.writeText(configSnippet.value)
    toast.success('Copied', { detail: 'Paste into firmware/cyd-face/config.h', icon: 'i-carbon-copy', key: 'face-copy' })
  }
  catch {
    toast.error('Could not copy', { key: 'face-copy' })
  }
}

function turnOnRelay() {
  remoteEnabled.value = true
}
</script>

<template>
  <UiPanel>
    <!-- ─── Hero: the face itself, and whether anything hears it ──────────── -->
    <section class="p-3 card flex flex-col gap-3">
      <div class="flex gap-3 items-center">
        <div class="rounded-[var(--radius-lg)] shrink-0 h-[68px] w-[102px] transition-colors duration-300 relative overflow-hidden" :class="TILE[status.tone]">
          <svg viewBox="0 0 120 80" class="face h-full w-full" :class="{ 'is-panic': msg?.panic }" aria-hidden="true">
            <defs>
              <clipPath id="face-eye-l"><ellipse cx="38" cy="34" rx="15" ry="16" /></clipPath>
              <clipPath id="face-eye-r"><ellipse cx="82" cy="34" rx="15" ry="16" /></clipPath>
            </defs>
            <g v-for="eye in [{ cx: 38, clip: 'face-eye-l' }, { cx: 82, clip: 'face-eye-r' }]" :key="eye.cx">
              <ellipse :cx="eye.cx" cy="34" rx="15" ry="16" class="fill-surface-950" />
              <g :clip-path="`url(#${eye.clip})`">
                <g class="gaze" :style="{ transform: `translateY(${gazeY}px)` }">
                  <circle :cx="eye.cx" cy="36" :r="look.pupil" class="pupil fill-accent" />
                  <circle :cx="eye.cx + 2.5" cy="32.5" r="1.8" class="fill-surface-950" />
                </g>
                <!-- The lid comes down from the top -->
                <rect :x="eye.cx - 16" y="17" width="32" :height="look.lid * 32" class="lid fill-surface-700" />
              </g>
              <ellipse :cx="eye.cx" cy="34" rx="15" ry="16" class="fill-none stroke-fg" stroke-width="2" />
            </g>
            <ellipse cx="22" cy="55" rx="8" ry="3.5" class="blush fill-danger" :opacity="look.blush" />
            <ellipse cx="98" cy="55" rx="8" ry="3.5" class="blush fill-danger" :opacity="look.blush" />
            <path :d="look.mouth" class="mouth stroke-fg" :class="expr === 'excited' || expr === 'shocked' ? 'fill-fg/80' : 'fill-none'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            <text v-if="expr === 'sleepy'" x="104" y="20" class="zz text-[11px] font-semibold fill-fg-faint">z</text>
          </svg>
          <span class="rounded-full h-2 w-2 ring-2 ring-surface-850 right-1.5 top-1.5 absolute" :class="DOT[status.tone]" />
        </div>
        <div class="flex-1 min-w-0">
          <Transition name="t-fade" mode="out-in">
            <p :key="status.label" class="text-[14px] text-fg tracking-[-0.01em] font-semibold truncate">
              {{ status.label }}
            </p>
          </Transition>
          <p class="hint line-clamp-2">
            {{ status.detail }}
          </p>
        </div>
      </div>

      <UiSwitch v-model="cfg.enabled" label="Drive the face" hint="Publish the session to the CYD over the remote relay" />

      <Transition name="t-collapse">
        <div v-if="cfg.enabled && !remoteEnabled">
          <div class="min-h-0 overflow-hidden">
            <div class="text-[12px] text-fg px-2.5 py-2 rounded-[var(--radius-md)] bg-warn/10 flex gap-2 ring-1 ring-warn/20 items-center">
              <span class="i-carbon-warning-alt text-[15px] text-warn shrink-0" />
              <span class="flex-1">The relay is off, so the face hears nothing.</span>
              <UiButton size="xs" variant="primary" @click="turnOnRelay">
                Turn on
              </UiButton>
            </div>
          </div>
        </div>
      </Transition>
    </section>

    <!-- ─── Live: what would go out right now ─────────────────────────────── -->
    <UiSection title="Live" icon="i-carbon-activity" :live="cfg.enabled && face.relayConnected.value && remotes > 0">
      <template #actions>
        <Transition name="t-fade" mode="out-in">
          <UiBadge :key="expr" :tone="EXPR_LABEL[expr].tone" dot>
            {{ EXPR_LABEL[expr].label }}
          </UiBadge>
        </Transition>
        <Transition name="t-fade">
          <span v-if="face.pendingExpression.value" class="text-[11px] text-fg-faint flex gap-0.5 items-center">
            <span class="i-carbon-arrow-right text-[11px]" />{{ EXPR_LABEL[face.pendingExpression.value].label }}
          </span>
        </Transition>
      </template>

      <div v-if="msg" class="flex flex-col gap-2.5">
        <div class="gap-x-3 gap-y-2 grid grid-cols-2">
          <div class="flex flex-col gap-1">
            <div class="flex items-baseline justify-between">
              <span class="label">Intensity</span>
              <span class="text-[11.5px] text-fg num">{{ msg.intensity !== undefined ? Math.round(msg.intensity * 100) : '—' }}</span>
            </div>
            <div class="rounded-full bg-surface-700 h-1.5 overflow-hidden">
              <div class="rounded-full bg-accent h-full transition-[width] duration-150" :style="{ width: `${(msg.intensity ?? 0) * 100}%` }" />
            </div>
          </div>
          <div class="flex flex-col gap-1">
            <div class="flex items-baseline justify-between">
              <span class="label">Stroke</span>
              <span class="text-[11.5px] text-fg num">{{ msg.strokePos !== undefined ? Math.round(msg.strokePos * 100) : '—' }}</span>
            </div>
            <div class="rounded-full bg-surface-700 h-1.5 relative">
              <div
                v-if="msg.strokePos !== undefined"
                class="rounded-full bg-info h-3 w-1 transition-[left] duration-100 top-1/2 absolute -translate-x-1/2 -translate-y-1/2"
                :style="{ left: `${msg.strokePos * 100}%` }"
              />
            </div>
          </div>
        </div>

        <div class="flex flex-wrap gap-1.5">
          <UiBadge size="xs" :tone="msg.playing ? 'ok' : 'neutral'" :icon="msg.playing ? 'i-carbon-play-filled-alt' : 'i-carbon-pause-filled'">
            {{ msg.playing ? 'Playing' : 'Paused' }}
          </UiBadge>
          <UiBadge v-if="msg.src" size="xs">
            from {{ msg.src }}
          </UiBadge>
          <UiBadge v-if="msg.spm !== undefined" size="xs" class="num">
            {{ msg.spm }} spm
          </UiBadge>
          <UiBadge v-if="msg.phase" size="xs">
            {{ msg.phase }}
          </UiBadge>
          <UiBadge v-if="msg.deviceConnected !== undefined" size="xs" :tone="msg.deviceConnected ? 'ok' : 'neutral'" icon="i-carbon-plug">
            {{ msg.deviceConnected ? 'Device' : 'No device' }}
          </UiBadge>
          <UiBadge v-if="msg.panic" size="xs" tone="danger" solid>
            Panic
          </UiBadge>
        </div>

        <div class="well relative">
          <pre class="text-[11px] text-fg-muted leading-[1.45] font-mono px-2.5 py-2 scroll-y max-h-48 whitespace-pre-wrap break-all">{{ json }}</pre>
          <span class="text-[10.5px] text-fg-faint num right-2 top-1.5 absolute">{{ bytes }} B</span>
        </div>
      </div>
      <div v-else class="flex flex-col gap-2">
        <div class="skeleton rounded-[var(--radius-sm)] h-4" />
        <div class="skeleton rounded-[var(--radius-sm)] h-24" />
      </div>
    </UiSection>

    <!-- ─── Screen face: Kerfus in a window of its own ───────────────────── -->
    <UiSection title="Screen face" icon="i-carbon-screen" :live="face.screenOpen.value" :summary="face.screenOpen.value ? 'open' : undefined">
      <div class="rounded-[var(--radius-lg)] bg-black flex h-[96px] items-center justify-center overflow-hidden">
        <KerfusFace class="h-full" :msg="msg" :edging="edging" :color="screen.color" />
      </div>
      <p class="hint">
        Kerfus, in a window you can put on a second monitor. It follows the session straight from this window, with no relay
        or board needed. The desktop app opens it full screen on your other display.
      </p>
      <div class="flex gap-2 items-center">
        <UiButton v-if="face.screenOpen.value" size="sm" icon="i-carbon-close" @click="closeFaceWindow">
          Close face window
        </UiButton>
        <UiButton v-else size="sm" variant="primary" icon="i-carbon-launch" @click="openFaceWindow">
          Open face window
        </UiButton>
        <div class="ml-auto flex gap-1.5" role="radiogroup" aria-label="Colour">
          <button
            v-for="[name, hex] in COLORS"
            :key="name"
            v-tip="name"
            type="button"
            role="radio"
            :aria-checked="screen.color === name"
            :aria-label="name"
            class="focusable rounded-full h-5 w-5 transition-shadow"
            :class="screen.color === name ? 'ring-2 ring-fg ring-offset-2 ring-offset-surface-850' : 'opacity-70 hover:opacity-100'"
            :style="{ background: hex }"
            @click="screen.color = name"
          />
        </div>
      </div>
      <UiSwitch v-model="screen.led" size="sm" label="Dot-matrix look" hint="Draw it as an LED panel, like the robot's screen" />
    </UiSection>

    <!-- ─── What and how often ────────────────────────────────────────────── -->
    <UiSection title="Sending" icon="i-carbon-send" :summary="`${cfg.rateHz} Hz · ${signalsOn} of ${SIGNALS.length}`">
      <UiSlider
        v-model="cfg.rateHz"
        label="Most frames per second"
        :min="FACE_RATE_MIN"
        :max="FACE_RATE_MAX"
        :step="1"
        unit=" Hz"
        :reset="10"
        hint="Frames only go out when something changed, plus one every 5 s so the face knows the desktop is still there."
      />
      <div class="pt-0.5 flex flex-col gap-2">
        <span class="eyebrow">Signals</span>
        <UiSwitch
          v-for="s in SIGNALS"
          :key="s.key"
          v-model="cfg.signals[s.key]"
          size="sm"
          :label="s.label"
          :hint="s.hint"
        />
        <p class="hint">
          Playing, panic and the expression always go.
        </p>
      </div>
    </UiSection>

    <!-- ─── Pairing ───────────────────────────────────────────────────────── -->
    <UiSection v-model:open="pairingOpen" title="Pairing" icon="i-carbon-link" collapsible summary="config.h">
      <p class="text-[12.5px] text-fg-muted">
        The face joins the phone remote's room. Put these in <span class="text-fg font-mono">firmware/cyd-face/config.h</span>:
      </p>
      <div class="well relative">
        <pre class="text-[11px] text-fg leading-[1.5] font-mono px-2.5 py-2 pr-9 whitespace-pre-wrap break-all">{{ configSnippet }}</pre>
        <UiIconButton icon="i-carbon-copy" label="Copy" size="xs" class="right-1 top-1 absolute" @click="copySnippet" />
      </div>
      <p class="hint">
        A new link in the Remote panel changes the room, and the face then needs reflashing. The message format is in
        <span class="font-mono">docs/face-protocol.md</span>.
      </p>
    </UiSection>
  </UiPanel>
</template>

<style scoped>
.face .gaze {
  transition: transform 110ms linear;
}
.face .lid {
  transition: height var(--dur) var(--ease-out);
}
.face .pupil {
  transition: r var(--dur) var(--ease-out);
}
.face .blush {
  transition: opacity var(--dur-slow) ease;
}
.face .zz {
  animation: face-zz 2.4s ease-in-out infinite;
}
.face.is-panic {
  filter: grayscale(1);
  opacity: 0.6;
}
@keyframes face-zz {
  0%,
  100% {
    opacity: 0.2;
    transform: translateY(2px);
  }
  50% {
    opacity: 1;
    transform: translateY(-2px);
  }
}
</style>
