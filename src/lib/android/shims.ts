import { createBluetooth } from './ble'
import { createSerial } from './serial'

/**
 * The Android app's stand-ins for Web Bluetooth and Web Serial, put on
 * navigator before the app loads (main.ts), so the code that checks for
 * them at import time (handyBle, useHeartRate, browserApi's webSerial)
 * finds them and works as it does in a browser. Only in the Android app.
 */
export function installNativeShims() {
  const nav = navigator as unknown as Record<string, unknown>
  for (const [name, make] of [['bluetooth', createBluetooth], ['serial', createSerial]] as const) {
    if (nav[name])
      continue
    try {
      Object.defineProperty(navigator, name, { value: make(), configurable: true, enumerable: true })
    }
    catch (err) {
      console.error(`[android] navigator.${name}`, err)
    }
  }
}
