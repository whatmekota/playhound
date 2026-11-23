<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import EstimSection from '~/components/device/EstimSection.vue'
import LatencyControl from '~/components/device/LatencyControl.vue'
import TcodeNetLink from '~/components/device/TcodeNetLink.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import { toyName, useButtplug } from '~/composables/useButtplug'
import { useCompactLayout } from '~/composables/useCompactLayout'
import { explainSerialError, TONE_DOT, TONE_TILE, useDeviceConnect } from '~/composables/useDeviceConnect'
import { sinkSupported, useEstim } from '~/composables/useEstim'
import { useHandy } from '~/composables/useHandy'
import { useTCodeNet } from '~/composables/useTCodeNet'
import { toast } from '~/composables/useToast'
import { webSerial } from '~/lib/browserApi'
import { HANDY_OTA_URL } from '~/lib/handy'
import { isAndroidApp, MISSING } from '~/lib/platform'
import { useDeviceStore } from '~/stores/deviceStore'
import { setupRun } from './run'

/**
 * The setup's device step: pick what you have, connect it, try a stroke and
 * set the latency. The connecting is the Device panel's own
 * (useDeviceConnect, TcodeNetLink, EstimSection, LatencyControl), and what is
 * picked here is where that panel opens. Only what works here is offered: a
 * USB device where there is Web Serial (in the Android app, its own USB),
 * Bluetooth for the Handy where there is Bluetooth, e-stim where sound can go
 * to an output of its own.
 */
const emit = defineEmits<{ next: [] }>()

const conn = useDeviceConnect()
const { status } = conn
const device = useDeviceStore()
const handy = useHandy()
const bp = useButtplug()
const net = useTCodeNet()
const estim = useEstim()
const compact = useCompactLayout()

type Kind = 'usb' | 'network' | 'handy' | 'intiface' | 'estim'
interface KindCard { id: Kind, icon: string, title: string, sub: string }

const KINDS = computed(() => ([
  webSerial.supported && { id: 'usb', icon: 'i-carbon-usb', title: 'Stroker on USB', sub: 'OSR2, SR6, SSR1 or another TCode device on a cable' },
  { id: 'network', icon: 'i-carbon-network-3', title: 'Stroker on WiFi', sub: net.udpAvailable ? 'An ESP32 build of an OSR or SR6, or restim' : 'An ESP32 build of an OSR or SR6, or restim over WebSocket' },
  { id: 'handy', icon: 'i-carbon-wifi', title: 'The Handy', sub: handy.bluetoothSupported ? 'Over WiFi with its connection key, or Bluetooth' : 'Over WiFi, with the connection key from the Handy app' },
  { id: 'intiface', icon: 'i-brand-intiface', title: 'Toys through Intiface', sub: isAndroidApp ? 'Lovense, Kiiroo, We-Vibe and more, through Intiface Central on your PC' : 'Lovense, Kiiroo, We-Vibe and more, with Intiface Central' },
  sinkSupported && { id: 'estim', icon: 'i-carbon-flash', title: 'E-stim box', sub: 'A stim box made for audio input. Experimental' },
] as (KindCard | false)[]).filter((k): k is KindCard => !!k))

/** Already connected (the setup run again): start there. */
function connectedKind(): Kind | null {
  if (device.serialUp)
    return 'usb'
  if (net.status.value === 'connected')
    return 'network'
  if (handy.connected.value)
    return 'handy'
  if (bp.connected.value)
    return 'intiface'
  if (estim.armed.value)
    return 'estim'
  return null
}
const kind = ref<Kind | null>(connectedKind())
const card = computed(() => KINDS.value.find(k => k.id === kind.value) ?? null)

/** The Device panel opens on whatever is picked here. */
function choose(k: Kind) {
  kind.value = k
  if (k === 'usb' || k === 'network') {
    conn.transport.value = 'serial'
    conn.setTcodeLink(k === 'usb' ? 'usb' : 'network')
  }
  else if (k === 'handy') {
    conn.transport.value = 'handy'
  }
  else if (k === 'intiface') {
    conn.transport.value = 'buttplug'
  }
}

const connected = computed(() => {
  switch (kind.value) {
    case 'usb': return device.serialUp
    case 'network': return net.status.value === 'connected'
    case 'handy': return handy.connected.value
    case 'intiface': return bp.connected.value && bp.deviceCount.value > 0
    case 'estim': return estim.armed.value
  }
  return false
})

