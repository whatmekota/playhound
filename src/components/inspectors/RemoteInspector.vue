<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { RC_PORT, remoteRoom, remoteUrl } from '~/composables/useRemoteLink'
import { useRemoteStatus } from '~/composables/useRemoteStatus'
import { toast } from '~/composables/useToast'
import { remoteEnabled } from '~/stores/remoteStore'

const status = useRemoteStatus()

const url = computed(() => remoteUrl(remoteRoom.value))
// A phone cannot reach "localhost": the link has to carry the machine's LAN address.
const isLocalhost = computed(() => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))
const phones = computed(() => status.peers.value.remotes)

type Tone = 'off' | 'warn' | 'info' | 'ok'
const state = computed<{ tone: Tone, label: string, detail: string }>(() => {
  if (!remoteEnabled.value)
    return { tone: 'off', label: 'Off', detail: 'Turn on to pair a phone' }
  if (!status.connected.value)
    return { tone: 'warn', label: 'Relay not reachable', detail: `Start it with pnpm dev:proxy (port ${RC_PORT})` }
  if (!phones.value)
    return { tone: 'info', label: 'Listening', detail: 'Open the link below on your phone' }
  return { tone: 'ok', label: `${phones.value} phone${phones.value === 1 ? '' : 's'} connected`, detail: 'Playback answers to the remote' }
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

async function copy() {
  try {
    await navigator.clipboard.writeText(url.value)
    toast.success('Link copied', { detail: 'Send it to your phone, or type it in', icon: 'i-carbon-copy-link', key: 'remote-link' })
  }
  catch {
    toast.error('Could not copy the link', { key: 'remote-link' })
  }
}

/**
 * A new room locks out every phone holding the old link. The host only reads
 * the room when it connects, so bounce the connection to move it across.
 */
async function regenerate() {
  remoteRoom.value = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 8)).join('')
  if (remoteEnabled.value) {
    remoteEnabled.value = false
    await nextTick()
    remoteEnabled.value = true
  }
  toast('New link made', { detail: 'Phones on the old link are disconnected', icon: 'i-carbon-renew', key: 'remote-link' })
}

function openHere() {
  window.open(url.value, '_blank', 'noopener')
}

const CAN_DO = [
  { icon: 'i-carbon-play-filled-alt', label: 'Play, pause, skip' },
  { icon: 'i-carbon-shuffle', label: 'Random video' },
  { icon: 'i-carbon-wave-height', label: 'Motion on / off' },
  { icon: 'i-carbon-headphones', label: 'Session audio' },
  { icon: 'i-carbon-meter', label: 'Intensity' },
  { icon: 'i-carbon-warning-alt', label: 'Panic' },
]
</script>

