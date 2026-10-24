<script lang="ts">
// Device config is read from storage once per page load. The inspector can be
// unmounted and remounted by the drawer's KeepAlive; reloading then would
// throw away nothing, but there is no reason to do it either.
</script>

<script setup lang="ts">
import type { MenuItem } from '~/components/ui/menu'
import type { AxisConfig, DevicePreset } from '~/stores/deviceStore'
import { useLocalStorage } from '@vueuse/core'
import { OutputType } from 'buttplug'
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import SerialLogViewer from '~/components/device/SerialLogViewer.vue'
import { useButtplug } from '~/composables/useButtplug'
import { useSerialPort } from '~/composables/useSerialPort'
import { useSettings } from '~/composables/useSettings'
import { axisOutput, useTCode } from '~/composables/useTCode'
import { toast } from '~/composables/useToast'
import { webSerial } from '~/lib/browserApi'
import { serialLog } from '~/lib/serialLog'
import { useDeviceStore } from '~/stores/deviceStore'
import { useUiStore } from '~/stores/uiStore'

let hydrated = false

const device = useDeviceStore()
const ui = useUiStore()
const bp = useButtplug()
const { requestAndConnect, disconnect, connecting } = useSerialPort()
const { homeAllAxes, testAxis } = useTCode()
const { save, load, downloadGoon, importGoon } = useSettings()

const pct = (v: number) => `${Math.round(v * 100)}%`

// ─── Persistence ──────────────────────────────────────────────────────────────
onMounted(() => {
  if (!hydrated) {
    load()
    hydrated = true
  }
})

// Every edit used to call save() by hand, and the ones that forgot were lost
// on reload. Watching the serialised form catches all of them.
let saveTimer: ReturnType<typeof setTimeout> | null = null
watch(() => device.serialize(), () => {
  if (saveTimer)
    clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 250)
}, { deep: true })
onBeforeUnmount(() => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    save()
  }
})

// ─── Transport ────────────────────────────────────────────────────────────────
type Transport = 'serial' | 'buttplug'
const transport = useLocalStorage<Transport>('ph:device.transport', 'serial')
onMounted(() => {
  // Land on whichever link is actually up.
  if (bp.connected.value && !device.connected)
    transport.value = 'buttplug'
  else if (device.connected && !bp.connected.value)
    transport.value = 'serial'
})

const TRANSPORTS = [
  { value: 'serial' as const, label: 'Serial', icon: 'i-carbon-usb', title: 'TCode over USB (OSR2, SR6, SSR1…)' },
  { value: 'buttplug' as const, label: 'Buttplug', icon: 'i-carbon-bluetooth', title: 'Any toy Intiface Central supports' },
]

// ─── Serial ───────────────────────────────────────────────────────────────────
const showSerialOptions = ref(false)
const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400].map(v => ({ value: v, label: `${v}` }))
const TCODE_VERSIONS = [
  { value: 'v3' as const, label: 'v3 · 0000–9999' },
  { value: 'v2' as const, label: 'v2 · 000–999' },
]

/** Browser error strings are written for developers; say what to actually do. */
function explainSerialError(msg: string) {
  if (/failed to open/i.test(msg))
    return 'The port is busy. Close anything else using it (another tab, MultiFunPlayer, a serial monitor) and try again.'
  if (/disconnected|device lost|closed/i.test(msg))
    return 'The device went away. Check the USB cable, then reconnect.'
  if (/not supported/i.test(msg))
    return 'This browser has no Web Serial. Use Chrome or Edge.'
  return msg
}

let leaving = false
async function connectSerial() {
  await requestAndConnect(device.baudRate)
  if (device.connected) {
    toast.success('Device connected', { detail: `${device.baudRate} baud · TCode ${device.tcodeVersion}`, icon: 'i-carbon-plug-filled', key: 'serial' })
  }
  else if (device.connectionError) {
    toast.error('Could not connect', { detail: explainSerialError(device.connectionError), key: 'serial' })
  }
  // A cancelled port picker leaves neither, and deserves no toast.
}

async function disconnectSerial() {
  leaving = true
  await disconnect()
  leaving = false
  toast('Device disconnected', { icon: 'i-carbon-plug', key: 'serial' })
}

