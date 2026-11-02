import type { FunscriptAction } from './funscriptParser'
import { intensityParams, scaleScript } from './scriptScale'

/**
 * The Handy over WiFi, through Handy's own cloud API (v3).
 *
 * Over Bluetooth the player streams every stroke as it plays, and fast
 * scripts choke the link. Over WiFi the device is given the whole script up
 * front (HSSP, the synchronised script protocol) and plays it itself; the
 * player only says "play from script time T at server time S", stop, and
 * the odd clock nudge. Client and device agree on time through the server's
 * clock, so the only per-session measurement is this client's offset to it.
 *
 * The pure parts live here: the script as the device should get it, the
 * clock offset, and what to tell the device on each frame. useHandy does the
 * talking.
 */

export const HANDY_API = 'https://www.handyfeeling.com/api/handy-rest/v3'
export const HANDY_HOSTING = 'https://www.handyfeeling.com/api/hosting/v2'
/** Where a device with firmware older than v4 is sent to update. */
export const HANDY_OTA_URL = 'https://handyverse.com/#/ota'

export interface HandyAction {
  at: number
  /** 0–100, the device's own scale. */
  pos: number
}

export interface HandyShape {
  /** The intensity knob, 0.1–1: scripts are compressed and slowed by it. */
  knob: number
  /** The stroke axis range and direction, as for every other device. */
  min: number
  max: number
  invert: boolean
}

/**
 * The stroke script as the device should play it. Everything the player
 * would otherwise apply per frame is baked in, since the device plays on its
 * own: the knob, then the stroke range and direction. Positions are whole
 * percent; two actions at the same millisecond keep the later one.
 */
export function handyScript(actions: readonly FunscriptAction[], shape: HandyShape): HandyAction[] {
  if (!actions.length)
    return []
  const scaled = scaleScript(actions, intensityParams(shape.knob)).actions
  const lo = Math.max(0, Math.min(1, shape.min))
  const hi = Math.max(lo, Math.min(1, shape.max))
  const out: HandyAction[] = []
  for (const a of scaled) {
    let p = lo + a.pos * (hi - lo)
    if (shape.invert)
      p = lo + hi - p
    const action = { at: Math.max(0, Math.round(a.at)), pos: Math.round(Math.max(0, Math.min(1, p)) * 100) }
    if (out.length && out[out.length - 1].at === action.at)
      out[out.length - 1] = action
    else
      out.push(action)
  }
  return out
}

/** The script file uploaded to Handy's hosting, which converts it for the device. */
export function handyFunscript(actions: HandyAction[]): string {
  return JSON.stringify({ version: '1.0', inverted: false, range: 100, actions })
}

/** A short content key, so an unchanged script is not uploaded and set up again. */
export function scriptKey(text: string): string {
  let h = 0x811C9DC5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(36)}-${text.length}`
}

export interface TimeSample {
  /** Client clock when the request went out, and when the answer came back (ms). */
  sent: number
  received: number
  /** The server's clock in the answer (ms). */
  server: number
}

/**
 * Client-to-server clock offset (server ≈ client + offset), as Handy's docs
 * describe it: each answer is taken to be half a round trip old, and the
 * offsets are averaged. The slowest fifth of the round trips are dropped
 * first, since a request stuck in a queue skews its sample the most.
 */
export function clockOffset(samples: readonly TimeSample[]): number {
  if (!samples.length)
    return 0
  const byRtd = [...samples].sort((a, b) => (a.received - a.sent) - (b.received - b.sent))
  const kept = byRtd.slice(0, Math.max(1, Math.ceil(byRtd.length * 0.8)))
  let sum = 0
  for (const s of kept)
    sum += s.server + (s.received - s.sent) / 2 - s.received
  return sum / kept.length
}

/**
 * The message in a failed answer. The API answers in two shapes: a device
 * error under `error`, and a plain `{ name, message }` for a bad request.
 */
export function handyError(body: unknown, status: number): { message: string, offline: boolean } | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>
  const e = b.error && typeof b.error === 'object' ? b.error : null
  if (e)
    return { message: String(e.message ?? e.name ?? 'Handy error'), offline: e.connected === false }
  if (status >= 400)
    return { message: String(b.message ?? b.name ?? `Handy API error ${status}`), offline: false }
  return null
}

// ─── Following the video ──────────────────────────────────────────────────────

/** What the player wants the device doing on this frame. */
export interface HandyWant {
  playing: boolean
  /** Script time, ms. */
  at: number
  rate: number
}

/** A play the device was told to do, to tell how far along it should be. */
export interface HandyRun {
  /** Script time at `sentAt`. */
  at: number
  /** Client clock when the play went out. */
  sentAt: number
  rate: number
  /** Sync nudges sent since, and when the next is due. */
  syncs: number
  nextSync: number
}

export type HandyCommand
  = | { kind: 'play', at: number, rate: number }
    | { kind: 'stop' }
    | { kind: 'synctime', at: number }

/** Further apart than this, the device is told to play from the new place (a seek). */
export const HANDY_DRIFT_MS = 250
/** Sync nudges: every 2 s at first, then every 10 s, as Handy's docs suggest. */
export const HANDY_SYNC_EARLY_MS = 2000
export const HANDY_SYNC_LATE_MS = 10_000
const EARLY_SYNCS = 5

/**
 * What to send the device on this frame, if anything. A play goes out on
 * starting, after a seek (the video is somewhere the running play is not)
 * and when the speed changes; a stop when the player stops wanting play;
 * and in between, now and then, the video's time so the device can ease
 * itself back into step.
 */
export function stepHandy(run: HandyRun | null, want: HandyWant, now: number): { cmd: HandyCommand | null, run: HandyRun | null } {
  if (!want.playing)
    return run ? { cmd: { kind: 'stop' }, run: null } : { cmd: null, run: null }

  const at = Math.max(0, want.at)
  const rate = want.rate > 0 ? want.rate : 1
  const play = () => ({
    cmd: { kind: 'play' as const, at, rate },
    run: { at, sentAt: now, rate, syncs: 0, nextSync: now + HANDY_SYNC_EARLY_MS },
  })
  if (!run || Math.abs(run.rate - rate) > 1e-3)
    return play()
  const expected = run.at + (now - run.sentAt) * run.rate
  if (Math.abs(expected - at) > HANDY_DRIFT_MS)
    return play()
  if (now >= run.nextSync) {
    const syncs = run.syncs + 1
    return {
      cmd: { kind: 'synctime', at },
      run: { ...run, syncs, nextSync: now + (syncs < EARLY_SYNCS ? HANDY_SYNC_EARLY_MS : HANDY_SYNC_LATE_MS) },
    }
  }
  return { cmd: null, run }
}
