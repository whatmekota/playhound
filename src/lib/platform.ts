import { isAndroidApp } from './android/detect'
import { desktop } from './browserApi'

/**
 * Which keyboard the shortcuts are written for. The handlers already take
 * Ctrl or ⌘ alike (ctrlKey || metaKey); this only changes how they are shown.
 * The desktop app knows its platform; a browser goes by what it reports.
 */
function detectMac(): boolean {
  if (desktop?.platform)
    return desktop.platform === 'darwin'
  if (typeof navigator === 'undefined')
    return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent || '')
}

export const isMac = detectMac()

/** The Android app (Capacitor, android/); see android/detect.ts. */
export { isAndroidApp }

/**
 * Where a browser feature is missing, what to say about it, worded for where
 * playhound runs. The Android WebView has neither Web Bluetooth nor Web
 * Serial; the app puts its own on navigator (android/shims.ts), so there
 * these only show if that failed.
 */
export const MISSING = isAndroidApp
  ? {
      bluetooth: 'Bluetooth did not start in the app. Close playhound and open it again; the Handy also works over WiFi.',
      bluetoothShort: 'Bluetooth did not start: reopen the app',
      heartRate: 'Bluetooth did not start in the app. Close playhound and open it again.',
      serial: 'USB did not start in the app. Close playhound and open it again, or use TCode over the network.',
      serialShort: 'USB did not start: reopen the app',
      streaming: 'Streaming from file hosts is coming to the Android app.',
    }
  : {
      bluetooth: 'This browser has no Web Bluetooth. Use Chrome, Edge or the desktop app.',
      bluetoothShort: 'Use Chrome, Edge or the desktop app',
      heartRate: 'This browser has no Web Bluetooth. Use Chrome, Edge or the desktop app.',
      serial: 'This browser cannot talk to USB serial devices. Open playhound in Chrome or Edge, or use the network or Intiface.',
      serialShort: 'Use Chrome or Edge for a USB device',
      streaming: 'Streaming needs the playhound app (or start.bat) running on this computer',
    }

/** The modifier key as a keycap: ⌘ on a Mac, Ctrl elsewhere. */
export const MOD_KEY = isMac ? '⌘' : 'Ctrl'

/** "Ctrl + K" → "⌘ + K" on a Mac; unchanged elsewhere. */
export function keyLabel(keys: string): string {
  return isMac ? keys.replace(/\bCtrl\b/g, '⌘') : keys
}
