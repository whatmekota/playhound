import { useLocalStorage } from '@vueuse/core'
import { reactive, ref } from 'vue'

export type TransitionName = 'fade' | 'slide' | 'zoom' | 'flip' | 'blur' | 'wipe' | 'rotate' | 'none'

export interface SlideshowItem {
  id: string
  type: 'image' | 'video' | 'youtube'
  src: string
  label: string
  duration?: number // per-slide delay override (seconds)
  fit?: 'contain' | 'cover' // per-slide object-fit
}

export interface SlideshowOverlay {
  id: string
  type: 'image' | 'video'
  src: string
  label: string
  opacity: number
  blendMode: string
  enabled: boolean
  fit: 'cover' | 'contain' | 'fill'
}

export interface SlideshowSettings {
  delay: number
  transition: TransitionName
  loop: boolean
  shuffle: boolean
  beatSync: boolean
  beatsPerSlide: number
  /** Advance on the shared session pulse instead of a timer. */
  pulseSync: boolean
  /** Pulse cycles per slide when pulseSync is on. */
  pulsesPerSlide: number
  autoTransition: boolean
  lfoOverlays: boolean
  randomTransition: boolean
  transitionPool: TransitionName[]
}

const ALL_TRANSITIONS: TransitionName[] = ['fade', 'slide', 'zoom', 'flip', 'blur', 'wipe', 'rotate', 'none']

const items = reactive<SlideshowItem[]>([])
const overlays = reactive<SlideshowOverlay[]>([])
const settings = useLocalStorage<SlideshowSettings>('ph:slideshow.settings', {
  delay: 5,
  transition: 'fade',
  loop: true,
  shuffle: false,
  beatSync: false,
  beatsPerSlide: 8,
  pulseSync: false,
  pulsesPerSlide: 8,
  autoTransition: false,
  lfoOverlays: false,
  randomTransition: false,
  transitionPool: ['fade', 'slide', 'zoom', 'flip', 'blur', 'wipe', 'rotate'],
}, { mergeDefaults: true })
const isPlaying = ref(false)
const currentIndex = ref(0)

function addItem(item: Omit<SlideshowItem, 'id'>) {
  items.push({ ...item, id: crypto.randomUUID() })
}

function removeItem(id: string) {
  const idx = items.findIndex(i => i.id === id)
  if (idx >= 0) {
    items.splice(idx, 1)
    if (currentIndex.value >= items.length && currentIndex.value > 0)
      currentIndex.value = items.length - 1
  }
}

function moveItem(from: number, to: number) {
  const [item] = items.splice(from, 1)
  items.splice(to, 0, item)
}

function updateItem(id: string, patch: Partial<SlideshowItem>) {
  const item = items.find(i => i.id === id)
  if (item)
    Object.assign(item, patch)
}

function addOverlay(overlay: Omit<SlideshowOverlay, 'id'>) {
  overlays.push({ ...overlay, id: crypto.randomUUID() })
}

function removeOverlay(id: string) {
  const idx = overlays.findIndex(o => o.id === id)
  if (idx >= 0)
    overlays.splice(idx, 1)
}

function updateOverlay(id: string, patch: Partial<SlideshowOverlay>) {
  const o = overlays.find(o => o.id === id)
  if (o)
    Object.assign(o, patch)
}

export function useSlideshowStore() {
  return {
    items,
    settings,
    isPlaying,
    currentIndex,
    addItem,
    removeItem,
    moveItem,
    updateItem,
    overlays,
    addOverlay,
    removeOverlay,
    updateOverlay,
    ALL_TRANSITIONS,
  }
}
