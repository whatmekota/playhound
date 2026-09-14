<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useDeviceStore } from '~/stores/deviceStore'
import { useSerialPort } from '~/composables/useSerialPort'
import { useTCode } from '~/composables/useTCode'
import { useSettings } from '~/composables/useSettings'
import { useButtplug } from '~/composables/useButtplug'
import { webSerial } from '~/lib/browserApi'
import type { DevicePreset } from '~/stores/deviceStore'

const deviceStore = useDeviceStore()
const { requestAndConnect, disconnect } = useSerialPort()
const { homeAllAxes, testAxis } = useTCode()
const { save, load, downloadGoon, importGoon } = useSettings()
const bp = useButtplug()

const importError = ref<string | null>(null)
const importOk = ref(false)

// ─── Section accordion (only one open at a time; connection is always visible) ─
const openSection = ref<'presets' | 'axes' | 'settings' | 'buttplug' | null>('presets')
function toggleSection(s: 'presets' | 'axes' | 'settings' | 'buttplug') {
  openSection.value = openSection.value === s ? null : s
}

// ─── Buttplug ────────────────────────────────────────────────────────────────
const bpUrl = ref(bp.serverUrl.value)
async function handleBpConnect() {
  if (bp.connected.value) { await bp.disconnect() }
  else { await bp.connect(bpUrl.value) }
}
function bpDeviceTypeLabel(d: any): string {
  try {
    const { OutputType } = (window as any).__bp__ ?? {}
    const labels: string[] = []
    if (d.hasOutput?.('PositionWithDuration')) labels.push('Linear')
    if (d.hasOutput?.('Vibrate')) labels.push('Vibe')
    if (d.hasOutput?.('Rotate')) labels.push('Rotate')
    return labels.join('+') || 'Unknown'
  } catch { return '' }
}

// ─── Cog advanced settings ────────────────────────────────────────────────────
const showAdvanced = ref(false)

async function handleConnect() {
  if (deviceStore.connected) {
    await disconnect()
  } else {
    await requestAndConnect(deviceStore.baudRate)
    save()
  }
}

function pct(val: number) { return `${Math.round(val * 100)}%` }

// ─── Presets ──────────────────────────────────────────────────────────────────
const newPresetName = ref('')
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const expandedPresetId = ref<string | null>(null)

const activePresetId = computed(() => deviceStore.detectActivePreset())

function handleApplyPreset(preset: DevicePreset) { deviceStore.applyPreset(preset); save() }

function handleSavePreset() {
  const name = newPresetName.value.trim()
  if (!name) return
  deviceStore.saveAsPreset(name)
  newPresetName.value = ''
  save()
}

function handleDeletePreset(id: string) { deviceStore.deletePreset(id); save() }

function startRename(preset: DevicePreset) { renamingId.value = preset.id; renameValue.value = preset.name }

function commitRename(id: string) {
  const v = renameValue.value.trim()
  if (v) deviceStore.renamePreset(id, v)
  renamingId.value = null
  save()
}

function toggleExpand(id: string) {
  expandedPresetId.value = expandedPresetId.value === id ? null : id
}

async function handleImport() {
  importError.value = null; importOk.value = false
  try {
    await importGoon()
    importOk.value = true
    setTimeout(() => { importOk.value = false }, 2500)
  } catch (e: any) { importError.value = e?.message ?? 'Import failed' }
}

onMounted(() => { load() })
</script>

