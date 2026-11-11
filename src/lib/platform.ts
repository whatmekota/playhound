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
 * Serial; the app will reach both through native plugins later.
 */
export const MISSING = isAndroidApp
  ? {
      bluetooth: 'Bluetooth is coming to the Android app. Until then the Handy works over WiFi.',
      bluetoothShort: 'Coming to the Android app',
      heartRate: 'Heart-rate monitors (Bluetooth) are coming to the Android app.',
      serial: 'USB devices (OSR over USB OTG) are coming to the Android app. Use TCode over the network, or the Handy over WiFi.',
      serialShort: 'USB is coming to the Android app',
      streaming: 'This site needs yt-dlp, which only runs in the desktop app.',
    }
  : {
      bluetooth: 'This browser has no Web Bluetooth. Use Chrome, Edge or the desktop app.',
      bluetoothShort: 'Use Chrome, Edge or the desktop app',
      heartRate: 'This browser has no Web Bluetooth. Use Chrome, Edge or the desktop app.',
      serial: 'This browser cannot talk to USB serial devices. Open playhound in Chrome or Edge, or use the network or Intiface.',
      serialShort: 'Use Chrome or Edge for a USB device',
      streaming: 'Streaming needs the playhound app (or start.bat) running on this computer',
    }

/**
 * A screen with no mouse and no keyboard to speak of (a phone, a tablet):
 * no hover, a coarse pointer. Hints then say "tap", and keyboard shortcuts
 * are left out of them.
 */
export const isTouchOnly: boolean = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches

/** The modifier key as a keycap: ⌘ on a Mac, Ctrl elsewhere. */
export const MOD_KEY = isMac ? '⌘' : 'Ctrl'

/** "Ctrl + K" → "⌘ + K" on a Mac; unchanged elsewhere. */
export function keyLabel(keys: string): string {
  return isMac ? keys.replace(/\bCtrl\b/g, '⌘') : keys
}
