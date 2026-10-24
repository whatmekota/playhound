<script setup lang="ts">
import { computed, ref } from 'vue'
import { RC_PORT, remoteRoom, remoteUrl } from '~/composables/useRemoteLink'
import { useRemoteStatus } from '~/composables/useRemoteStatus'
import { remoteEnabled } from '~/stores/remoteStore'

const status = useRemoteStatus()
const copied = ref(false)

const url = computed(() => remoteUrl(remoteRoom.value))
const isLocalhost = computed(() =>
  ['localhost', '127.0.0.1'].includes(location.hostname),
)

async function copy() {
  try {
    await navigator.clipboard.writeText(url.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  }
  catch {
    copied.value = false
  }
}

function regenerate() {
  remoteRoom.value = Array.from({ length: 4 }, () =>
    Math.random().toString(36).slice(2, 8)).join('')
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="p-3 space-y-4">
      <button
        class="text-xs font-medium px-3 py-2 rounded-lg flex gap-2 w-full transition-colors items-center justify-center"
        :class="remoteEnabled
          ? 'bg-teal-500/20 text-teal-300 hover:bg-teal-500/30'
          : 'bg-fg/5 text-fg-muted hover:bg-fg/10'"
        @click="remoteEnabled = !remoteEnabled"
      >
        <div :class="remoteEnabled ? 'i-carbon-pause-filled' : 'i-carbon-play-filled'" />
        {{ remoteEnabled ? 'Listening' : 'Off' }}
      </button>

      <p class="hint">
        Control playback from your phone on the same network. Needs the relay
        running — <span class="font-mono">pnpm dev:proxy</span>.
      </p>

      <!-- Status -->
      <section class="panel p-2.5 space-y-2">
        <div class="text-[11px] flex gap-2 items-center">
          <span
            class="rounded-full shrink-0 h-1.5 w-1.5"
            :class="status.connected.value ? 'bg-emerald-400' : 'bg-fg/25'"
          />
          <span :class="status.connected.value ? 'text-fg-muted' : 'text-fg-faint'">
            {{ status.connected.value ? 'Relay connected' : 'Relay not reachable' }}
          </span>
          <span
            v-if="status.connected.value"
            class="text-fg-faint font-mono ml-auto"
          >{{ status.peers.value.remotes }} phone{{ status.peers.value.remotes === 1 ? '' : 's' }}</span>
        </div>

        <p v-if="!status.connected.value && remoteEnabled" class="hint text-amber-400/80">
          Start the relay with <span class="font-mono">pnpm dev:proxy</span>. It
          listens on port {{ RC_PORT }}.
        </p>
      </section>

      <!-- Pairing -->
      <section v-if="remoteEnabled" class="space-y-2">
        <p class="label">
          On your phone, open
        </p>

        <p
          v-if="isLocalhost"
          class="hint text-amber-400/80"
        >
          This page is open on localhost, so the link below will not work from a
          phone. Open playhound on the desktop using the machine's network
          address instead, then come back here.
        </p>

        <button
          class="text-[11px] text-fg-muted font-mono px-2.5 py-2 text-left border border-edge rounded-lg bg-surface-900 w-full break-all transition-colors hover:bg-surface-800"
          :title="copied ? 'Copied' : 'Click to copy'"
          @click="copy"
        >
          {{ url }}
        </button>

        <div class="flex gap-2 items-center">
          <span class="hint flex-1">
            {{ copied ? 'Copied to clipboard.' : 'Anyone with this link and access to your network can control playback.' }}
          </span>
          <button class="btn-subtle text-[11px] px-2 py-1 shrink-0" title="Generate a new room" @click="regenerate">
            New link
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
