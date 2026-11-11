import type { AnyViewId } from '../views'
import { isAndroidApp } from './detect'

/**
 * What the Android app leaves out for now, and why. Each needs something the
 * WebView does not have: yt-dlp, the LAN server, or Electron's web views.
 * They come back as native pieces arrive; until then they are not offered at
 * all, and Settings → Android app lists them. (The EroScripts browser,
 * file-host streaming and saving into library folders are in: the app does
 * what the local proxy does, natively.)
 */
export const ANDROID_LATER: readonly { id: AnyViewId | null, label: string, why: string }[] = [
  { id: 'remote', label: 'Phone remote', why: 'the phone is the player now; hosting a remote needs the LAN server' },
  { id: 'face', label: 'CYD face', why: 'talks through the desktop app\'s relay' },
  { id: null, label: 'Sites that need yt-dlp (Pornhub, XVideos, Hanime1…)', why: 'yt-dlp is a desktop program; Pixeldrain, Gofile, MEGA, Iwara, Rule34Video and PMVHaven stream here' },
  { id: null, label: 'Plugins that open web pages, connect to devices on the network or share the library on it', why: 'desktop app only; the plugin store says so and will not install them' },
]

const hidden = new Set<AnyViewId>(isAndroidApp ? ANDROID_LATER.flatMap(f => (f.id ? [f.id] : [])) : [])

/** Whether a view or panel is offered where playhound runs (everything is, except in the Android app). */
export function offeredHere(id: AnyViewId): boolean {
  return !hidden.has(id)
}
