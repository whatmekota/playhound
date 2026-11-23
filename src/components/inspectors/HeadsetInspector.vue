<script setup lang="ts">
import { computed } from 'vue'
import { toast } from '~/composables/useToast'
import { useXrServer } from '~/composables/useXrHost'
import { usePlaybackStore } from '~/stores/playbackStore'

/**
 * The headset player: playhound in a VR headset's browser (a Quest's), over
 * the computer's network, with the device still on the computer. The page
 * there is pages/xr.vue; the computer's side, composables/useXrHost.ts.
 */

const xr = useXrServer()
const playback = usePlaybackStore()
const s = xr.state

const following = computed(() => playback.external?.owner === 'headset' ? playback.external.title : '')
const address = computed(() => s.value?.urls[0] ?? '')
const others = computed(() => s.value?.urls.slice(1) ?? [])
/** The code in two halves, easier to read across a room. */
const codeShown = computed(() => (s.value?.code ? `${s.value.code.slice(0, 3)} ${s.value.code.slice(3)}` : ''))

type Tone = 'off' | 'warn' | 'info' | 'ok'
const state = computed<{ tone: Tone, label: string, detail: string }>(() => {
  if (!xr.available)
    return { tone: 'off', label: 'Desktop app only', detail: 'The headset connects to the playhound app on your computer' }
  if (s.value?.error)
    return { tone: 'warn', label: 'Could not start', detail: s.value.error }
  if (!s.value?.on)
    return { tone: 'off', label: 'Off', detail: 'Turn on to watch in a headset' }
  if (following.value)
    return { tone: 'ok', label: 'Playing in the headset', detail: following.value }
  if (s.value.headsets)
    return { tone: 'ok', label: 'Headset connected', detail: 'Pick a video in the headset' }
  return { tone: 'info', label: 'Waiting for a headset', detail: 'Open the address below in its browser' }
})

const TILE: Record<Tone, string> = {
  off: 'bg-surface-800 text-fg-muted',
  warn: 'bg-warn/12 text-warn',
  info: 'bg-info/12 text-info',
  ok: 'bg-ok/12 text-ok',
}
const DOT: Record<Tone, string> = {
  off: 'bg-fg-faint',
  warn: 'bg-warn text-warn',
  info: 'bg-info text-info animate-pulse-dot',
  ok: 'bg-ok text-ok animate-pulse-dot',
}

const on = computed({
  get: () => !!s.value?.on,
  set: v => void xr.start(v),
})

async function copy() {
  try {
    await navigator.clipboard.writeText(address.value)
    toast.success('Address copied', { icon: 'i-carbon-copy-link', key: 'xr-link' })
  }
  catch {
    toast.error('Could not copy the address', { key: 'xr-link' })
  }
}

async function forget() {
  await xr.forget()
  toast('Headsets forgotten', { detail: 'Each needs the code again', icon: 'i-carbon-unlink', key: 'xr-forget' })
}

const STEPS = [
  'Put the headset on and open its browser.',
  'Go to the address above.',
  'The browser warns that the connection isn\'t private: that is this computer\'s own certificate. Choose Advanced, then go on to the page. It asks once.',
  'Type the code. The headset stays paired after that.',
  'Pick a video and press Enter VR.',
]
</script>

<template>
  <UiPanel>
    <!-- ─── Hero ──────────────────────────────────────────────────────────── -->
    <section class="p-3 card flex gap-3 items-center">
      <div class="rounded-[var(--radius-md)] center shrink-0 h-11 w-11 transition-colors duration-300 relative" :class="TILE[state.tone]">
        <span class="i-carbon-augmented-reality text-[21px]" />
        <span class="rounded-full h-2.5 w-2.5 ring-2 ring-surface-850 transition-colors duration-300 absolute -right-0.5 -top-0.5" :class="DOT[state.tone]" />
      </div>
      <div class="flex-1 min-w-0">
        <Transition name="t-fade" mode="out-in">
          <p :key="state.label" class="text-[14px] text-fg tracking-[-0.01em] font-semibold truncate">
            {{ state.label }}
          </p>
        </Transition>
        <p class="hint truncate">
          {{ state.detail }}
        </p>
      </div>
      <UiSwitch v-if="xr.available" v-model="on" aria-label="Headset player" />
    </section>

    <Transition name="t-fade" mode="out-in">
      <UiEmpty
        v-if="!s?.on"
        key="off"
        icon="i-carbon-augmented-reality"
        size="sm"
        title="Watch in a VR headset"
        :description="xr.available
          ? 'Your library in the headset\'s browser, VR videos in 3D, and the device on this computer following along, with everything it does here: latency, tweaks, intensity, edges and panic.'
          : 'This needs the playhound app on your computer: the headset connects to it over your network.'"
      >
        <UiButton v-if="xr.available" variant="primary" icon="i-carbon-power" @click="on = true">
          Turn on
        </UiButton>
      </UiEmpty>

      <div v-else key="on" class="flex flex-col gap-2.5">
        <!-- ─── Pairing ─────────────────────────────────────────────────── -->
        <UiSection title="Connect the headset" icon="i-carbon-link">
          <div class="label">
            In the headset's browser, open
          </div>
          <button
            v-tip="'Copy'"
            type="button"
            class="group text-[13px] text-fg font-mono px-3 py-2.5 text-left focusable border border-edge-strong rounded-[var(--radius-md)] bg-surface-950/60 flex gap-2 w-full transition-colors items-center hover:border-accent/50"
            @click="copy"
          >
            <span class="flex-1 min-w-0 break-all">{{ address || 'No network address: is this computer on a network?' }}</span>
            <span class="i-carbon-copy text-[14px] text-fg-faint shrink-0 transition-colors group-hover:text-accent-300" />
          </button>
          <p v-if="others.length" class="hint">
            Not reachable? This computer is also at {{ others.join(', ') }}.
          </p>

          <div class="label mt-1">
            Then type this code
          </div>
          <div class="flex gap-3 items-center">
            <span class="text-[26px] text-fg tracking-[0.12em] font-mono font-semibold num">{{ codeShown }}</span>
            <UiButton size="sm" variant="ghost" icon="i-carbon-renew" class="ml-auto" @click="xr.newCode()">
              New code
            </UiButton>
          </div>
          <p class="hint">
            A code pairs one headset and is replaced after; a few wrong tries replace it too.
          </p>
        </UiSection>

        <!-- ─── How ─────────────────────────────────────────────────────── -->
        <UiSection title="In the headset" icon="i-carbon-list-numbered">
          <ol class="text-[12.5px] text-fg-muted leading-relaxed flex flex-col gap-1.5">
            <li v-for="(step, i) in STEPS" :key="i" class="flex gap-2.5">
              <span class="text-[11px] text-accent-300 font-semibold rounded-full bg-accent-soft center shrink-0 h-5 w-5">{{ i + 1 }}</span>
              <span>{{ step }}</span>
            </li>
          </ol>
        </UiSection>

        <!-- ─── Headsets ────────────────────────────────────────────────── -->
        <UiSection title="Headsets" icon="i-carbon-devices" :live="(s?.headsets ?? 0) > 0" :summary="`${s?.headsets ?? 0}`">
          <p class="hint">
            {{ s?.headsets ? `${s.headsets} connected now.` : 'None connected now.' }}
            {{ s?.paired ? `${s.paired} paired.` : '' }}
          </p>
          <UiButton v-if="s?.paired" size="sm" variant="ghost" icon="i-carbon-unlink" class="self-start" @click="forget">
            Forget paired headsets
          </UiButton>
        </UiSection>
      </div>
    </Transition>
  </UiPanel>
</template>
