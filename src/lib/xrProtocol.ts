import type { VrEye, VrLayout } from './vrFormat'

/**
 * What the headset page (pages/xr.vue) and the desktop window
 * (composables/useXrHost.ts) say to each other, over the desktop's HTTPS
 * server (desktop/xr.mjs, /xr/ws). JSON, one message at a time.
 *
 * The headset plays the video; the desktop follows it, playing the video's
 * scripts on the device to the headset's clock (playExternal), so the
 * device, its latency, the knob, edges and panic all stay on the computer.
 */

/** How a video shows in the headset. */
export interface XrView {
  /** A VR video (else a flat one, on a screen in front). */
  on: boolean
  layout: VrLayout
  /** An id from VR_FORMATS: projection and field of view. */
  format: string
  /** The eye shown when only one is (a flat preview). */
  eye: VrEye
}

/** A video the headset can play. */
export interface XrVideo {
  /** What the headset asks for it by, and its address: /xr/media/<id>. */
  id: string
  title: string
  /** Seconds, when known. */
  duration: number | null
  scripted: boolean
  /** Scripts for more than the stroke. */
  multi: boolean
  starred: boolean
  view: XrView
}

/** The desktop's side, for the panel in VR. */
export interface XrDeskState {
  /** The intensity knob, 0.1–2. */
  knob: number
  /** An edge's phase ('idle' when none); edges off: null. */
  edge: 'idle' | 'falling' | 'holding' | 'rebuilding' | null
  panicked: boolean
  /** Scripts loaded for what plays, and a device (or the emulator) to play them on. */
  scripts: number
  device: boolean
}

export type HeadsetMessage
  = | { type: 'hello' }
    | { type: 'play', id: string }
    /** Where the video is, a few times a second and on every change. */
    | { type: 'clock', time: number, playing: boolean, rate?: number, duration?: number }
    | { type: 'stop' }
    /** Thumbnails for these ids, as they scroll into view. */
    | { type: 'thumbs', ids: string[] }
    | { type: 'action', action: 'knobUp' | 'knobDown' | 'edge' | 'panic' }

export type DeskMessage
  = | { type: 'library', videos: XrVideo[] }
    | { type: 'thumb', id: string, data: string }
    /** The desktop follows this one now. */
    | { type: 'playing', id: string, scripts: number }
    | { type: 'refused', id: string, reason: string }
    /** playhound's own controls, for the video in the headset. */
    | { type: 'command', command: { type: 'play' } | { type: 'pause' } | { type: 'seek', time: number } | { type: 'rate', rate: number } }
    | { type: 'state', state: XrDeskState }
    /** The desktop stopped following (another video took over, or the user stopped it). */
    | { type: 'ended', reason: string }

/** The media address of a video, on the headset's side. */
export function mediaUrl(id: string): string {
  return `/xr/media/${encodeURIComponent(id)}`
}
