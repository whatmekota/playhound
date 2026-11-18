import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { metaDb } from '~/lib/idb'

export type FlashWhat = 'words' | 'pictures' | 'both'

export interface FlashPicture {
  id: string
  /** A JPEG data URL, scaled down to FLASH_PICTURE_PX. */
  url: string
}

const PICTURES_KEY = 'hypno.flashPictures'
/** Longest side of a kept picture: plenty for a flash, small enough to keep many. */
const FLASH_PICTURE_PX = 1280
export const FLASH_PICTURES_MAX = 60

async function shrink(file: File): Promise<string> {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, FLASH_PICTURE_PX / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(bmp.width * k))
  c.height = Math.max(1, Math.round(bmp.height * k))
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close()
  return c.toDataURL('image/jpeg', 0.85)
}

/**
 * Hypnotic overlay settings.
 *
 * Everything here is off by default and layered over the video without
 * intercepting input, so it can be dialled in while something is playing.
 */
export const useHypnoStore = defineStore('hypno', () => {
  const enabled = useLocalStorage('ph:hypno.enabled', false)

  // ─── Spiral ────────────────────────────────────────────────────────────────
  const spiral = useLocalStorage('ph:hypno.spiral', true)
  const spiralOpacity = useLocalStorage('ph:hypno.spiralOpacity', 0.18)
  /** Turns per pulse. Below one so it reads as a drift rather than a spin. */
  const spiralRate = useLocalStorage('ph:hypno.spiralRate', 0.12)
  const spiralReverse = useLocalStorage('ph:hypno.spiralReverse', false)
  const spiralArms = useLocalStorage('ph:hypno.spiralArms', 3)
  const spiralColor = useLocalStorage('ph:hypno.spiralColor', '#ffffff')
  /** Second colour for the alternating arms; blank means use the background. */
  const spiralColor2 = useLocalStorage('ph:hypno.spiralColor2', '#000000')
  const spiralTwoTone = useLocalStorage('ph:hypno.spiralTwoTone', false)

  // ─── Text ──────────────────────────────────────────────────────────────────
  const text = useLocalStorage('ph:hypno.text', false)
  const words = useLocalStorage('ph:hypno.words', 'breathe\ndeeper\nslower\nlet go\nstay')
  /** Pulses each word is held for. */
  const wordEvery = useLocalStorage('ph:hypno.wordEvery', 8)
  const textSize = useLocalStorage('ph:hypno.textSize', 48)
  const textOpacity = useLocalStorage('ph:hypno.textOpacity', 0.5)
  const textColor = useLocalStorage('ph:hypno.textColor', '#ffffff')

  // ─── Breathing ring ────────────────────────────────────────────────────────
  const ring = useLocalStorage('ph:hypno.ring', false)
  const ringOpacity = useLocalStorage('ph:hypno.ringOpacity', 0.25)
  const ringColor = useLocalStorage('ph:hypno.ringColor', '#ffffff')

  // ─── Framing ───────────────────────────────────────────────────────────────
  /** Darkens the edges so attention falls to the middle. */
  const vignette = useLocalStorage('ph:hypno.vignette', 0)

  // ─── Flashes ───────────────────────────────────────────────────────────────
  // A word or a picture flashed on the stroke: at the bottom of every few
  // strokes of the playing script, or on the session pulse without one.
  const flash = useLocalStorage('ph:hypno.flash', false)
  const flashWhat = useLocalStorage<FlashWhat>('ph:hypno.flashWhat', 'words')
  const flashWords = useLocalStorage('ph:hypno.flashWords', 'good\ndeeper\ndon\'t stop\nmore\ngive in\nyes\nstroke')
  /** Strokes (or pulses) between flashes. */
  const flashEvery = useLocalStorage('ph:hypno.flashEvery', 2)
  /** How long a flash holds before it fades, ms. */
  const flashMs = useLocalStorage('ph:hypno.flashMs', 140)
  const flashOpacity = useLocalStorage('ph:hypno.flashOpacity', 0.85)

  /** The user's own pictures to flash, kept in the browser's database. */
  const flashPictures = shallowRef<FlashPicture[]>([])
  void metaDb.get<FlashPicture[]>(PICTURES_KEY).then((list) => {
    if (Array.isArray(list))
      flashPictures.value = list.filter(p => p && typeof p.url === 'string')
  }).catch(() => {})
  function savePictures(list: FlashPicture[]) {
    flashPictures.value = list
    void metaDb.set(PICTURES_KEY, list).catch(() => {})
  }
  /** Add pictures, scaled down; returns how many went in (the rest were not images, or over the limit). */
  async function addFlashPictures(files: Iterable<File>): Promise<number> {
    const added: FlashPicture[] = []
    for (const f of files) {
      if (flashPictures.value.length + added.length >= FLASH_PICTURES_MAX)
        break
      if (!f.type.startsWith('image/'))
        continue
      try {
        added.push({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, url: await shrink(f) })
      }
      catch {
        // Not a picture this browser can read.
      }
    }
    if (added.length)
      savePictures([...flashPictures.value, ...added])
    return added.length
  }
  function removeFlashPicture(id: string) {
    savePictures(flashPictures.value.filter(p => p.id !== id))
  }
  function clearFlashPictures() {
    savePictures([])
  }

  return {
    enabled,
    spiral,
    spiralOpacity,
    spiralRate,
    spiralReverse,
    spiralArms,
    spiralColor,
    spiralColor2,
    spiralTwoTone,
    text,
    words,
    wordEvery,
    textSize,
    textOpacity,
    textColor,
    ring,
    ringOpacity,
    ringColor,
    vignette,
    flash,
    flashWhat,
    flashWords,
    flashEvery,
    flashMs,
    flashOpacity,
    flashPictures,
    addFlashPictures,
    removeFlashPicture,
    clearFlashPictures,
  }
})
