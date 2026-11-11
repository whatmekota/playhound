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
