import { onScopeDispose, watch } from 'vue'
import { PhApp } from './app'
import { isAndroidApp } from './detect'

/**
 * The phone's Back button, for screens of the page that should close on it
 * (a post open over the EroScripts list). The most recent one still open
 * gets it; with none open, Back leaves the app as it always did.
 *
 * Returns a function that gives Back up again. Does nothing outside the
 * Android app.
 */
const handlers: (() => void)[] = []
let listening: Promise<unknown> | null = null

export function onAndroidBack(handler: () => void): () => void {
  if (!isAndroidApp)
    return () => {}
  handlers.push(handler)
  listening ??= PhApp.addListener('back', () => handlers.at(-1)?.()).catch(() => null)
  if (handlers.length === 1)
    void PhApp.setBackHandler({ on: true }).catch(() => {})
  return () => {
    const i = handlers.lastIndexOf(handler)
    if (i < 0)
      return
    handlers.splice(i, 1)
    if (!handlers.length)
      void PhApp.setBackHandler({ on: false }).catch(() => {})
  }
}

/**
 * onAndroidBack for as long as `open()` holds, in a component: a dialog,
 * sheet, panel or page over the rest that Back should close. Given up again
 * when it closes, or when the component goes away while open.
 */
export function useAndroidBack(open: () => boolean, close: () => void): void {
  if (!isAndroidApp)
    return
  let giveUp: (() => void) | null = null
  watch(open, (on) => {
    giveUp?.()
    giveUp = on ? onAndroidBack(close) : null
  }, { immediate: true })
  onScopeDispose(() => giveUp?.())
}