// The read loop drops `connected` when the cable is pulled; say so.
watch(() => device.connected, (now, was) => {
  if (was && !now && !leaving) {
    toast.warn('Device connection lost', {
      detail: explainSerialError(device.connectionError ?? 'disconnected'),
      key: 'serial',
      action: { label: 'Reconnect', run: () => void connectSerial() },
    })
  }
})

const serialSummary = computed(() => `${device.baudRate} baud · TCode ${device.tcodeVersion}`)

// ─── Buttplug ─────────────────────────────────────────────────────────────────
const bpUrl = ref(bp.serverUrl.value)
const bpConnecting = ref(false)
const bpEnabled = computed({
  get: () => bp.enabled.value,
  set: v => bp.setEnabled(v),
})

async function connectBp() {
  bpConnecting.value = true
  try {
    await bp.connect(bpUrl.value.trim() || 'ws://localhost:12345')
  }
  finally {
    bpConnecting.value = false
  }
  if (bp.connected.value) {
    toast.success('Connected to Intiface', { detail: bp.deviceCount.value ? `${bp.deviceCount.value} device(s) ready` : 'Scan to find your devices', icon: 'i-carbon-bluetooth', key: 'bp' })
    if (!bp.deviceCount.value)
      void bp.startScan()
  }
  else {
    toast.error('Could not reach Intiface', { detail: `Is Intiface Central running with its server started at ${bpUrl.value}?`, key: 'bp' })
  }
}

async function disconnectBp() {
  await bp.disconnect()
  toast('Disconnected from Intiface', { icon: 'i-carbon-bluetooth-off', key: 'bp' })
}

function deviceKinds(d: (typeof bp.devices.value)[number]) {
  const out: string[] = []
  try {
    if (d.hasOutput(OutputType.HwPositionWithDuration))
      out.push('Linear')
    if (d.hasOutput(OutputType.Vibrate))
      out.push('Vibe')
  }
  catch {}
  return out
}

// ─── Connection hero ──────────────────────────────────────────────────────────
type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'idle'
const status = computed<{ tone: Tone, label: string, detail: string }>(() => {
  if (transport.value === 'serial') {
    if (connecting.value)
      return { tone: 'info', label: 'Connecting…', detail: 'Pick the port in the browser dialog' }
    if (device.connected) {
      return device.deviceEnabled
        ? { tone: 'ok', label: 'Connected', detail: `${device.portPath || 'Serial port'} · ${serialSummary.value}` }
        : { tone: 'warn', label: 'Connected, output held', detail: 'Commands are not being sent' }
    }
    if (!webSerial.supported)
      return { tone: 'danger', label: 'Web Serial unavailable', detail: 'Use Chrome or Edge for a USB device' }
    return { tone: 'idle', label: 'Not connected', detail: 'Plug the device in by USB, then connect' }
  }
  if (bpConnecting.value)
    return { tone: 'info', label: 'Connecting…', detail: bpUrl.value }
  if (bp.connected.value) {
    const n = bp.deviceCount.value
    if (!bp.enabled.value)
      return { tone: 'warn', label: 'Connected, output held', detail: 'Turn on output to drive devices' }
    return { tone: n ? 'ok' : 'warn', label: n ? 'Connected' : 'No devices yet', detail: n ? `Intiface · ${n} device${n === 1 ? '' : 's'}` : 'Scan, then wake the toy' }
  }
  return { tone: 'idle', label: 'Not connected', detail: 'Start Intiface Central, then connect' }
})

const DOT: Record<Tone, string> = {
  ok: 'bg-ok text-ok',
  info: 'bg-info text-info',
  warn: 'bg-warn text-warn',
  danger: 'bg-danger text-danger',
  idle: 'bg-fg-faint text-fg-faint',
}
const TILE: Record<Tone, string> = {
  ok: 'bg-ok/12 text-ok',
  info: 'bg-info/12 text-info',
  warn: 'bg-warn/12 text-warn',
  danger: 'bg-danger/12 text-danger',
  idle: 'bg-surface-800 text-fg-muted',
}
const live = computed(() => status.value.tone === 'ok' || status.value.tone === 'info')

// ─── Axes ─────────────────────────────────────────────────────────────────────
const axesOpen = ref(true)
const expanded = ref<string | null>(null)
function toggleAxis(ch: string) {
  expanded.value = expanded.value === ch ? null : ch
}

