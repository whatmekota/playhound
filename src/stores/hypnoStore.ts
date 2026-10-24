import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'

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
  }
})
