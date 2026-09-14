import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { AXIS_PRIORITY } from '~/lib/axisMap'

export interface AxisConfig {
  channel: string
  label: string
  enabled: boolean
  min: number      // 0–1
  max: number      // 0–1
  invert: boolean
  defaultPos: number  // 0–1 resting position
}

export interface DeviceConfig {
  portPath: string
  baudRate: number
  connected: boolean
  tcodeVersion: 'v2' | 'v3'
}

// ─── Preset types ─────────────────────────────────────────────────────────────
export interface AxisPresetEntry {
  channel: string
  enabled: boolean
  min: number
  max: number
  invert: boolean
  defaultPos: number
}

export interface DevicePreset {
  id: string          // uuid or builtin key
  name: string
  builtin: boolean
  axes: AxisPresetEntry[]
}

const DEFAULT_AXIS_CONFIGS: Record<string, AxisConfig> = {
  L0: { channel: 'L0', label: 'Stroke',  enabled: true,  min: 0.05, max: 0.95, invert: false, defaultPos: 0.5 },
  L1: { channel: 'L1', label: 'Surge',   enabled: false, min: 0.05, max: 0.95, invert: false, defaultPos: 0.5 },
  L2: { channel: 'L2', label: 'Sway',    enabled: false, min: 0.05, max: 0.95, invert: false, defaultPos: 0.5 },
  R0: { channel: 'R0', label: 'Twist',   enabled: false, min: 0.1,  max: 0.9,  invert: false, defaultPos: 0.5 },
  R1: { channel: 'R1', label: 'Roll',    enabled: false, min: 0.1,  max: 0.9,  invert: false, defaultPos: 0.5 },
  R2: { channel: 'R2', label: 'Pitch',   enabled: false, min: 0.1,  max: 0.9,  invert: false, defaultPos: 0.5 },
  V0: { channel: 'V0', label: 'Vibrate', enabled: false, min: 0.0,  max: 1.0,  invert: false, defaultPos: 0.0 },
  A0: { channel: 'A0', label: 'Suction', enabled: false, min: 0.0,  max: 0.8,  invert: false, defaultPos: 0.0 },
  A1: { channel: 'A1', label: 'Pump',    enabled: false, min: 0.0,  max: 0.8,  invert: false, defaultPos: 0.0 },
}

// ─── Built-in presets ─────────────────────────────────────────────────────────
const BUILTIN_PRESETS: DevicePreset[] = [
  {
    id: 'builtin-full',
    name: 'Full Range (OSR2)',
    builtin: true,
    axes: [
      { channel: 'L0', enabled: true,  min: 0.05, max: 0.95, invert: false, defaultPos: 0.5 },
      { channel: 'L1', enabled: false, min: 0.05, max: 0.95, invert: false, defaultPos: 0.5 },
      { channel: 'L2', enabled: false, min: 0.05, max: 0.95, invert: false, defaultPos: 0.5 },
      { channel: 'R0', enabled: false, min: 0.10, max: 0.90, invert: false, defaultPos: 0.5 },
      { channel: 'R1', enabled: false, min: 0.10, max: 0.90, invert: false, defaultPos: 0.5 },
      { channel: 'R2', enabled: false, min: 0.10, max: 0.90, invert: false, defaultPos: 0.5 },
      { channel: 'V0', enabled: false, min: 0.00, max: 1.00, invert: false, defaultPos: 0.0 },
      { channel: 'A0', enabled: false, min: 0.00, max: 0.80, invert: false, defaultPos: 0.0 },
      { channel: 'A1', enabled: false, min: 0.00, max: 0.80, invert: false, defaultPos: 0.0 },
    ],
  },
  {
    id: 'builtin-fleshlight',
    name: 'Fleshlight',
    builtin: true,
    axes: [
      { channel: 'L0', enabled: true,  min: 0.10, max: 0.85, invert: false, defaultPos: 0.5 },
      { channel: 'L1', enabled: false, min: 0.10, max: 0.90, invert: false, defaultPos: 0.5 },
      { channel: 'L2', enabled: false, min: 0.10, max: 0.90, invert: false, defaultPos: 0.5 },
      { channel: 'R0', enabled: false, min: 0.15, max: 0.85, invert: false, defaultPos: 0.5 },
      { channel: 'R1', enabled: false, min: 0.15, max: 0.85, invert: false, defaultPos: 0.5 },
      { channel: 'R2', enabled: false, min: 0.15, max: 0.85, invert: false, defaultPos: 0.5 },
      { channel: 'V0', enabled: false, min: 0.00, max: 1.00, invert: false, defaultPos: 0.0 },
      { channel: 'A0', enabled: false, min: 0.00, max: 0.80, invert: false, defaultPos: 0.0 },
      { channel: 'A1', enabled: false, min: 0.00, max: 0.80, invert: false, defaultPos: 0.0 },
    ],
  },
  {
    id: 'builtin-onahole',
    name: 'Small Onahole',
    builtin: true,
    axes: [
      { channel: 'L0', enabled: true,  min: 0.20, max: 0.80, invert: false, defaultPos: 0.5 },
      { channel: 'L1', enabled: false, min: 0.20, max: 0.80, invert: false, defaultPos: 0.5 },
      { channel: 'L2', enabled: false, min: 0.20, max: 0.80, invert: false, defaultPos: 0.5 },
      { channel: 'R0', enabled: false, min: 0.20, max: 0.80, invert: false, defaultPos: 0.5 },
      { channel: 'R1', enabled: false, min: 0.20, max: 0.80, invert: false, defaultPos: 0.5 },
      { channel: 'R2', enabled: false, min: 0.20, max: 0.80, invert: false, defaultPos: 0.5 },
      { channel: 'V0', enabled: false, min: 0.00, max: 1.00, invert: false, defaultPos: 0.0 },
      { channel: 'A0', enabled: false, min: 0.00, max: 0.60, invert: false, defaultPos: 0.0 },
      { channel: 'A1', enabled: false, min: 0.00, max: 0.60, invert: false, defaultPos: 0.0 },
    ],
  },
]