/** Keep a sliver of travel; min == max would pin the axis in place. */
const MIN_SPAN = 0.05
function setMin(axis: AxisConfig, e: Event) {
  const el = e.target as HTMLInputElement
  const v = Math.min(Number(el.value), axis.max - MIN_SPAN)
  axis.min = Math.max(0, v)
  el.value = String(axis.min)
}
function setMax(axis: AxisConfig, e: Event) {
  const el = e.target as HTMLInputElement
  const v = Math.max(Number(el.value), axis.min + MIN_SPAN)
  axis.max = Math.min(1, v)
  el.value = String(axis.max)
}

/** Linear and rotary axes rest centred; vibration and suction rest off. */
const restDefault = (ch: string) => (ch.startsWith('L') || ch.startsWith('R') ? 0.5 : 0)

function test(ch: string) {
  void testAxis(ch)
  toast(`Testing ${device.axisConfigs[ch]?.label ?? ch}`, {
    detail: device.connected ? 'Bottom, top, then back to rest' : 'No device connected: the emulator shows it',
    icon: 'i-carbon-play',
    key: 'axis-test',
  })
}

async function home() {
  await homeAllAxes()
  toast('Sent every axis to rest', { icon: 'i-carbon-home', key: 'axis-home' })
}

// Live markers are written straight to the DOM on each frame: re-rendering the
// list through Vue sixty times a second would cost more than the device does.
const markers = new Map<string, HTMLElement>()
function markerRef(ch: string, el: unknown) {
  if (el instanceof HTMLElement)
    markers.set(ch, el)
  else
    markers.delete(ch)
}
const shown: Record<string, number> = {}
let raf: number | null = null
function frame() {
  for (const [ch, el] of markers) {
    const cfg = device.axisConfigs[ch]
    if (!cfg)
      continue
    const rest = cfg.min + (cfg.invert ? 1 - cfg.defaultPos : cfg.defaultPos) * (cfg.max - cfg.min)
    const target = axisOutput[ch] ?? rest
    // Positions are targets the device eases toward, so ease the marker too.
    const cur = shown[ch] ?? target
    const next = cur + (target - cur) * 0.3
    shown[ch] = next
    el.style.left = `${next * 100}%`
  }
  raf = requestAnimationFrame(frame)
}
function startFrames() {
  if (raf === null)
    raf = requestAnimationFrame(frame)
}
function stopFrames() {
  if (raf !== null)
    cancelAnimationFrame(raf)
  raf = null
}
onMounted(startFrames)
onActivated(startFrames)
onDeactivated(stopFrames)
onBeforeUnmount(stopFrames)

// ─── Presets ──────────────────────────────────────────────────────────────────
const presetsOpen = ref(false)
const activePresetId = computed(() => device.detectActivePreset())
const activePresetName = computed(() =>
  device.allPresets.find(p => p.id === activePresetId.value)?.name ?? 'Custom',
)

function presetMeta(p: DevicePreset) {
  const on = p.axes.filter(a => a.enabled)
  if (!on.length)
    return 'No axes'
  const [first, ...rest] = on
  const head = `${first.channel} ${pct(first.min)}–${pct(first.max)}${first.invert ? ' inv' : ''}`
  return rest.length ? `${head} · +${rest.length} more` : head
}

function applyPreset(p: DevicePreset) {
  device.applyPreset(p)
  toast(`Applied ${p.name}`, { icon: 'i-carbon-checkmark', key: 'preset' })
}

const newPresetName = ref('')
function savePreset() {
  const name = newPresetName.value.trim()
  if (!name)
    return
  device.saveAsPreset(name)
  newPresetName.value = ''
  toast.success(`Saved preset "${name}"`, { key: 'preset' })
}

const renamingId = ref<string | null>(null)
const renameValue = ref('')
const renameInput = ref<{ focus: () => void, select: () => void }[]>([])
async function startRename(p: DevicePreset) {
  renamingId.value = p.id
  renameValue.value = p.name
  await nextTick()
  renameInput.value[0]?.focus()
  renameInput.value[0]?.select()
}
function commitRename() {
  const id = renamingId.value
  const v = renameValue.value.trim()
  if (id && v)
    device.renamePreset(id, v)
  renamingId.value = null
}

