import { useLocalStorage } from '@vueuse/core'
import { watch } from 'vue'
import { desktop } from '~/lib/browserApi'
import { KEYS } from '~/lib/persist'

/**
 * Interface size: the whole app larger, for a big screen far away.
 *
 * In the desktop app it is the window's zoom, which scales everything evenly
 * (text, icons, the player's bars, layout breakpoints) the way a browser's
 * Ctrl + = does. A browser has that already and gives pages no say in it, so
 * there the setting just points at it.
 */

export const UI_SCALES = [1, 1.25, 1.5, 1.75, 2] as const

let scale: ReturnType<typeof useLocalStorage<number>> | null = null

export function useUiScale() {
  scale ??= useLocalStorage<number>(KEYS.uiScale.key, 1)
  return { scale, supported: !!desktop?.window?.setZoom }
}

function clamp(s: number) {
  return Number.isFinite(s) ? Math.max(UI_SCALES[0], Math.min(UI_SCALES.at(-1)!, s)) : 1
}

/** One size up or down the list, from wherever it is now. */
export function stepUiScale(dir: 1 | -1) {
  const { scale } = useUiScale()
  const cur = clamp(scale.value)
  const next = dir > 0 ? UI_SCALES.find(s => s > cur + 0.001) : [...UI_SCALES].reverse().find(s => s < cur - 0.001)
  if (next)
    scale.value = next
}

/** Apply it, now and on every change, and give the desktop app the usual zoom keys. Once, from the shell. */
export function startUiScale() {
  const setZoom = desktop?.window?.setZoom
  if (!setZoom)
    return
  const { scale } = useUiScale()
  watch(scale, s => setZoom(clamp(s)), { immediate: true })
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey)
      return
    if (e.code === 'Equal' || e.code === 'NumpadAdd')
      stepUiScale(1)
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract')
      stepUiScale(-1)
    else if (e.code === 'Digit0' || e.code === 'Numpad0')
      scale.value = 1
    else
      return
    e.preventDefault()
  })
}