<template>
  <UiPanel>
    <!-- ─── Hero ──────────────────────────────────────────────────────────── -->
    <section class="p-3 card flex gap-3 items-center">
      <div class="rounded-[var(--radius-md)] center shrink-0 h-11 w-11 transition-colors duration-300 relative" :class="TILE[state.tone]">
        <span class="i-carbon-mobile text-[21px]" />
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
      <UiSwitch v-model="remoteEnabled" aria-label="Phone remote" />
    </section>

    <Transition name="t-fade" mode="out-in">
      <UiEmpty
        v-if="!remoteEnabled"
        key="off"
        icon="i-carbon-mobile"
        size="sm"
        title="Control playback from your phone"
        description="Any phone on the same network can play, pause, skip, change intensity and hit panic, without touching the desktop."
      >
        <UiButton variant="primary" icon="i-carbon-power" @click="remoteEnabled = true">
          Turn on
        </UiButton>
      </UiEmpty>

      <div v-else key="on" class="flex flex-col gap-2.5">
        <!-- Relay missing: the one thing that stops everything else working -->
        <Transition name="t-collapse">
          <div v-if="!status.connected.value">
            <div class="min-h-0 overflow-hidden">
              <div class="text-[12px] text-warn p-2.5 rounded-[var(--radius-md)] bg-warn/10 flex gap-2 ring-1 ring-warn/20">
                <span class="i-carbon-warning-alt text-[15px] mt-px shrink-0" />
                <div class="flex flex-col gap-1 min-w-0">
                  <span>The relay that links desktop and phone is not running. Start it in a terminal next to the dev server:</span>
                  <code class="text-[11.5px] text-fg font-mono px-2 py-1 rounded-[var(--radius-sm)] bg-surface-950/60 self-start">pnpm dev:proxy</code>
                  <span class="text-fg-faint">It listens on port {{ RC_PORT }}; this panel reconnects by itself.</span>
                </div>
              </div>
            </div>
          </div>
        </Transition>

        <!-- ─── Pairing ─────────────────────────────────────────────────── -->
        <UiSection title="Pair a phone" icon="i-carbon-link">
          <div v-if="isLocalhost" class="text-[12px] text-warn flex gap-2">
            <span class="i-carbon-warning-alt text-[14px] mt-px shrink-0" />
            <span>
              This page is open on localhost, which a phone cannot reach. Open playhound on the desktop through the
              machine's network address, then pair from there.
            </span>
          </div>

          <div class="label">
            On your phone, open
          </div>
          <button
            v-tip="'Copy link'"
            type="button"
            class="group text-[12px] text-fg font-mono px-3 py-2.5 text-left focusable border border-edge-strong rounded-[var(--radius-md)] bg-surface-950/60 flex gap-2 w-full transition-colors items-start hover:border-accent/50"
            @click="copy"
          >
            <span class="leading-relaxed flex-1 min-w-0 break-all">{{ url }}</span>
            <span class="i-carbon-copy text-[14px] text-fg-faint mt-0.5 shrink-0 transition-colors group-hover:text-accent-300" />
          </button>

          <div class="flex gap-1.5">
            <UiButton icon="i-carbon-copy" @click="copy">
              Copy
            </UiButton>
            <UiButton icon="i-carbon-launch" variant="ghost" @click="openHere">
              Open here
            </UiButton>
            <UiButton icon="i-carbon-renew" variant="ghost" class="ml-auto" @click="regenerate">
              New link
            </UiButton>
          </div>
          <p class="hint">
            Anyone with this link and access to your network can control playback. Make a new one to lock old phones out.
          </p>
        </UiSection>

        <!-- ─── Connected phones ────────────────────────────────────────── -->
        <UiSection title="Connected" icon="i-carbon-devices" :live="phones > 0" :summary="`${phones}`">
          <TransitionGroup v-if="phones" name="t-list" tag="div" class="flex flex-wrap gap-1.5 relative">
            <div
              v-for="n in phones"
              :key="n"
              class="text-[12px] text-fg px-2.5 rounded-[var(--radius-sm)] bg-ok/10 flex gap-1.5 h-7 ring-1 ring-ok/20 items-center"
            >
              <span class="i-carbon-mobile-check text-[14px] text-ok" />
              Phone {{ n }}
            </div>
          </TransitionGroup>
          <p v-else class="hint">
            {{ status.connected.value ? 'No phone yet. Open the link and it shows up here.' : 'Waiting for the relay.' }}
          </p>
        </UiSection>

        <!-- ─── What the remote does ────────────────────────────────────── -->
        <UiSection title="From the phone" icon="i-carbon-touch-1">
          <div class="gap-x-3 gap-y-2 grid grid-cols-2">
            <div v-for="c in CAN_DO" :key="c.label" class="text-[12px] text-fg-muted flex gap-2 items-center">
              <span :class="c.icon" class="text-[14px] text-fg-faint shrink-0" />
              {{ c.label }}
            </div>
          </div>
          <p class="hint">
            While the panic screen is up, playback commands are ignored until you resume.
          </p>
        </UiSection>
      </div>
    </Transition>
  </UiPanel>
</template>
