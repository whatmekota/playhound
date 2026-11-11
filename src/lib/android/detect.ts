/**
 * The Android app (Capacitor, android/). Its native bridge sets up
 * window.Capacitor before any of the page's scripts run, so this is known
 * at once. The browser and the desktop app have no such global.
 *
 * On its own so browserApi and platform can both use it without importing
 * each other. Use it through platform.ts (isAndroidApp).
 */
function detectAndroidApp(): boolean {
  const cap = (globalThis as any).Capacitor
  try {
    return !!cap && cap.isNativePlatform?.() === true && cap.getPlatform?.() === 'android'
  }
  catch {
    return false
  }
}

export const isAndroidApp = detectAndroidApp()

/**
 * Development only: the Android app's phone layout in a desktop browser, for
 * styling and screenshots. `?phone` in the address turns it on for the tab
 * (it survives reloads), `?phone=0` off. Nothing native is pretended:
 * isAndroidApp stays false, so files, devices and the rest are the browser's.
 * A production build leaves this out entirely.
 */
function detectDevPhoneLayout(): boolean {
  if (!import.meta.env.DEV || typeof location === 'undefined' || typeof sessionStorage === 'undefined')
    return false
  try {
    const q = new URLSearchParams(location.search).get('phone')
    if (q !== null)
      sessionStorage.setItem('ph-dev-phone', q === '0' ? '0' : '1')
    return sessionStorage.getItem('ph-dev-phone') === '1'
  }
  catch {
    return false
  }
}

export const devPhoneLayout = detectDevPhoneLayout()
