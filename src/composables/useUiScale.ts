import { useLocalStorage } from '@vueuse/core'
import { watch } from 'vue'
import { desktop } from '~/lib/browserApi'
import { KEYS } from '~/lib/persist'
import { isAndroidApp } from '~/lib/platform'

/**
 * Interface size: the whole app larger, for a big screen far away.
 *
 * In the desktop app it is the window's zoom, which scales everything evenly
 * (text, icons, the player's bars, layout breakpoints) the way a browser's
 * Ctrl + = does. The Android app gets the same from the page's viewport tag
 * (viewportZoom). A browser has its own zoom and gives pages no say in it,
 * so there the setting just points at it.
 */

export const UI_SCALES = [1, 1.25, 1.5, 1.75, 2] as const

let scale: ReturnType<typeof useLocalStorage<number>> | null = null

/** How the size is applied here, if it can be. */
function applier(): ((s: number) => void) | null {
  const setZoom = desktop?.window?.setZoom
  if (setZoom)
    return s => setZoom(s)
  if (isAndroidApp)
    return viewportZoom
  return null
}

export function useUiScale() {
  scale ??= useLocalStorage<number>(KEYS.uiScale.key, 1)
  return { scale, supported: !!applier() }
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

const VIEWPORT_DEFAULT = 'width=device-width, initial-scale=1.0'
let viewportAsShipped: string | null = null

/**
 * The viewport tag's content for a size: a page scale fixed at it, which lays
 * the page out at the screen's width ÷ the size and draws it sharp at that
 * scale. Unlike CSS zoom on the page (under which 100vh overflows and fixed
 * popups land at the zoom times their place), the window's size, the
 * coordinates and the layout breakpoints all follow, as with the desktop
 * app's zoom.
 *
 * No width in it, on purpose: the Android WebView (narrow viewport,
 * Capacitor's default) lays a page out at its own width ÷ the page's initial
 * scale, and Chrome does the same with no width given. With
 * `width=device-width` the WebView divides a second time once the app has an
 * initial scale of its own (Blink, PageScaleConstraintsSet::
 * AdjustForAndroidWebViewQuirks).
 */
export function viewportContent(s: number, shipped = VIEWPORT_DEFAULT) {
  return s === 1 ? shipped : `initial-scale=${s}, minimum-scale=${s}, maximum-scale=${s}, user-scalable=no`
}

function viewportZoom(s: number) {
  const meta = document.querySelector('meta[name="viewport"]')
  if (!meta)
    return
  viewportAsShipped ??= meta.getAttribute('content') || VIEWPORT_DEFAULT
  meta.setAttribute('content', viewportContent(s, viewportAsShipped))
}

/** Apply it, now and on every change, and give the app the usual zoom keys. Once, from the shell. */
export function startUiScale() {
  const apply = applier()
  if (!apply)
    return
  const { scale } = useUiScale()
  watch(scale, s => apply(clamp(s)), { immediate: true })
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