function deletePreset(p: DevicePreset) {
  const idx = device.userPresets.findIndex(x => x.id === p.id)
  device.deletePreset(p.id)
  toast(`Deleted "${p.name}"`, {
    icon: 'i-carbon-trash-can',
    key: 'preset',
    action: { label: 'Undo', run: () => device.userPresets.splice(Math.max(0, idx), 0, p) },
  })
}

function presetMenu(p: DevicePreset): MenuItem[] {
  return [
    { label: 'Apply', icon: 'i-carbon-checkmark', run: () => applyPreset(p) },
    { label: 'Rename', icon: 'i-carbon-edit', run: () => void startRename(p) },
    { separator: true },
    { label: 'Delete', icon: 'i-carbon-trash-can', danger: true, run: () => deletePreset(p) },
  ]
}

// ─── More menu ────────────────────────────────────────────────────────────────
async function importFile() {
  try {
    await importGoon()
    toast.success('Settings imported', { icon: 'i-carbon-document-import' })
  }
  catch (e: any) {
    toast.error('Import failed', { detail: e?.message ?? 'That file could not be read' })
  }
}

function resetAxes() {
  const before = JSON.parse(JSON.stringify(device.axisConfigs)) as Record<string, AxisConfig>
  device.resetAllAxisConfigs()
  toast('Axes reset to defaults', {
    icon: 'i-carbon-reset',
    action: { label: 'Undo', run: () => (device.axisConfigs = before) },
  })
}

const moreMenu = computed<MenuItem[]>(() => [
  { heading: true, label: 'Settings file' },
  { label: 'Export .goon', icon: 'i-carbon-document-export', run: downloadGoon },
  { label: 'Import .goon', icon: 'i-carbon-document-import', run: () => void importFile() },
  { separator: true },
  { label: 'Reset all axes', icon: 'i-carbon-reset', danger: true, run: resetAxes },
])

const logOpen = ref(false)
</script>

