<script setup lang="ts">
import type { NetPresetId, NetProtocol } from '~/lib/tcodeNet'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useTCodeNet } from '~/composables/useTCodeNet'
import { toast } from '~/composables/useToast'
import { NET_PRESETS, presetById } from '~/lib/tcodeNet'
import { useDeviceStore } from '~/stores/deviceStore'

/** The Network side of the Device panel's TCode tab: preset, address, connect. */

const device = useDeviceStore()
const net = useTCodeNet()
const s = net.settings

const busy = computed(() => net.status.value === 'connecting' || net.status.value === 'reconnecting')
const linked = computed(() => net.status.value === 'connected' || net.status.value === 'reconnecting')
const locked = computed(() => linked.value || busy.value)

const PRESET_OPTIONS = computed(() => NET_PRESETS.map(p => ({
  value: p.id,
  label: p.label,
  disabled: p.target?.protocol === 'udp' && !net.udpAvailable,
})))
const preset = computed({
  get: () => s.value.preset,
  set: (id: NetPresetId) => net.applyPreset(id),
})
const presetHint = computed(() => presetById(s.value.preset)?.hint ?? '')

const PROTOCOLS = computed(() => [
  { value: 'ws' as const, label: 'WebSocket', title: 'ws://host:port/path; works in the browser too' },
  { value: 'udp' as const, label: 'UDP', title: net.udpAvailable ? 'host:port' : 'Needs the desktop app' },
])
const protocol = computed({
  get: () => s.value.protocol,
  set: (p: NetProtocol) => {
    s.value = { ...s.value, protocol: p }
  },
})

/** Typing an address makes it a custom one, unless it is the preset's own. */
const address = computed({
  get: () => s.value.address,
  set: (v: string) => {
    s.value = { ...s.value, address: v, preset: 'custom' }
  },
})

const checked = computed(() => net.check())
const placeholder = computed(() => (s.value.protocol === 'ws' ? 'ws://192.168.1.40/ws' : '192.168.1.40:8000'))

const TCODE_VERSIONS = [
  { value: 'v3' as const, label: 'v3 · 0000–9999' },
  { value: 'v2' as const, label: 'v2 · 000–999' },
]

async function connect() {
  if (!await net.connect())
    toast.error('Could not connect', { detail: net.error.value ?? undefined, key: 'tcode-net' })
}

// The link opens (or fails) a moment after connect() returns: say so when it does.
watch(() => net.status.value, (now, was) => {
  if (was === 'connecting' && now === 'connected')
    toast.success('Device connected', { detail: device.portPath, icon: 'i-carbon-network-3', key: 'tcode-net' })
  else if (was === 'connecting' && now === 'idle' && net.error.value)
    toast.error('Could not connect', { detail: net.error.value, key: 'tcode-net' })
  else if (was === 'connected' && now === 'reconnecting')
    toast.warn('Lost the network link', { detail: 'Trying again by itself.', key: 'tcode-net' })
  else if (was === 'reconnecting' && now === 'connected')
    toast.success('Back on the network', { detail: device.portPath, icon: 'i-carbon-network-3', key: 'tcode-net' })
})

function disconnect() {
  net.disconnect()
  toast('Device disconnected', { icon: 'i-carbon-plug', key: 'tcode-net' })
}

/** Seconds to the next try, ticking while reconnecting. */
const now = ref(performance.now())
let clock: ReturnType<typeof setInterval> | null = null
watch(() => net.status.value === 'reconnecting', (on) => {
  if (clock)
    clearInterval(clock)
  clock = on ? setInterval(() => (now.value = performance.now()), 500) : null
}, { immediate: true })
onBeforeUnmount(() => clock && clearInterval(clock))
const retryIn = computed(() => Math.max(0, Math.ceil((net.retryAt.value - now.value) / 1000)))
</script>