<template>
  <div class="flex flex-col gap-2 p-3 overflow-y-auto h-full">

    <!-- Master enable -->
    <div class="flex items-center justify-between px-1 py-1">
      <h2 class="text-sm font-semibold text-white/80">TCode Device</h2>
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <span class="text-xs text-white/50">Enable</span>
        <div class="relative w-9 h-5 rounded-full transition-colors"
          :class="deviceStore.deviceEnabled ? 'bg-accent-600' : 'bg-surface-700'"
          @click="deviceStore.deviceEnabled = !deviceStore.deviceEnabled">
          <div class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
            :class="deviceStore.deviceEnabled ? 'translate-x-4' : 'translate-x-0.5'" />
        </div>
      </label>
    </div>

    <!-- Web Serial warning -->
    <div v-if="!webSerial.supported" class="text-xs text-yellow-400 bg-yellow-900/20 rounded px-3 py-2">
      ⚠ Web Serial API not available. Use Chrome or Edge.
    </div>

    <!-- ─── Connection (always expanded) ──────────────────────────────────── -->
    <div class="panel overflow-hidden">
      <div class="w-full flex items-center gap-2 px-3 py-2">
        <span class="label flex-1 text-left">Serial Connection</span>
        <div class="w-2 h-2 rounded-full shrink-0" :class="deviceStore.connected ? 'bg-green-400 animate-pulse' : 'bg-surface-600'" />
        <button class="p-0.5 text-white/30 hover:text-white/60 transition-colors shrink-0"
          title="Advanced settings"
          @click.stop="showAdvanced = !showAdvanced">
          <svg class="w-3.5 h-3.5 transition-transform" :class="showAdvanced ? 'rotate-45 text-accent-400' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
          </svg>
        </button>
      </div>

      <div class="px-3 pb-3 flex flex-col gap-2">
        <!-- Advanced: baud rate + tcode version (hidden by default) -->
        <Transition name="slide-down">
          <div v-if="showAdvanced" class="grid grid-cols-2 gap-2 pt-1">
            <div>
              <p class="label mb-1">Baud Rate</p>
              <select v-model.number="deviceStore.baudRate" class="input w-full text-xs">
                <option :value="9600">9600</option>
                <option :value="19200">19200</option>
                <option :value="38400">38400</option>
                <option :value="57600">57600</option>
                <option :value="115200">115200</option>
                <option :value="230400">230400</option>
              </select>
            </div>
            <div>
              <p class="label mb-1">TCode</p>
              <select v-model="deviceStore.tcodeVersion" class="input w-full text-xs">
                <option value="v2">v2 (000-999)</option>
                <option value="v3">v3 (0000-9999)</option>
              </select>
            </div>
          </div>
        </Transition>

        <!-- Connect button -->
        <button
          class="w-full text-sm font-medium py-2 rounded-lg transition-colors"
          :class="deviceStore.connected ? 'bg-red-700/60 hover:bg-red-700 text-white' : 'bg-accent-600 hover:bg-accent-500 text-white'"
          :disabled="!webSerial.supported"
          @click="handleConnect"
        >
          {{ deviceStore.connected ? '⏏ Disconnect' : '⚡ Select Port & Connect' }}
        </button>

        <div class="flex items-center gap-2 text-xs">
          <div class="w-2 h-2 rounded-full" :class="deviceStore.connected ? 'bg-green-400 animate-pulse' : 'bg-red-500'" />
          <span :class="deviceStore.connected ? 'text-green-400' : 'text-white/40'">
            {{ deviceStore.connected ? `Connected · ${deviceStore.baudRate}` : 'Disconnected' }}
          </span>
        </div>
        <p v-if="deviceStore.connectionError" class="text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">
          {{ deviceStore.connectionError }}
        </p>
        <div v-if="deviceStore.lastCommand && deviceStore.connected" class="text-xs font-mono text-white/30 truncate">
          ↑ {{ deviceStore.lastCommand }}
        </div>
      </div>
    </div>

    <!-- ─── Presets ─────────────────────────────────────────────────────────── -->
    <div class="panel overflow-hidden">
      <button class="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors" @click="toggleSection('presets')">
        <svg class="w-3 h-3 text-white/40 transition-transform shrink-0" :class="openSection === 'presets' ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
        </svg>
        <span class="label flex-1 text-left">Device Presets</span>
        <span v-if="activePresetId" class="text-[10px] text-accent-400 shrink-0">
          {{ deviceStore.allPresets.find(p => p.id === activePresetId)?.name }}
        </span>
      </button>

      <div v-if="openSection === 'presets'" class="px-3 pb-3 flex flex-col gap-2 mt-2">
        <div class="flex flex-col gap-1">
          <div
            v-for="preset in deviceStore.allPresets"
            :key="preset.id"
            class="rounded-lg border transition-colors overflow-hidden"
            :class="activePresetId === preset.id ? 'border-accent-500 bg-accent-600/10' : 'border-white/8 bg-surface-800'"
          >
            <div class="flex items-center gap-1.5 px-2 py-1.5">
              <div class="w-1.5 h-1.5 rounded-full shrink-0 transition-colors"
                :class="activePresetId === preset.id ? 'bg-accent-400' : 'bg-transparent'" />

              <div class="flex-1 min-w-0">
                <input
                  v-if="renamingId === preset.id"
                  v-model="renameValue"
                  class="w-full bg-surface-900 border border-accent-500 rounded px-1.5 py-0.5 text-xs text-white outline-none"
                  autofocus
                  @keydown.enter="commitRename(preset.id)"
                  @keydown.escape="renamingId = null"
                  @blur="commitRename(preset.id)"
                />
                <span v-else class="text-xs truncate block" :class="activePresetId === preset.id ? 'text-accent-300 font-medium' : 'text-white/70'">
                  {{ preset.name }}
                  <span v-if="preset.builtin" class="ml-1 text-[9px] text-white/25 font-normal">built-in</span>
                </span>
              </div>

              <!-- Expand -->
              <button class="text-white/30 hover:text-white/60 transition-colors p-0.5 shrink-0" @click="toggleExpand(preset.id)">
                <svg class="w-3 h-3 transition-transform" :class="expandedPresetId === preset.id ? 'rotate-180' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                </svg>
              </button>
              <!-- Rename -->
              <button v-if="!preset.builtin && renamingId !== preset.id"
                class="text-white/30 hover:text-white/60 transition-colors p-0.5 shrink-0"
                @click="startRename(preset)">
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                </svg>
              </button>
              <!-- Delete -->
              <button v-if="!preset.builtin"
                class="text-white/25 hover:text-red-400 transition-colors p-0.5 shrink-0"
                @click="handleDeletePreset(preset.id)">
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
              <!-- Apply -->
              <button
                class="text-xs px-2 py-0.5 rounded transition-colors shrink-0 font-medium"
                :class="activePresetId === preset.id ? 'bg-accent-600/30 text-accent-300 cursor-default' : 'bg-accent-600 hover:bg-accent-500 text-white'"
                @click="handleApplyPreset(preset)"
              >{{ activePresetId === preset.id ? '✓' : 'Apply' }}</button>
            </div>

            <!-- Expanded axes — 2 columns -->
            <div v-if="expandedPresetId === preset.id" class="border-t border-white/5 px-3 py-2 grid grid-cols-2 gap-x-3 gap-y-1">
              <div v-for="entry in preset.axes" :key="entry.channel" class="flex items-center gap-1.5">
                <div class="w-1.5 h-1.5 rounded-full shrink-0" :class="entry.enabled ? 'bg-accent-400' : 'bg-white/10'" />
                <span class="text-[10px] font-mono text-white/50 w-5 shrink-0">{{ entry.channel }}</span>
                <span class="text-[10px] text-white/30 font-mono">{{ pct(entry.min) }}–{{ pct(entry.max) }}</span>
                <span v-if="entry.invert" class="text-[9px] text-orange-400/70 ml-auto">INV</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Save as new -->
        <div class="flex gap-1.5 mt-1">
          <input v-model="newPresetName" placeholder="New preset name…" class="input flex-1 text-xs py-1" @keydown.enter="handleSavePreset" />
          <button class="btn-ghost text-xs px-2 py-1 shrink-0" :disabled="!newPresetName.trim()" @click="handleSavePreset">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"/>
            </svg>
            Save
          </button>
        </div>
      </div>
    </div>

    <!-- ─── Axes ────────────────────────────────────────────────────────────── -->
    <div class="panel overflow-hidden">
      <button class="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors" @click="toggleSection('axes')">
        <svg class="w-3 h-3 text-white/40 transition-transform shrink-0" :class="openSection === 'axes' ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
        </svg>
        <span class="label flex-1 text-left">Axes</span>
        <span class="text-[10px] text-white/30 shrink-0">{{ deviceStore.enabledAxes.length }} active</span>
        <button class="text-xs text-white/30 hover:text-white/60 transition-colors ml-1 shrink-0" @click.stop="homeAllAxes()">Home All</button>
      </button>

      <div v-if="openSection === 'axes'" class="px-3 pb-3 flex flex-col gap-0 mt-2">
        <div
          v-for="axis in deviceStore.orderedAxes"
          :key="axis.channel"
          class="flex flex-col gap-2 py-2 border-t border-white/5 first:border-0 first:pt-0"
        >
          <div class="flex items-center gap-2">
            <button
              class="w-5 h-5 rounded flex items-center justify-center transition-colors shrink-0"
              :class="axis.enabled ? 'bg-accent-600 text-white' : 'bg-surface-700 text-white/30'"
              @click="axis.enabled = !axis.enabled; save()"
            >
              <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path v-if="axis.enabled" fill-rule="evenodd" clip-rule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"/>
                <path v-else fill-rule="evenodd" clip-rule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"/>
              </svg>
            </button>
            <span class="text-xs font-mono text-accent-400 w-6 shrink-0">{{ axis.channel }}</span>
            <span class="text-xs text-white/70 flex-1">{{ axis.label }}</span>
            <button
              class="text-xs px-1.5 py-0.5 rounded transition-colors"
              :class="axis.invert ? 'bg-orange-600/40 text-orange-300' : 'text-white/30 hover:text-white/60'"
              @click="axis.invert = !axis.invert; save()"
            >INV</button>
            <button
              class="text-xs px-1.5 py-0.5 rounded text-white/30 hover:text-white/60 transition-colors"
              :disabled="!deviceStore.connected || !axis.enabled"
              @click="testAxis(axis.channel)"
            >TEST</button>
          </div>

          <div v-if="axis.enabled" class="grid grid-cols-2 gap-x-3 gap-y-1 pl-7">
            <div>
              <div class="flex justify-between">
                <span class="text-[10px] text-white/40">Min</span>
                <span class="text-[10px] font-mono text-white/60">{{ pct(axis.min) }}</span>
              </div>
              <input type="range" min="0" max="1" step="0.01" :value="axis.min" class="w-full accent"
                @input="axis.min = parseFloat(($event.target as HTMLInputElement).value); save()" />
            </div>
            <div>
              <div class="flex justify-between">
                <span class="text-[10px] text-white/40">Max</span>
                <span class="text-[10px] font-mono text-white/60">{{ pct(axis.max) }}</span>
              </div>
              <input type="range" min="0" max="1" step="0.01" :value="axis.max" class="w-full accent"
                @input="axis.max = parseFloat(($event.target as HTMLInputElement).value); save()" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ─── Buttplug / Intiface ────────────────────────────────────────────── -->
    <div class="panel overflow-hidden">
      <button class="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors" @click="toggleSection('buttplug')">
        <svg class="w-3 h-3 text-white/40 transition-transform shrink-0" :class="openSection === 'buttplug' ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
        </svg>
        <span class="label flex-1 text-left">Buttplug / Intiface</span>
        <div class="flex items-center gap-1.5 shrink-0">
          <div class="w-2 h-2 rounded-full" :class="bp.connected.value ? 'bg-pink-400 animate-pulse' : 'bg-surface-600'" />
          <span v-if="bp.deviceCount.value > 0" class="text-[10px] text-pink-300">{{ bp.deviceCount.value }} device{{ bp.deviceCount.value !== 1 ? 's' : '' }}</span>
        </div>
      </button>

      <div v-if="openSection === 'buttplug'" class="px-3 pb-3 flex flex-col gap-2.5 mt-1">
        <!-- Enable toggle -->
        <div class="flex items-center justify-between">
          <span class="text-xs text-white/50">Enable output</span>
          <div class="relative w-9 h-5 rounded-full cursor-pointer transition-colors"
            :class="bp.enabled.value ? 'bg-pink-600' : 'bg-surface-700'"
            @click="bp.setEnabled(!bp.enabled.value)">
            <div class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
              :class="bp.enabled.value ? 'translate-x-4' : 'translate-x-0.5'" />
          </div>
        </div>

        <!-- Server URL -->
        <div>
          <p class="label mb-1">Intiface Server URL</p>
          <input v-model="bpUrl" class="input w-full text-xs py-1 font-mono" placeholder="ws://localhost:12345" />
          <p class="text-[10px] text-white/25 mt-0.5">Open Intiface Central, then connect here.</p>
        </div>

        <!-- Connect button -->
        <button
          class="w-full text-sm font-medium py-2 rounded-lg transition-colors"
          :class="bp.connected.value ? 'bg-red-700/60 hover:bg-red-700 text-white' : 'bg-pink-700 hover:bg-pink-600 text-white'"
          @click="handleBpConnect"
        >
          {{ bp.connected.value ? '⏏ Disconnect' : '🔌 Connect to Intiface' }}
        </button>

        <!-- Error -->
        <p v-if="bp.error.value" class="text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">{{ bp.error.value }}</p>

        <!-- Status -->
        <div v-if="bp.connected.value" class="flex items-center gap-2 text-xs">
          <div class="w-2 h-2 rounded-full bg-pink-400 animate-pulse" />
          <span class="text-pink-300">Connected · {{ bp.deviceCount.value }} device{{ bp.deviceCount.value !== 1 ? 's' : '' }}</span>
          <div class="flex gap-1 ml-auto">
            <span v-if="bp.hasLinear.value" class="text-[10px] px-1.5 py-0.5 rounded bg-teal-700/40 text-teal-300">Linear</span>
            <span v-if="bp.hasVibrators.value" class="text-[10px] px-1.5 py-0.5 rounded bg-pink-700/40 text-pink-300">Vibe</span>
          </div>
        </div>

        <!-- Scan + Stop -->
        <div v-if="bp.connected.value" class="flex gap-2">
          <button
            class="flex-1 text-xs py-1.5 rounded-lg transition-colors font-medium"
            :class="bp.scanning.value ? 'bg-amber-700/50 text-amber-300' : 'bg-white/10 hover:bg-white/15 text-white/70'"
            @click="bp.scanning.value ? bp.stopScan() : bp.startScan()"
          >
            {{ bp.scanning.value ? '⏹ Stop Scan' : '🔍 Scan (5s)' }}
          </button>
          <button v-if="bp.deviceCount.value > 0" class="text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/50 transition-colors"
            @click="bp.stopAll()">Stop All</button>
        </div>

        <!-- Device list -->
        <div v-if="bp.connected.value && bp.devices.value.length > 0" class="flex flex-col gap-1">
          <p class="label mb-0.5">Connected Devices</p>
          <div v-for="dev in bp.devices.value" :key="dev.index"
            class="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-surface-800 border border-white/5">
            <div class="w-1.5 h-1.5 rounded-full bg-pink-400 shrink-0" />
            <span class="text-xs text-white/80 flex-1 truncate">{{ dev.name }}</span>
            <span class="text-[10px] text-white/30 shrink-0">#{{ dev.index }}</span>
          </div>
        </div>

        <p v-else-if="bp.connected.value && bp.devices.value.length === 0 && !bp.scanning.value"
          class="text-xs text-white/30 text-center py-1">
          No devices found. Click Scan.
        </p>
        <p v-else-if="bp.scanning.value" class="text-xs text-amber-300/70 text-center py-1 animate-pulse">
          Scanning for devices…
        </p>
      </div>
    </div>

    <!-- ─── Settings export/import ─────────────────────────────────────────── -->
    <div class="panel overflow-hidden">
      <button class="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors" @click="toggleSection('settings')">
        <svg class="w-3 h-3 text-white/40 transition-transform shrink-0" :class="openSection === 'settings' ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
        </svg>
        <span class="label flex-1 text-left">Settings File (.goon)</span>
      </button>

      <div v-if="openSection === 'settings'" class="px-3 pb-3 flex flex-col gap-2 mt-2">
        <p class="text-[10px] text-white/30">Export / import all app settings including presets, theme, and playback preferences.</p>
        <div class="flex gap-2">
          <button class="btn-ghost flex-1 text-xs py-2 justify-center" @click="downloadGoon">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
            Export
          </button>
          <button class="btn-ghost flex-1 text-xs py-2 justify-center" @click="handleImport">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12"/>
            </svg>
            Import
          </button>
        </div>
        <p v-if="importOk" class="text-xs text-green-400 bg-green-900/20 rounded px-2 py-1">✓ Settings imported successfully</p>
        <p v-if="importError" class="text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">✗ {{ importError }}</p>
      </div>
    </div>

  </div>
</template>

<style scoped>
.slide-down-enter-active, .slide-down-leave-active { transition: all 0.18s ease; overflow: hidden; }
.slide-down-enter-from, .slide-down-leave-to { opacity: 0; max-height: 0; }
.slide-down-enter-to, .slide-down-leave-from { opacity: 1; max-height: 120px; }
</style>

