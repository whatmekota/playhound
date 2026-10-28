import type { FaceMessage } from '~/lib/faceState'
import type { KerfusColor } from '~/lib/kerfus'
import { useLocalStorage } from '@vueuse/core'
import { ref } from 'vue'
import { KEYS } from '~/lib/persist'

/**
 * The face on a screen: a window of its own (/face) that can sit on a second
 * monitor, showing the Kerfus face.
 *
 * It hears the session over a BroadcastChannel rather than the remote relay,
 * so it needs nothing switched on: the main window publishes the same frame it
 * would send the CYD, ten times a second, but only while a face window has
 * pinged recently.
 */

export const FACE_CHANNEL = 'playhound-face'

/** A window that has not pinged for this long is gone (closed, or crashed). */
const SCREEN_ALIVE_MS = 5000
export const SCREEN_PING_MS = 2000

export type FaceScreenMsg
  = | { type: 'hello' | 'ping' | 'bye' | 'close' }
    | { type: 'frame', msg: FaceMessage, edging: boolean }

export interface FaceScreenSettings {
  color: KerfusColor
  /** Draw it as a dot-matrix screen. */
  led: boolean
}

let settings: ReturnType<typeof useLocalStorage<FaceScreenSettings>> | null = null

/** Shared with the face window through localStorage, so a change shows there at once. */
export function faceScreenSettings() {
  settings ??= useLocalStorage<FaceScreenSettings>(KEYS.faceScreen.key, { color: 'blue', led: true }, { mergeDefaults: true })
  return settings
}

// ── Main window side ─────────────────────────────────────────────────────────

const screenSeenAt = ref(0)
let channel: BroadcastChannel | null = null

/** Listen for face windows. Called once by the face link. */
export function hostFaceScreens(onHello: () => void) {
  if (channel || typeof BroadcastChannel === 'undefined')
    return
  channel = new BroadcastChannel(FACE_CHANNEL)
  channel.onmessage = (e: MessageEvent<FaceScreenMsg>) => {
    const t = e.data?.type
    if (t === 'hello' || t === 'ping') {
      screenSeenAt.value = performance.now()
      if (t === 'hello')
        onHello()
    }
    else if (t === 'bye') {
      screenSeenAt.value = 0
    }
  }
}

/** Whether a face window is open, as of `now` (performance.now()). */
export function faceScreenOpen(now: number) {
  return screenSeenAt.value > 0 && now - screenSeenAt.value < SCREEN_ALIVE_MS
}

export function publishFaceFrame(msg: FaceMessage, edging: boolean) {
  channel?.postMessage({ type: 'frame', msg, edging } satisfies FaceScreenMsg)
}

/** Ask any open face window to close itself. */
export function closeFaceWindow() {
  channel?.postMessage({ type: 'close' } satisfies FaceScreenMsg)
  screenSeenAt.value = 0
}

/**
 * Open the face window. The desktop app puts it full screen on a second
 * display when there is one; a browser opens a popup to drag there.
 *
 * `noopener` matters: a popup that can reach its opener shares its renderer
 * process, and a face drawn full screen on a second monitor then competes
 * with the player for the same thread. Without the opener it gets a process
 * of its own, and the BroadcastChannel reaches it all the same.
 */
export function openFaceWindow() {
  const url = new URL(`${import.meta.env.BASE_URL}face`, location.href).href
  window.open(url, 'playhound-face', 'popup,noopener,width=960,height=600')
}