watchEffect(() => {
  const c = card.value
  if (!c)
    setupRun.device = null
  else if (c.id === 'estim')
    setupRun.device = `${c.title}, ${connected.value ? 'started' : 'not started'}`
  else
    setupRun.device = `${c.title}, ${connected.value ? 'connected' : 'not connected'}`
})

// ─── The Handy ───────────────────────────────────────────────────────────────
const HANDY_LINKS = [
  { value: 'wifi' as const, label: 'WiFi', icon: 'i-carbon-wifi' },
  { value: 'ble' as const, label: 'Bluetooth', icon: 'i-carbon-bluetooth' },
]
const handyNeedsUpdate = computed(() => /firmware update/i.test(handy.error.value ?? ''))
const signedMs = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)} ms`

// ─── Trying it ───────────────────────────────────────────────────────────────
function test() {
  conn.testStroke('L0')
  toast('Testing the stroke', { detail: 'Bottom, top, then back to rest', icon: 'i-carbon-play', key: 'axis-test' })
}

// Next once something is connected; until then Skip is the way on.
defineExpose({ ready: connected })
</script>

<template>
  <!-- What you have -->
  <div v-if="!kind" class="flex flex-col gap-3">
    <div class="gap-2.5 grid" :class="compact ? 'grid-cols-1' : 'grid-cols-2'">
      <button
        v-for="k in KINDS"
        :key="k.id"
        type="button"
        class="group p-3 text-left focusable card flex gap-3 transition-[border-color,background-color] duration-200 items-center hover:border-edge-strong hover:bg-surface-800"
        @click="choose(k.id)"
      >
        <span class="text-accent-300 rounded-[var(--radius-md)] bg-accent-soft center shrink-0 h-9 w-9">
          <span :class="k.icon" class="text-[18px]" />
        </span>
        <span class="flex flex-1 flex-col gap-0.5 min-w-0">
          <span class="text-[13px] text-fg font-medium">{{ k.title }}</span>
          <span class="hint">{{ k.sub }}</span>
        </span>
        <span class="i-carbon-chevron-right text-[14px] text-fg-faint shrink-0 transition-transform group-hover:translate-x-0.5" />
      </button>
      <button
        type="button"
        class="group p-3 text-left focusable border border-edge-strong rounded-[var(--radius-lg)] border-dashed flex gap-3 transition-colors items-center hover:bg-fg/4"
        @click="emit('next')"
      >
        <span class="text-fg-muted rounded-[var(--radius-md)] bg-fg/6 center shrink-0 h-9 w-9">
          <span class="i-carbon-skip-forward text-[17px]" />
        </span>
        <span class="flex flex-1 flex-col gap-0.5 min-w-0">
          <span class="text-[13px] text-fg font-medium">No device yet</span>
          <span class="hint">On to the next step. The emulator shows the motion on screen.</span>
        </span>
      </button>
    </div>
    <p v-if="!webSerial.supported" class="hint m-0 flex gap-1.5 items-start">
      <span class="i-carbon-information text-[13px] mt-px shrink-0" />
      {{ MISSING.serial }}
    </p>
  </div>

  <!-- Connect it -->
  <div v-else class="flex flex-col gap-3">
    <div class="flex gap-2 items-center">
      <UiButton size="xs" variant="ghost" icon="i-carbon-arrow-left" @click="kind = null">
        All devices
      </UiButton>
      <span v-if="card" class="text-[12.5px] text-fg-muted flex gap-1.5 min-w-0 items-center">
        <span :class="card.icon" class="text-[14px] shrink-0" />
        <span class="truncate">{{ card.title }}</span>
      </span>
    </div>

    <!-- E-stim: the Device panel's section as it is, warnings first -->
    <EstimSection v-if="kind === 'estim'" expanded />

    <section v-else class="p-3 card flex flex-col gap-3">
      <div class="flex gap-3 items-center">
        <div class="rounded-[var(--radius-md)] center shrink-0 h-10 w-10 transition-colors duration-300 relative" :class="TONE_TILE[status.tone]">
          <span :class="card?.icon" class="text-[19px]" />
          <span
            class="rounded-full h-2.5 w-2.5 ring-2 ring-surface-850 transition-colors duration-300 absolute -right-0.5 -top-0.5"
            :class="[TONE_DOT[status.tone], status.tone === 'ok' || status.tone === 'info' ? 'animate-pulse-dot' : '']"
          />
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[14px] text-fg tracking-[-0.01em] font-semibold truncate">
            {{ status.label }}
          </p>
          <p class="hint truncate">
            {{ status.detail }}
          </p>
        </div>
        <UiButton v-if="conn.held.value" size="sm" variant="primary" icon="i-carbon-play-filled-alt" @click="conn.releaseOutput()">
          Turn on
        </UiButton>
      </div>

      <!-- USB -->
      <template v-if="kind === 'usb'">
        <UiButton
          v-if="!device.serialUp"
          variant="primary"
          size="lg"
          block
          icon="i-carbon-plug"
          :loading="conn.serialConnecting.value"
          @click="conn.connectSerial()"
        >
          {{ conn.serialConnecting.value ? 'Waiting for a port…' : 'Choose port & connect' }}
        </UiButton>
        <UiButton v-else variant="secondary" block icon="i-carbon-close" @click="conn.disconnectSerial()">
          Disconnect
        </UiButton>
        <div
          v-if="device.connectionError && !device.serialUp"
          class="text-[12px] text-danger px-2.5 py-2 rounded-[var(--radius-md)] bg-danger/10 flex gap-2 ring-1 ring-danger/20 animate-fade-in"
        >
          <span class="i-carbon-error-filled text-[14px] mt-px shrink-0" />
          <span class="min-w-0">{{ explainSerialError(device.connectionError) }}</span>
        </div>
        <p class="hint m-0">
          Plug it in first. {{ conn.serialSummary.value }}; the Device panel's port options change that.
        </p>
      </template>

      <!-- TCode over the network -->
      <TcodeNetLink v-else-if="kind === 'network'" />

      <!-- The Handy -->
      <template v-else-if="kind === 'handy'">
        <div v-if="handy.bluetoothSupported" :class="handy.connected.value || conn.handyBusy.value ? 'pointer-events-none opacity-60' : ''" :aria-disabled="handy.connected.value || conn.handyBusy.value">
          <UiSegmented v-model="handy.link.value" :options="HANDY_LINKS" size="sm" block />
        </div>
        <UiInput
          v-if="!conn.handyBle.value"
          v-model="handy.connectionKey.value"
          icon="i-carbon-password"
          label="Connection key"
          placeholder="From the Handy app"
          mono
          size="md"
          :disabled="handy.connected.value || conn.handyBusy.value"
          @enter="conn.connectHandy()"
        />
        <UiButton
          v-if="!handy.connected.value"
          variant="primary"
          size="lg"
          block
          :icon="conn.handyBle.value ? 'i-carbon-bluetooth' : 'i-carbon-connect'"
          :loading="conn.handyBusy.value"
          @click="conn.connectHandy()"
        >
          Connect to the Handy
        </UiButton>
        <UiButton v-else variant="secondary" block icon="i-carbon-close" @click="conn.disconnectHandy()">
          Disconnect
        </UiButton>
        <div
          v-if="handy.error.value"
          class="text-[12px] text-danger px-2.5 py-2 rounded-[var(--radius-md)] bg-danger/10 flex gap-2 ring-1 ring-danger/20 animate-fade-in"
        >
          <span class="i-carbon-error-filled text-[14px] mt-px shrink-0" />
          <span class="min-w-0 break-words">
            {{ handy.error.value }}
            <a v-if="handyNeedsUpdate" :href="HANDY_OTA_URL" target="_blank" rel="noopener" class="underline">Update it here.</a>
          </span>
        </div>
        <p v-if="!handy.connected.value" class="hint m-0">
          {{ conn.handyBle.value
            ? 'A Handy with firmware 4, straight from here: no internet and no key. Close the Handy app\'s Bluetooth link first; only one program can hold it.'
            : 'A Handy with firmware 4, on WiFi. The key is in the Handy app; this needs an internet connection.' }}
        </p>
      </template>

      <!-- Intiface -->
      <template v-else-if="kind === 'intiface'">
        <UiInput
          v-model="conn.bpUrl.value"
          icon="i-carbon-network-3"
          :label="isAndroidApp ? 'Intiface on your PC' : 'Intiface server'"
          :placeholder="isAndroidApp ? '192.168.1.20, your PC on the Wi-Fi' : 'ws://localhost:12345'"
          mono
          size="md"
          :disabled="bp.connected.value || conn.bpConnecting.value"
          @enter="conn.connectIntiface()"
        />
        <UiButton
          v-if="!bp.connected.value"
          variant="primary"
          size="lg"
          block
          icon="i-carbon-connect"
          :loading="conn.bpConnecting.value"
          @click="conn.connectIntiface()"
        >
          Connect to Intiface
        </UiButton>
        <UiButton v-else variant="secondary" block icon="i-carbon-close" @click="conn.disconnectIntiface()">
          Disconnect
        </UiButton>
        <div
          v-if="bp.error.value && !bp.connected.value"
          class="text-[12px] text-danger px-2.5 py-2 rounded-[var(--radius-md)] bg-danger/10 flex gap-2 ring-1 ring-danger/20 animate-fade-in"
        >
          <span class="i-carbon-error-filled text-[14px] mt-px shrink-0" />
          <span class="min-w-0 break-words">{{ bp.error.value }}</span>
        </div>
        <div v-if="bp.connected.value" class="p-1.5 well flex flex-col gap-1">
          <div class="pl-1.5 flex gap-1 h-7 items-center">
            <span class="eyebrow">Devices</span>
            <span class="text-[11px] text-fg-faint num">{{ bp.deviceCount.value }}</span>
            <UiButton
              size="xs"
              variant="ghost"
              class="ml-auto"
              :icon="bp.scanning.value ? undefined : 'i-carbon-search'"
              :loading="bp.scanning.value"
              @click="bp.scanning.value ? bp.stopScan() : bp.startScan()"
            >
              {{ bp.scanning.value ? 'Scanning' : 'Scan' }}
            </UiButton>
          </div>
          <div v-for="d in bp.devices.value" :key="d.index" class="px-2 rounded-[var(--radius-sm)] bg-surface-850 flex gap-2 h-8 items-center">
            <span class="text-ok rounded-full bg-ok shrink-0 h-1.5 w-1.5" />
            <span class="text-[12.5px] text-fg flex-1 min-w-0 truncate">{{ toyName(d) }}</span>
          </div>
          <p v-if="!bp.deviceCount.value" class="text-[12px] text-fg-faint m-0 px-2 py-2 text-center">
            {{ bp.scanning.value ? 'Looking for devices: wake the toy now' : 'Nothing found yet. Turn the toy on and scan.' }}
          </p>
        </div>
        <p v-else class="hint m-0">
          {{ isAndroidApp
            ? 'Intiface Central runs on your PC and the toys connect to it. In its settings turn on "Listen on all network interfaces", start the server, then enter the PC\'s address here. Both must be on the same Wi-Fi.'
            : 'Open Intiface Central and press Start Server first. Strokers follow the stroke; vibrators follow the script\'s speed.' }}
        </p>
      </template>
    </section>

    <!-- Try it, and line it up -->
    <section class="p-3 card flex flex-col gap-3">
      <div class="flex gap-3 items-center">
        <div class="flex flex-1 flex-col gap-0.5 min-w-0">
          <span class="text-[13px] text-fg font-medium">Try a stroke</span>
          <span class="hint">{{ connected ? 'Bottom, top, then back to rest, within the stroke range.' : kind === 'estim' ? 'Start it first, with the box turned down.' : 'Connect first.' }}</span>
        </div>
        <UiButton icon="i-carbon-play" :disabled="!connected" class="shrink-0" @click="test">
          Test stroke
        </UiButton>
      </div>
      <div class="divider-x" />
      <UiSlider
        v-if="kind === 'handy'"
        v-model="handy.offsetMs.value"
        label="Sync offset"
        :min="-500"
        :max="500"
        :step="10"
        :format="signedMs"
        :reset="0"
        hint="Positive moves the Handy earlier, for strokes that land behind the video. Leave it at 0 until one does."
      />
      <LatencyControl v-else :calibrate="kind === 'usb' || kind === 'network'" />
    </section>

    <p v-if="connected" class="text-[12.5px] text-fg-muted m-0 flex gap-1.5 items-start">
      <span class="i-carbon-checkmark-outline text-[14px] text-ok mt-px shrink-0" />
      Ready. Axes, ranges and presets are in the Device panel.
    </p>
  </div>
</template>