<template>
  <UiPanel>
    <!-- ─── Connection ─────────────────────────────────────────────────────── -->
    <section class="p-3 card flex flex-col gap-3 relative overflow-hidden">
      <div
        class="conn-glow pointer-events-none transition-opacity duration-500 inset-0 absolute"
        :class="status.tone === 'ok' ? 'opacity-100' : 'opacity-0'"
      />

      <div class="flex gap-3 items-center relative">
        <div class="rounded-[var(--radius-md)] center shrink-0 h-10 w-10 transition-colors duration-300 relative" :class="TILE[status.tone]">
          <span :class="transport === 'serial' ? 'i-carbon-usb' : 'i-carbon-bluetooth'" class="text-[19px]" />
          <span
            class="rounded-full h-2.5 w-2.5 ring-2 ring-surface-850 transition-colors duration-300 absolute -right-0.5 -top-0.5"
            :class="[DOT[status.tone], live ? 'animate-pulse-dot' : '']"
          />
        </div>
        <div class="flex-1 min-w-0">
          <Transition name="t-fade" mode="out-in">
            <p :key="status.label" class="text-[14px] text-fg tracking-[-0.01em] font-semibold truncate">
              {{ status.label }}
            </p>
          </Transition>
          <p class="hint truncate">
            {{ status.detail }}
          </p>
        </div>
      </div>

      <UiSegmented v-model="transport" :options="TRANSPORTS" block class="relative" />

      <Transition name="t-fade" mode="out-in">
        <!-- Serial -->
        <div v-if="transport === 'serial'" key="serial" class="flex flex-col gap-2.5 relative">
          <div v-if="!webSerial.supported" class="text-[12px] text-danger px-2.5 py-2 rounded-[var(--radius-md)] bg-danger/10 flex gap-2 ring-1 ring-danger/20">
            <span class="i-carbon-warning-alt text-[15px] mt-px shrink-0" />
            <span>This browser cannot talk to USB serial devices. Open playhound in Chrome or Edge, or use Buttplug.</span>
          </div>

          <UiButton
            v-if="!device.connected"
            variant="primary"
            size="lg"
            block
            icon="i-carbon-plug"
            :loading="connecting"
            :disabled="!webSerial.supported"
            @click="connectSerial"
          >
            {{ connecting ? 'Waiting for a port…' : 'Choose port & connect' }}
          </UiButton>
          <UiButton v-else variant="secondary" size="md" block icon="i-carbon-close" @click="disconnectSerial">
            Disconnect
          </UiButton>

          <UiSwitch
            v-if="device.connected"
            v-model="device.deviceEnabled"
            size="sm"
            label="Send to device"
            hint="Off keeps the port open but sends nothing"
          />

          <div
            v-if="device.connectionError && !device.connected"
            class="text-[12px] text-danger px-2.5 py-2 rounded-[var(--radius-md)] bg-danger/10 flex gap-2 ring-1 ring-danger/20 animate-fade-in"
          >
            <span class="i-carbon-error-filled text-[14px] mt-px shrink-0" />
            <span class="min-w-0">{{ explainSerialError(device.connectionError) }}</span>
          </div>

          <div class="flex flex-col">
            <button
              type="button"
              class="text-[11.5px] text-fg-faint px-1 focusable rounded-[var(--radius-sm)] flex gap-1.5 h-6 transition-colors items-center hover:text-fg-muted"
              :aria-expanded="showSerialOptions"
              @click="showSerialOptions = !showSerialOptions"
            >
              <span class="i-carbon-chevron-right text-[11px] transition-transform duration-200" :class="showSerialOptions ? 'rotate-90' : ''" />
              <span>Port options</span>
              <span class="num ml-auto">{{ serialSummary }}</span>
            </button>
            <Transition name="t-collapse">
              <div v-if="showSerialOptions">
                <div class="min-h-0 overflow-hidden">
                  <div class="pt-1.5 gap-2 grid grid-cols-2">
                    <UiSelect v-model="device.baudRate" label="Baud rate" :options="BAUD_RATES" :disabled="device.connected" />
                    <UiSelect v-model="device.tcodeVersion" label="TCode" :options="TCODE_VERSIONS" />
                  </div>
                  <p v-if="device.connected" class="hint mt-1.5">
                    Disconnect to change the baud rate.
                  </p>
                </div>
              </div>
            </Transition>
          </div>

          <div
            v-if="device.connected && device.lastCommand"
            class="text-[11px] text-fg-faint font-mono px-2 rounded-[var(--radius-sm)] bg-surface-950/60 flex gap-1.5 h-6 items-center"
          >
            <span class="i-carbon-arrow-up-right text-[11px] text-accent-300 shrink-0" />
            <span class="truncate">{{ device.lastCommand }}</span>
          </div>
        </div>

        <!-- Buttplug -->
        <div v-else key="buttplug" class="flex flex-col gap-2.5 relative">
          <UiInput
            v-model="bpUrl"
            icon="i-carbon-network-3"
            label="Intiface server"
            placeholder="ws://localhost:12345"
            mono
            size="md"
            :disabled="bp.connected.value || bpConnecting"
            @enter="connectBp"
          />

          <UiButton
            v-if="!bp.connected.value"
            variant="primary"
            size="lg"
            block
            icon="i-carbon-connect"
            :loading="bpConnecting"
            @click="connectBp"
          >
            Connect to Intiface
          </UiButton>
          <UiButton v-else variant="secondary" size="md" block icon="i-carbon-close" @click="disconnectBp">
            Disconnect
          </UiButton>

          <div
            v-if="bp.error.value && !bp.connected.value"
            class="text-[12px] text-danger px-2.5 py-2 rounded-[var(--radius-md)] bg-danger/10 flex gap-2 ring-1 ring-danger/20 animate-fade-in"
          >
            <span class="i-carbon-error-filled text-[14px] mt-px shrink-0" />
            <span class="min-w-0 break-words">{{ bp.error.value }}</span>
          </div>

          <p v-if="!bp.connected.value" class="hint">
            Open Intiface Central and press Start Server first. Linear strokers follow the stroke axis with its range;
            vibrators take the position as intensity.
          </p>

          <template v-else>
            <UiSwitch v-model="bpEnabled" size="sm" label="Send to devices" hint="Off keeps the link but sends nothing" />

            <div class="p-1.5 well flex flex-col gap-1">
              <div class="pl-1.5 flex gap-1 h-7 items-center">
                <span class="eyebrow">Devices</span>
                <span class="text-[11px] text-fg-faint num">{{ bp.deviceCount.value }}</span>
                <div class="ml-auto flex gap-1 items-center">
                  <UiButton
                    size="xs"
                    variant="ghost"
                    :icon="bp.scanning.value ? undefined : 'i-carbon-search'"
                    :loading="bp.scanning.value"
                    @click="bp.scanning.value ? bp.stopScan() : bp.startScan()"
                  >
                    {{ bp.scanning.value ? 'Scanning' : 'Scan' }}
                  </UiButton>
                  <UiButton v-if="bp.deviceCount.value" size="xs" variant="ghost" icon="i-carbon-stop-filled-alt" @click="bp.stopAll()">
                    Stop all
                  </UiButton>
                </div>
              </div>
              <TransitionGroup name="t-list" tag="div" class="flex flex-col gap-1 relative">
                <div
                  v-for="d in bp.devices.value"
                  :key="d.index"
                  class="px-2 rounded-[var(--radius-sm)] bg-surface-850 flex gap-2 h-8 items-center"
                >
                  <span class="text-ok rounded-full bg-ok shrink-0 h-1.5 w-1.5" />
                  <span class="text-[12.5px] text-fg flex-1 truncate">{{ d.name }}</span>
                  <UiBadge v-for="k in deviceKinds(d)" :key="k" size="xs" :tone="k === 'Linear' ? 'info' : 'accent'">
                    {{ k }}
                  </UiBadge>
                </div>
              </TransitionGroup>
              <div v-if="!bp.deviceCount.value" class="text-[12px] text-fg-faint px-2 py-3 text-center">
                <template v-if="bp.scanning.value">
                  <div class="flex flex-col gap-1.5">
                    <div class="skeleton rounded-[var(--radius-sm)] h-8" />
                    <span>Looking for devices — wake the toy now</span>
                  </div>
                </template>
                <template v-else>
                  Nothing found yet. Turn the device on and scan.
                </template>
              </div>
            </div>
          </template>
        </div>
      </Transition>
    </section>

    <!-- ─── Axes ──────────────────────────────────────────────────────────── -->
    <UiSection
      v-model:open="axesOpen"
      title="Axes"
      icon="i-carbon-chart-line-data"
      collapsible
      :summary="`${device.enabledAxes.length} of ${device.orderedAxes.length} on`"
    >
      <template #actions>
        <UiIconButton icon="i-carbon-home" label="Send every axis to rest" size="xs" @click="home" />
      </template>

      <div class="flex flex-col gap-0.5 -mx-1.5">
        <div
          v-for="axis in device.orderedAxes"
          :key="axis.channel"
          class="rounded-[var(--radius-md)] transition-colors duration-200"
          :class="expanded === axis.channel ? 'bg-surface-800/70 ring-1 ring-edge' : ''"
        >
          <div class="pl-1.5 pr-2 flex gap-2 h-9 items-center">
            <button
              type="button"
              class="focusable rounded-[var(--radius-sm)] flex flex-1 gap-2 h-full min-w-0 items-center"
              :aria-expanded="expanded === axis.channel"
              :aria-label="`${axis.label} settings`"
              @click="toggleAxis(axis.channel)"
            >
              <span
                class="i-carbon-chevron-right text-[11px] text-fg-faint shrink-0 transition-transform duration-200"
                :class="expanded === axis.channel ? 'rotate-90' : ''"
              />
              <span
                class="text-[10.5px] font-medium font-mono rounded-[var(--radius-xs)] center shrink-0 h-5 w-7 transition-colors"
                :class="axis.enabled ? 'bg-accent-soft text-accent-300' : 'bg-fg/6 text-fg-faint'"
              >{{ axis.channel }}</span>
              <span class="text-[12.5px] text-left shrink-0 w-[3.6rem] truncate" :class="axis.enabled ? 'text-fg' : 'text-fg-muted'">
                {{ axis.label }}
              </span>
              <!-- Track: the shaded band is the allowed range, the tick is where the axis was last sent -->
              <span class="rounded-full bg-surface-700 flex-1 h-1.5 min-w-8 relative" :class="axis.enabled ? '' : 'opacity-40'">
                <span
                  class="rounded-full h-full transition-[left,width] duration-200 absolute"
                  :class="axis.invert ? 'bg-warn/30' : 'bg-accent/30'"
                  :style="{ left: pct(axis.min), width: pct(axis.max - axis.min) }"
                />
                <span
                  :ref="el => markerRef(axis.channel, el)"
                  class="rounded-full h-3 w-1 shadow-[var(--shadow-sm)] top-1/2 absolute -translate-x-1/2 -translate-y-1/2"
                  :class="axis.invert ? 'bg-warn' : 'bg-accent'"
                />
              </span>
            </button>
            <UiSwitch v-model="axis.enabled" size="sm" :aria-label="`Enable ${axis.label}`" />
          </div>

          <Transition name="t-collapse">
            <div v-if="expanded === axis.channel">
              <div class="min-h-0 overflow-hidden">
                <div class="px-3 pb-3 pt-1 flex flex-col gap-3">
                  <!-- Range: two thumbs on one track -->
                  <div class="flex flex-col gap-1">
                    <div class="flex items-baseline justify-between">
                      <span class="label">Range</span>
                      <span class="text-[11.5px] text-fg num">{{ pct(axis.min) }} – {{ pct(axis.max) }}</span>
                    </div>
                    <div class="h-4 relative">
                      <div class="inset-x-[7px] inset-y-0 absolute">
                        <div class="rounded-full bg-surface-700 h-1 inset-x-0 top-1/2 absolute -translate-y-1/2" />
                        <div
                          class="rounded-full h-1 top-1/2 absolute -translate-y-1/2"
                          :class="axis.invert ? 'bg-warn' : 'bg-accent'"
                          :style="{ left: pct(axis.min), width: pct(axis.max - axis.min) }"
                        />
                      </div>
                      <input
                        type="range"
                        class="dual"
                        min="0"
                        max="1"
                        step="0.01"
                        :value="axis.min"
                        :aria-label="`${axis.label} minimum`"
                        :style="{ zIndex: axis.min > 0.9 ? 3 : 2 }"
                        @input="setMin(axis, $event)"
                      >
                      <input
                        type="range"
                        class="dual"
                        min="0"
                        max="1"
                        step="0.01"
                        :value="axis.max"
                        :aria-label="`${axis.label} maximum`"
                        @input="setMax(axis, $event)"
                      >
                    </div>
                    <div class="text-[10.5px] text-fg-faint flex justify-between">
                      <span>{{ axis.channel.startsWith('L') ? 'Bottom' : 'Low' }}</span>
                      <span>{{ axis.channel.startsWith('L') ? 'Top' : 'High' }}</span>
                    </div>
                  </div>

                  <UiSlider
                    v-model="axis.defaultPos"
                    label="Rest position"
                    :format="pct"
                    :reset="restDefault(axis.channel)"
                    hint="Where Home and Stop leave it. Double-click to reset."
                  />

                  <UiSwitch
                    v-model="axis.invert"
                    size="sm"
                    tone="warn"
                    label="Invert"
                    hint="Flip direction, for a device mounted the other way up"
                  />

                  <div class="flex gap-1.5 items-center">
                    <UiButton size="xs" icon="i-carbon-play" :disabled="!axis.enabled" @click="test(axis.channel)">
                      Test sweep
                    </UiButton>
                    <UiButton size="xs" variant="ghost" icon="i-carbon-reset" class="ml-auto" @click="device.resetAxisConfig(axis.channel)">
                      Defaults
                    </UiButton>
                  </div>
                </div>
              </div>
            </div>
          </Transition>
        </div>
      </div>
    </UiSection>

    <!-- ─── Presets ───────────────────────────────────────────────────────── -->
    <UiSection v-model:open="presetsOpen" title="Presets" icon="i-carbon-settings-adjust" collapsible :summary="activePresetName">
      <TransitionGroup name="t-list" tag="div" class="flex flex-col gap-0.5 relative -mx-1.5">
        <div
          v-for="p in device.allPresets"
          :key="p.id"
          class="group pr-1 rounded-[var(--radius-md)] flex gap-1 w-full transition-colors items-center"
          :class="activePresetId === p.id ? 'bg-accent-soft' : 'hover:bg-fg/5'"
        >
          <div v-if="renamingId === p.id" class="py-1 pl-1.5 flex-1 min-w-0">
            <UiInput
              ref="renameInput"
              v-model="renameValue"
              size="sm"
              @enter="commitRename"
              @escape="renamingId = null"
              @focusout="commitRename"
            />
          </div>
          <button
            v-else
            type="button"
            class="px-1.5 py-1.5 text-left focusable rounded-[var(--radius-md)] flex flex-1 gap-2.5 min-w-0 items-center"
            @click="applyPreset(p)"
          >
            <span
              class="rounded-full center shrink-0 h-4 w-4 transition-colors"
              :class="activePresetId === p.id ? 'bg-accent text-accent-contrast' : 'ring-1 ring-edge-strong'"
            >
              <span v-if="activePresetId === p.id" class="i-carbon-checkmark text-[11px]" />
            </span>
            <span class="flex flex-col min-w-0">
              <span class="text-[12.5px] flex gap-1.5 items-center" :class="activePresetId === p.id ? 'text-accent-300 font-medium' : 'text-fg'">
                <span class="truncate">{{ p.name }}</span>
                <UiBadge v-if="p.builtin" size="xs">Built-in</UiBadge>
              </span>
              <span class="text-[11px] text-fg-faint num truncate">{{ presetMeta(p) }}</span>
            </span>
          </button>
          <UiPopover v-if="!p.builtin && renamingId !== p.id" placement="bottom" align="end" flush>
            <template #trigger="{ toggle, open }">
              <UiIconButton
                icon="i-carbon-overflow-menu-horizontal"
                label="Preset actions"
                size="xs"
                :active="open"
                class="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                :class="open ? '!opacity-100' : ''"
                @click="toggle"
              />
            </template>
            <template #default="{ close }">
              <div class="p-1">
                <UiMenu :items="presetMenu(p)" @done="close" />
              </div>
            </template>
          </UiPopover>
        </div>
      </TransitionGroup>

      <div class="flex gap-1.5">
        <UiInput
          v-model="newPresetName"
          class="flex-1"
          placeholder="Save current axes as…"
          icon="i-carbon-add"
          @enter="savePreset"
        />
        <UiButton icon="i-carbon-save" :disabled="!newPresetName.trim()" @click="savePreset">
          Save
        </UiButton>
      </div>
    </UiSection>

    <!-- ─── Serial log ────────────────────────────────────────────────────── -->
    <UiSection
      v-model:open="logOpen"
      title="Serial log"
      icon="i-carbon-terminal"
      collapsible
      :summary="serialLog.length ? `${serialLog.length}` : 'empty'"
    >
      <SerialLogViewer />
    </UiSection>

    <template #footer>
      <UiButton icon="i-carbon-home" @click="home">
        Home
      </UiButton>
      <UiButton icon="i-carbon-play" :disabled="!device.axisConfigs.L0?.enabled" @click="test('L0')">
        Test stroke
      </UiButton>
      <div class="ml-auto flex gap-0.5 items-center">
        <UiIconButton
          icon="i-carbon-cube"
          :label="ui.isFloatingOpen('emulator') ? 'Hide emulator' : 'Show emulator'"
          :active="ui.isFloatingOpen('emulator')"
          @click="ui.toggleFloating('emulator')"
        />
        <UiPopover placement="top" align="end" flush>
          <template #trigger="{ toggle, open }">
            <UiIconButton icon="i-carbon-overflow-menu-vertical" label="More" :active="open" @click="toggle" />
          </template>
          <template #default="{ close }">
            <div class="p-1">
              <UiMenu :items="moreMenu" @done="close" />
            </div>
          </template>
        </UiPopover>
      </div>
    </template>
  </UiPanel>
</template>

<style scoped>
.conn-glow {
  background: radial-gradient(120% 80% at 0% 0%, color-mix(in srgb, var(--ok) 10%, transparent), transparent 60%);
}

/* Two native ranges stacked on one track. The inputs ignore the pointer so
   either thumb can be grabbed; only the thumbs themselves take it back. */
.dual {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 16px;
  margin: 0;
  pointer-events: none;
  background: transparent;
}
.dual::-webkit-slider-runnable-track {
  background: transparent;
}
.dual::-moz-range-track {
  background: transparent;
}
.dual::-webkit-slider-thumb {
  pointer-events: auto;
}
.dual::-moz-range-thumb {
  pointer-events: auto;
}
</style>
