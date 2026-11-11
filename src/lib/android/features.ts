import type { AnyViewId } from '../views'
import { isAndroidApp } from './detect'

/**
 * What the Android app leaves out for now, and why. Each needs something the
 * WebView does not have: the local proxy (es-proxy.mjs) and yt-dlp, the LAN
 * server, writing into library folders, or Electron's web views. They come
 * back as native pieces arrive; until then they are not offered at all, and
 * Settings → Android app lists them.
 */
export const ANDROID_LATER: readonly { id: AnyViewId | null, label: string, why: string }[] = [
  { id: 'eroscripts', label: 'EroScripts browser', why: 'needs the local proxy; native HTTP will replace it' },
  { id: 'organizer', label: 'Organizer', why: 'renames files, and library folders are read-only here so far' },
  { id: 'remote', label: 'Phone remote', why: 'the phone is the player now; hosting a remote needs the LAN server' },
  { id: 'face', label: 'CYD face', why: 'talks through the desktop app\'s relay' },
  { id: null, label: 'Streaming from file hosts and yt-dlp sites', why: 'needs the local proxy and yt-dlp' },
  { id: null, label: 'Bluetooth: the Handy over Bluetooth, heart-rate monitors', why: 'the WebView has no Web Bluetooth; a native BLE plugin is next' },
  { id: null, label: 'USB serial (OSR over USB OTG)', why: 'the WebView has no Web Serial; a native USB plugin is next' },
  { id: null, label: 'Plugins with web views, the LAN server for plugins', why: 'desktop app only' },
  { id: null, label: 'Saving scripts and downloads into library folders', why: 'read-only for now; "Save as" still works' },
]

const hidden = new Set<AnyViewId>(isAndroidApp ? ANDROID_LATER.flatMap(f => (f.id ? [f.id] : [])) : [])

/** Whether a view or panel is offered where playhound runs (everything is, except in the Android app). */
export function offeredHere(id: AnyViewId): boolean {
  return !hidden.has(id)
}
