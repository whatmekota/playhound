import { useLocalStorage } from '@vueuse/core'
import { KEYS } from '~/lib/persist'

/**
 * What the stage shows while an audio file plays: the slideshow or the media
 * wall as they are set up, the hypno overlay, or the track's cover.
 * One choice for every audio file, remembered.
 */
export type AudioVisual = 'slideshow' | 'wall' | 'hypno' | 'cover'

export const AUDIO_VISUALS: { value: AudioVisual, label: string, icon: string, hint: string }[] = [
  { value: 'slideshow', label: 'Slideshow', icon: 'i-carbon-image', hint: 'Your slideshow, in time with the track' },
  { value: 'wall', label: 'Media wall', icon: 'i-carbon-image-copy', hint: 'Your media wall, muted' },
  { value: 'hypno', label: 'Hypno', icon: 'i-carbon-circle-dash', hint: 'The hypno overlay' },
  { value: 'cover', label: 'Cover', icon: 'i-carbon-music', hint: 'The track\'s cover, or its script' },
]

// Module level: the player's picker and the stage read the same one.
const visual = useLocalStorage<AudioVisual>(KEYS.audioVisual.key, 'slideshow')

export function useAudioVisual() {
  if (!AUDIO_VISUALS.some(v => v.value === visual.value))
    visual.value = 'slideshow'
  return visual
}
