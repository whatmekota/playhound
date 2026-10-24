import { useLocalStorage } from '@vueuse/core'
import { ref } from 'vue'

export { CARRIER_MAX, CARRIER_MIN, CARRIER_RECOMMENDED, MAX_BEAT_HZ } from '~/lib/audioLimits'

export type SessionPhase = 'idle' | 'entry' | 'build' | 'peak' | 'descent'
export type NoiseType = 'brown' | 'pink' | 'white'
export type BeatMode = 'binaural' | 'monaural' | 'isochronic'

const baseFrequency = useLocalStorage('ph:audio.baseFreq', 300)
const beatDelta = useLocalStorage('ph:audio.beatDelta', 6)
const volume = useLocalStorage('ph:audio.volume', 0.4)
const waveType = useLocalStorage<OscillatorType>('ph:audio.waveType', 'sine')
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

/**
 * How the beat is produced. Binaural is the familiar one and the weakest;
 * amplitude-modulated (isochronic) stimuli drive a markedly stronger cortical
 * response, with monaural in between.
 */
const beatMode = useLocalStorage<BeatMode>('ph:audio.beatMode', 'binaural')

/**
 * Session pulse — the slow swell that the device stroke, the slideshow and the
 * visuals all lock to. Stored in cycles per minute because that is how the
 * stroke rate reads elsewhere.
 */
const pulseEnabled = useLocalStorage('ph:audio.pulseEnabled', false)
const pulseCpm = useLocalStorage('ph:audio.pulseCpm', 50)
const pulseDepth = useLocalStorage('ph:audio.pulseDepth', 0.45)
/** Pulse follows session intensity rather than sitting at a fixed tempo. */
const pulseFollowsSession = useLocalStorage('ph:audio.pulseFollow', true)

/**
 * Derive the beat from the funscript being watched instead of a fixed tempo:
 * the pulse locks to the script's stroke phase and its speed feeds intensity.
 */
const scriptDrive = useLocalStorage('ph:audio.scriptDrive', false)
const scriptDriveIntensity = useLocalStorage('ph:audio.scriptDriveIntensity', true)

/**
 * Take the tempo from the music in the video rather than a fixed rate.
 * Yields to a funscript, which describes what should happen far better than
 * a drum hit does.
 */
const musicDrive = useLocalStorage('ph:audio.musicDrive', false)

/** Session shape: one smooth rise and fall, or repeated build-hold-retreat. */
const sessionArc = useLocalStorage<'smooth' | 'edged'>('ph:audio.sessionArc', 'smooth')
const edgeCycles = useLocalStorage('ph:audio.edgeCycles', 3)

// Breath pacing: ~6 per minute with a longer exhale
const breathEnabled = useLocalStorage('ph:audio.breathEnabled', false)
const breathPeriod = useLocalStorage('ph:audio.breathPeriod', 10)
const breathInhaleRatio = useLocalStorage('ph:audio.breathInhale', 0.4)

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
    beatMode,
    pulseEnabled,
    pulseCpm,
    pulseDepth,
    pulseFollowsSession,
    breathEnabled,
    breathPeriod,
    breathInhaleRatio,
    sessionArc,
    edgeCycles,
    scriptDrive,
    scriptDriveIntensity,
    musicDrive,
  }
}