<template>
  <div class="flex flex-col gap-2.5">
    <div :class="locked ? 'pointer-events-none opacity-60' : ''" :aria-disabled="locked" class="flex flex-col gap-2.5">
      <UiSelect v-model="preset" label="Target" :options="PRESET_OPTIONS" size="md" :disabled="locked" />
      <div v-if="s.preset === 'custom'" class="flex flex-col gap-1">
        <span class="label">Over</span>
        <UiSegmented v-model="protocol" :options="PROTOCOLS" size="xs" block />
      </div>
      <UiInput
        v-model="address"
        icon="i-carbon-network-3"
        label="Address"
        :placeholder="placeholder"
        mono
        size="md"
        :disabled="locked"
        @enter="connect"
      />
    </div>
    <p v-if="!linked && !busy && checked.error && s.address.trim()" class="text-[11.5px] text-warn">
      {{ checked.error }}
    </p>

    <UiButton
      v-if="!linked"
      variant="primary"
      size="lg"
      block
      icon="i-carbon-connect"
      :loading="busy"
      :disabled="!!checked.error"
      @click="connect"
    >
      {{ busy ? 'Connecting…' : 'Connect' }}
    </UiButton>
    <UiButton v-else variant="secondary" size="md" block icon="i-carbon-close" @click="disconnect">
      {{ net.status.value === 'reconnecting' ? 'Stop trying' : 'Disconnect' }}
    </UiButton>

    <UiSwitch
      v-if="net.status.value === 'connected'"
      v-model="device.deviceEnabled"
      size="sm"
      label="Send to device"
      hint="Off keeps the link but sends nothing"
    />

    <div
      v-if="net.status.value === 'reconnecting'"
      class="text-[12px] text-warn px-2.5 py-2 rounded-[var(--radius-md)] bg-warn/10 flex gap-2 ring-1 ring-warn/20 animate-fade-in"
    >
      <span class="i-carbon-renew text-[14px] mt-px shrink-0" />
      <span class="min-w-0 break-words">
        {{ net.error.value }}. Trying again{{ retryIn ? ` in ${retryIn} s` : '…' }} (attempt {{ net.attempt.value }}).
      </span>
    </div>
    <div
      v-else-if="net.error.value && net.status.value === 'idle'"
      class="text-[12px] text-danger px-2.5 py-2 rounded-[var(--radius-md)] bg-danger/10 flex gap-2 ring-1 ring-danger/20 animate-fade-in"
    >
      <span class="i-carbon-error-filled text-[14px] mt-px shrink-0" />
      <span class="min-w-0 break-words">{{ net.error.value }}</span>
    </div>

    <p v-if="!linked" class="hint">
      {{ presetHint }}
      <template v-if="s.preset.startsWith('esp32')">
        Use the board's IP address if tcode.local is not found.
      </template>
      Axis ranges, inversion, rest positions, presets and latency work as over USB.
    </p>

    <div v-if="net.status.value === 'connected' && net.reply.value" class="text-[11.5px] text-fg-muted flex gap-1.5 items-center">
      <span class="i-carbon-checkmark-outline text-[12px] text-ok shrink-0" />
      <span class="truncate">The device says: {{ net.reply.value }}</span>
    </div>
    <p v-else-if="net.status.value === 'connected' && net.target.value?.protocol === 'udp'" class="hint">
      UDP sends without knowing whether anything is listening. If the device does not move, check the address.
    </p>

    <UiSelect v-model="device.tcodeVersion" label="TCode" :options="TCODE_VERSIONS" />

    <div
      v-if="net.status.value === 'connected' && device.lastCommand"
      class="text-[11px] text-fg-faint font-mono px-2 rounded-[var(--radius-sm)] bg-surface-950/60 flex gap-1.5 h-6 items-center"
    >
      <span class="i-carbon-arrow-up-right text-[11px] text-accent-300 shrink-0" />
      <span class="truncate">{{ device.lastCommand }}</span>
    </div>
  </div>
</template>
