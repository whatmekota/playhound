import type { PluginListenerHandle } from '@capacitor/core'
import { registerPlugin } from '@capacitor/core'

/**
 * The session service in the Android app (android/…/session/): a foreground
 * service that keeps playback and the devices going with the screen off or
 * another app in front, with a notification that has Panic and Open.
 * composables/useAndroidSession.ts tells it what is connected and playing.
 */

export interface SessionStatus {
  sdk: number
  /** The service is up (its notification showing, if notifications are allowed). */
  running: boolean
  /** The page is being kept running behind it. */
  keepRunning: boolean
  /** The app's own WebView is in place (it is what keeps the page running). */
  webViewKept: boolean
  foreground: boolean
  notifications: boolean
  /** "Unrestricted" in the phone's battery settings. */
  batteryUnrestricted: boolean
  /** Why the service last failed to start, if it did. */
  error: string | null
}

export interface SessionUpdate {
  active: boolean
  playing: boolean
  network: boolean
  title: string
  text: string
}

interface PhSessionPlugin {
  update: (s: SessionUpdate) => Promise<SessionStatus>
  status: () => Promise<SessionStatus>
  requestNotifications: () => Promise<SessionStatus>
  openNotificationSettings: () => Promise<void>
  openBatterySettings: () => Promise<void>
  panicDone: () => Promise<void>
  addListener: ((event: 'panic', cb: (e: { reason: 'notification' | 'closing' }) => void) => Promise<PluginListenerHandle>)
    & ((event: 'appState', cb: (e: { foreground: boolean }) => void) => Promise<PluginListenerHandle>)
}

export const PhSession = registerPlugin<PhSessionPlugin>('PhSession')

/** The Android version, from the WebView's user agent ("Android 14"); 0 when it does not say. */
export function androidMajor(userAgent = globalThis.navigator?.userAgent ?? ''): number {
  return Number(userAgent.match(/Android (\d+)/)?.[1] ?? 0)
}

/** What is going on, as the notification and the service need it. */
export interface SessionInputs {
  /** A video or soundtrack playing. */
  mediaPlaying: boolean
  /** Its name, when one is loaded (playing or paused). */
  mediaName: string | null
  /** Something else making output on its own: binaural audio, e-stim, the motion generator. */
  otherPlaying: boolean
  /** The outputs and inputs connected, in words ("Handy (Bluetooth)"). */
  connected: string[]
  /** One of them is on the network (WiFi Handy, Intiface on the PC, TCode over WiFi). */
  network: boolean
}

/** The file's name without its folders or extension. */
export function mediaTitle(path: string | null | undefined): string | null {
  if (!path)
    return null
  const base = path.split(/[/\\]/).pop() ?? path
  return base.replace(/\.[^.]+$/, '') || base
}

/**
 * The service's state from what is going on. It runs while anything is
 * connected or anything plays; the wake lock is for playing, the Wi-Fi lock
 * for a network device.
 */
export function sessionSummary(i: SessionInputs): SessionUpdate {
  const playing = i.mediaPlaying || i.otherPlaying
  const active = playing || i.connected.length > 0
  const parts: string[] = []
  if (i.mediaName)
    parts.push(i.mediaPlaying ? 'Playing' : 'Paused')
  else if (playing)
    parts.push('Playing')
  parts.push(i.connected.length ? i.connected.join(', ') : 'No device connected')
  return {
    active,
    playing,
    network: active && i.network,
    title: i.mediaName ?? 'playhound',
    text: parts.join(' · '),
  }
}
