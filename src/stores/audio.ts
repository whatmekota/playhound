import { useLocalStorage } from '@vueuse/core'
import { ref } from 'vue'

export type SessionPhase = 'idle' | 'entry' | 'build' | 'peak' | 'descent'
export type NoiseType = 'brown' | 'pink' | 'white'

const baseFrequency = useLocalStorage('ph-base-freq', 200)
const beatDelta = useLocalStorage('ph-beat-delta', 6)
const volume = useLocalStorage('ph-volume', 0.4)
const waveType = useLocalStorage<OscillatorType>('ph-wave-type', 'sine')
const isPlaying = ref(false)
const currentPreset = ref('')

// Session engine
const intensity = ref(0.5)
const phase = ref<SessionPhase>('idle')
const driftMode = ref(false)
const sessionActive = ref(false)

// Noise layer
const noiseEnabled = ref(false)
const noiseVolume = ref(0.15)
const noiseType = ref<NoiseType>('brown')

// Advanced audio
const harmonicsEnabled = ref(false)
const beatDriftEnabled = ref(false)

export function useAudioStore() {
  return {
    baseFrequency,
    beatDelta,
    volume,
    waveType,
    isPlaying,
    currentPreset,
    intensity,
    phase,
    driftMode,
    sessionActive,
    noiseEnabled,
    noiseVolume,
    noiseType,
    harmonicsEnabled,
    beatDriftEnabled,
  }
}