export const useDeviceStore = defineStore('device', () => {
  const portPath = ref('')
  const baudRate = ref(115200)
  const connected = ref(false)
  const tcodeVersion = ref<'v2' | 'v3'>('v3')
  const axisConfigs = ref<Record<string, AxisConfig>>(structuredClone(DEFAULT_AXIS_CONFIGS))
  const deviceEnabled = ref(true)  // master toggle

  const availablePorts = ref<string[]>([])
  const connectionError = ref<string | null>(null)
  const lastCommand = ref<string | null>(null)

  // user-created presets (builtins are merged in at read time)
  const userPresets = ref<DevicePreset[]>([])

  const orderedAxes = computed(() =>
    AXIS_PRIORITY.map(ch => axisConfigs.value[ch]).filter(Boolean)
  )

  const enabledAxes = computed(() =>
    orderedAxes.value.filter(a => a.enabled)
  )

  // All presets: builtins first, then user-created
  const allPresets = computed((): DevicePreset[] => [
    ...BUILTIN_PRESETS,
    ...userPresets.value,
  ])

  function updateAxisConfig(channel: string, updates: Partial<AxisConfig>) {
    if (axisConfigs.value[channel]) {
      Object.assign(axisConfigs.value[channel], updates)
    }
  }

  function resetAxisConfig(channel: string) {
    if (DEFAULT_AXIS_CONFIGS[channel]) {
      axisConfigs.value[channel] = structuredClone(DEFAULT_AXIS_CONFIGS[channel])
    }
  }

  function resetAllAxisConfigs() {
    axisConfigs.value = structuredClone(DEFAULT_AXIS_CONFIGS)
  }

  // ─── Preset CRUD ──────────────────────────────────────────────────────────

  /** Apply a preset: update all matching axes */
  function applyPreset(preset: DevicePreset) {
    for (const entry of preset.axes) {
      if (axisConfigs.value[entry.channel]) {
        Object.assign(axisConfigs.value[entry.channel], {
          enabled: entry.enabled,
          min: entry.min,
          max: entry.max,
          invert: entry.invert,
          defaultPos: entry.defaultPos,
        })
      }
    }
  }

  /** Snapshot current axis state into a new user preset */
  function saveAsPreset(name: string): DevicePreset {
    const preset: DevicePreset = {
      id: crypto.randomUUID(),
      name,
      builtin: false,
      axes: AXIS_PRIORITY.map(ch => {
        const cfg = axisConfigs.value[ch]
        return {
          channel: ch,
          enabled: cfg?.enabled ?? false,
          min: cfg?.min ?? 0,
          max: cfg?.max ?? 1,
          invert: cfg?.invert ?? false,
          defaultPos: cfg?.defaultPos ?? 0.5,
        }
      }),
    }
    userPresets.value.push(preset)
    return preset
  }

  function renamePreset(id: string, name: string) {
    const p = userPresets.value.find(p => p.id === id)
    if (p) p.name = name
  }

  function deletePreset(id: string) {
    userPresets.value = userPresets.value.filter(p => p.id !== id)
  }

  /** Detect which preset currently matches the axis configs (if any) */
  function detectActivePreset(): string | null {
    for (const preset of allPresets.value) {
      const match = preset.axes.every(entry => {
        const cfg = axisConfigs.value[entry.channel]
        if (!cfg) return false
        return (
          cfg.enabled === entry.enabled &&
          Math.abs(cfg.min - entry.min) < 0.005 &&
          Math.abs(cfg.max - entry.max) < 0.005 &&
          cfg.invert === entry.invert
        )
      })
      if (match) return preset.id
    }
    return null
  }

  function serialize() {
    return {
      portPath: portPath.value,
      baudRate: baudRate.value,
      tcodeVersion: tcodeVersion.value,
      axisConfigs: axisConfigs.value,
      deviceEnabled: deviceEnabled.value,
      userPresets: userPresets.value,
    }
  }

  function deserialize(data: any) {
    if (!data) return
    if (data.portPath) portPath.value = data.portPath
    if (data.baudRate) baudRate.value = data.baudRate
    if (data.tcodeVersion) tcodeVersion.value = data.tcodeVersion
    if (data.axisConfigs) {
      for (const [ch, cfg] of Object.entries(data.axisConfigs as Record<string, AxisConfig>)) {
        if (axisConfigs.value[ch]) {
          Object.assign(axisConfigs.value[ch], cfg)
        }
      }
    }
    if (typeof data.deviceEnabled === 'boolean') deviceEnabled.value = data.deviceEnabled
    if (Array.isArray(data.userPresets)) userPresets.value = data.userPresets
  }

  return {
    portPath, baudRate, connected, tcodeVersion,
    axisConfigs, deviceEnabled,
    availablePorts, connectionError, lastCommand,
    orderedAxes, enabledAxes,
    userPresets, allPresets,
    updateAxisConfig, resetAxisConfig, resetAllAxisConfigs,
    applyPreset, saveAsPreset, renamePreset, deletePreset, detectActivePreset,
    serialize, deserialize,
  }
})
