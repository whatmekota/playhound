/**
 * useHandy — the Handy over WiFi, through Handy's cloud API (v3).
 *
 * useVideoSync calls follow() every frame with the video's script time, and
 * only a play, a stop, a top-up of points or an occasional clock nudge goes
 * over the network: the device plays the strokes itself, so fast scripts cost
 * nothing extra. Two protocols (see lib/handy.ts):
 *
 * - HSP, the default: the next few seconds of the stroke script are kept in
 *   the device's buffer, shaped by the knob, an edge and the stroke range as
 *   they are sent.
 * - HSSP: the whole shaped script is uploaded to Handy's script hosting and
 *   set up once; a knob change uploads it again, and an edge stops it.
 *
 * The application ID comes from VITE_HANDY_APP_ID at build time (an ID is
 * meant to be shipped in clients); one typed in the panel overrides it. The
 * device is picked by its connection key, from the Handy app.
 *
 * Usage:
 *   const handy = useHandy()
 *   await handy.connect()
 *   handy.follow({ playing, at, rate, hold })   // every frame
 *   handy.halt()                                // pause, end, panic
 */

import type { ComputedRef, EffectScope } from 'vue'
import type { FunscriptAction } from '~/lib/funscriptParser'
import type { HandyAction, HandyCommand, HandyRun, HandyWant, HspCommand, HspRun, TimeSample } from '~/lib/handy'
import { useLocalStorage } from '@vueuse/core'
import { computed, effectScope, ref, watch } from 'vue'
import { clockOffset, HANDY_API, HANDY_HOSTING, handyError, handyFunscript, handyScript, HSP_BATCH, scriptKey, stepHandy, stepHsp } from '~/lib/handy'
import { KEYS } from '~/lib/persist'
import { logCommand } from '~/lib/serialLog'
import { useDeviceStore } from '~/stores/deviceStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'

export type HandyProtocol = 'hsp' | 'hssp'

const ENV_APP_ID = String(import.meta.env.VITE_HANDY_APP_ID ?? '').trim()
const TIME_SAMPLES = 20
/** After a failed command, wait this long before trying again. */
const BACKOFF_MS = 3000
/** The knob and an edge's hold are rounded to this before shaping, so turning them does not reshape per step. */
const SHAPE_STEP = 0.05
/** An edge this deep stops the device under HSSP, which cannot ease off mid-script. */
const HSSP_HOLD_STOP = 0.02

class HandyApiError extends Error {
  constructor(message: string, readonly offline: boolean) {
    super(message)
  }
}

// ─── Shared state ─────────────────────────────────────────────────────────────
const connectionKey = useLocalStorage(KEYS.handyKey.key, '')
const appIdOverride = useLocalStorage(KEYS.handyAppId.key, '')
const enabled = useLocalStorage(KEYS.handyEnabled.key, true)
const protocol = useLocalStorage<HandyProtocol>(KEYS.handyProtocol.key, 'hsp')
/** Script ms added on top of the script's own offset: positive plays the device earlier. */
const offsetMs = useLocalStorage(KEYS.handyOffset.key, 0)

const state = ref<'idle' | 'connecting' | 'connected'>('idle')
const error = ref<string | null>(null)
const info = ref<{ model: string, firmware: string } | null>(null)
/** The stroke script on the device: none to play, being set up, ready, or it could not be set up. */
const script = ref<'none' | 'loading' | 'ready' | 'failed'>('none')
const playing = ref(false)

const appId = computed(() => appIdOverride.value.trim() || ENV_APP_ID)

let csOffset = 0
let run: HandyRun | HspRun | null = null
let backoffUntil = 0
/** Commands go out one at a time, in order; follow() skips frames while one is out. */
let queue: Promise<void> = Promise.resolve()
let pending = 0
let preparedKey: string | null = null
let prepareSeq = 0
const uploads = new Map<string, string>()
/** HSP: a session is set up on the device, and how many points a batch may carry. */
let hspSession = false
let hspBatch = HSP_BATCH
/** HSP: the running count of points sent, which the API wants with every add. */
let streamIndex = 0

interface Base {
  actions: FunscriptAction[]
  min: number
  max: number
  invert: boolean
}
let scope: EffectScope | null = null
let base: ComputedRef<Base | null> | null = null
let shapedCache: { base: Base, key: string, actions: HandyAction[] } | null = null

const clientNow = () => performance.timeOrigin + performance.now()
const step = (v: number) => Math.round(v / SHAPE_STEP) * SHAPE_STEP

async function api(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {
    'X-Connection-Key': connectionKey.value.trim(),
    'X-Api-Key': appId.value,
  }
  if (body !== undefined)
    headers['Content-Type'] = 'application/json'
  const res = await fetch(`${HANDY_API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  const data = await res.json().catch(() => null)
  const err = handyError(data, res.status)
  if (err)
    throw new HandyApiError(err.message, err.offline)
  return data?.result ?? data
}

/** Measure this client's offset to the server clock. */
async function syncClock() {
  const samples: TimeSample[] = []
  for (let i = 0; i < TIME_SAMPLES; i++) {
    const sent = clientNow()
    // A plain GET with no custom headers: no CORS preflight to skew the timing.
    const res = await fetch(`${HANDY_API}/servertime`, { signal: AbortSignal.timeout(5000) })
    const received = clientNow()
    const { server_time } = await res.json()
    if (Number.isFinite(server_time))
      samples.push({ sent, received, server: server_time })
  }
  if (!samples.length)
    throw new Error('Could not read the Handy server clock')
  csOffset = clockOffset(samples)
}

function describe(e: unknown): string {
  if (e instanceof HandyApiError) {
    if (e.offline)
      return 'The Handy went offline. Check it is on and connected to WiFi.'
    if (/unauthenticated/i.test(e.message))
      return 'Handy rejected the application ID.'
    if (/invalid connection key/i.test(e.message))
      return 'That connection key is not valid. Copy it again from the Handy app.'
    return e.message
  }
  if (e instanceof DOMException && e.name === 'TimeoutError')
    return 'Handy\'s server did not answer in time.'
  if (e instanceof TypeError)
    return 'Could not reach Handy\'s server. Check the internet connection, or set a proxy in Settings → Network.'
  return (e as Error)?.message ?? String(e)
}

type AnyCommand = HandyCommand | HspCommand

function enqueue(cmd: AnyCommand, proto: HandyProtocol = protocol.value) {
  pending++
  queue = queue
    .then(() => send(cmd, proto))
    .catch((e) => {
      error.value = describe(e)
      backoffUntil = clientNow() + BACKOFF_MS
      // A play that failed did not start, and points that did not arrive leave
      // a hole: either way, start over with a fresh play after the backoff.
      if (cmd.kind === 'play' || cmd.kind === 'add') {
        run = null
        playing.value = false
      }
      if (e instanceof HandyApiError && e.offline)
        info.value = null
    })
    .finally(() => {
      pending--
    })
}

const serverNow = () => Math.round(clientNow() + csOffset)
const toPoints = (points: HandyAction[]) => points.map(p => ({ t: p.at, x: p.pos }))

async function send(cmd: AnyCommand, proto: HandyProtocol) {
  const p = `/${proto}`
  switch (cmd.kind) {
    case 'play': {
      const body: Record<string, unknown> = { start_time: Math.round(cmd.at), server_time: serverNow(), playback_rate: cmd.rate }
      if ('points' in cmd && cmd.points.length) {
        streamIndex += cmd.points.length
        body.pause_on_starving = false
        body.add = { points: toPoints(cmd.points), flush: true, tail_point_stream_index: streamIndex }
      }
      logCommand(`[Handy] ${proto} play at=${body.start_time}ms rate=${cmd.rate}${'points' in cmd ? ` +${cmd.points.length} points` : ''}`)
      playing.value = true
      await api('PUT', `${p}/play`, body)
      error.value = null
      break
    }
    case 'add':
      streamIndex += cmd.points.length
      await api('PUT', '/hsp/add', { points: toPoints(cmd.points), tail_point_stream_index: streamIndex })
      break
    case 'stop':
      logCommand(`[Handy] ${proto} stop`)
      playing.value = false
      await api('PUT', `${p}/stop`)
      break
    case 'synctime':
      await api('PUT', `${p}/synctime`, { current_time: Math.round(cmd.at), server_time: serverNow() })
      break
  }
}

async function upload(text: string, key: string): Promise<string> {
  const hit = uploads.get(key)
  if (hit)
    return hit
  const form = new FormData()
  form.append('file', new Blob([text], { type: 'application/json' }), 'playhound.funscript')
  const res = await fetch(`${HANDY_HOSTING}/upload`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) })
  const data = await res.json().catch(() => null)
  if (!res.ok || typeof data?.url !== 'string')
    throw new Error(handyError(data, res.status || 500)?.message ?? 'Could not upload the script to Handy')
  uploads.set(key, data.url)
  return data.url
}

/**
 * HSSP: put `text` on the device, unless it is already there. Setting up
 * stops any play, so the next frame starts it again from wherever the video is.
 */
async function prepareHssp(text: string | null) {
  const seq = ++prepareSeq
  if (text === null) {
    preparedKey = null
    script.value = 'none'
    halt()
    return
  }
  const key = scriptKey(text)
  if (key === preparedKey && script.value === 'ready')
    return
  script.value = 'loading'
  run = null
  playing.value = false
  try {
    const url = await upload(text, key)
    // A play or stop still on its way must not land after the new setup.
    await queue
    if (seq !== prepareSeq)
      return
    logCommand('[Handy] hssp setup')
    await api('PUT', '/hssp/setup', { url })
    if (seq !== prepareSeq)
      return
    preparedKey = key
    script.value = 'ready'
    error.value = null
  }
  catch (e) {
    if (seq !== prepareSeq)
      return
    preparedKey = null
    script.value = 'failed'
    error.value = describe(e)
  }
}

/**
 * HSP: a session on the device, once per connection. The points themselves
 * go with each play, so a new script only needs the next play to start over.
 */
async function prepareHsp(has: boolean) {
  const seq = ++prepareSeq
  run = null
  if (!has) {
    script.value = 'none'
    halt()
    return
  }
  if (hspSession) {
    script.value = 'ready'
    return
  }
  script.value = 'loading'
  playing.value = false
  try {
    await queue
    if (seq !== prepareSeq)
      return
    logCommand('[Handy] hsp setup')
    const st = await api('PUT', '/hsp/setup', {})
    if (seq !== prepareSeq)
      return
    const max = Number(st?.max_points)
    // Half the buffer at most, so a top-up never pushes out points still to play.
    hspBatch = Number.isFinite(max) && max > 0 ? Math.max(2, Math.min(HSP_BATCH, Math.floor(max / 2))) : HSP_BATCH
    streamIndex = 0
    hspSession = true
    script.value = 'ready'
    error.value = null
  }
  catch (e) {
    if (seq !== prepareSeq)
      return
    script.value = 'failed'
    error.value = describe(e)
  }
}

/** Stop the device if it is playing (or about to). */
function halt(proto: HandyProtocol = protocol.value) {
  if (state.value !== 'connected' || (!run && !pending && !playing.value))
    return
  run = null
  enqueue({ kind: 'stop' }, proto)
}

/** The script shaped for the knob and hold as they stand, rebuilt only when either moves a step. */
function shapedNow(b: Base, knob: number, hold: number): { shape: string, actions: HandyAction[] } {
  const key = `${step(knob).toFixed(2)}|${step(hold).toFixed(2)}`
  if (shapedCache?.base !== b || shapedCache.key !== key) {
    shapedCache = {
      base: b,
      key,
      actions: handyScript(b.actions, { knob: step(knob), hold: step(hold), min: b.min, max: b.max, invert: b.invert }),
    }
  }
  return { shape: key, actions: shapedCache.actions }
}

export function useHandy() {
  const scripts = useScriptStore()
  const device = useDeviceStore()
  const control = useSessionControlStore()

  // Once per app: keep the device's script in step with the loaded one.
  if (!scope) {
    scope = effectScope(true)
    scope.run(() => {
      base = computed(() => {
        const s = scripts.activeScripts.find(x => x.channel === 'L0')
        if (!s || !s.parsed.actions.length)
          return null
        const axis = device.axisConfigs.L0
        return { actions: s.parsed.actions, min: axis?.min ?? 0, max: axis?.max ?? 1, invert: axis?.invert ?? false }
      })
      /** HSSP: the whole shaped script as uploaded. */
      const hsspText = computed(() => {
        const b = base!.value
        if (!b || protocol.value !== 'hssp')
          return null
        return handyFunscript(handyScript(b.actions, { knob: step(control.intensityScale), min: b.min, max: b.max, invert: b.invert }))
      })

      let timer: ReturnType<typeof setTimeout> | undefined
      watch([hsspText, base, state, protocol], ([text, b, st, proto]) => {
        clearTimeout(timer)
        if (st !== 'connected')
          return
        if (proto === 'hsp') {
          void prepareHsp(!!b)
          return
        }
        // A knob turned step by step or a range dragged settles first.
        timer = setTimeout(() => void prepareHssp(text), script.value === 'ready' || script.value === 'loading' ? 800 : 0)
      }, { immediate: true })

      // Switching protocol stops what the old one was playing.
      watch(protocol, (_now, was) => {
        if (state.value === 'connected')
          halt(was)
        run = null
        preparedKey = null
        script.value = 'none'
      }, { flush: 'sync' })
    })
  }

  async function connect() {
    error.value = null
    if (!connectionKey.value.trim()) {
      error.value = 'Enter the connection key from the Handy app first.'
      return
    }
    if (!appId.value) {
      error.value = 'This build has no Handy application ID. Add one under Advanced.'
      return
    }
    state.value = 'connecting'
    try {
      const { connected } = await api('GET', '/connected')
      if (!connected)
        throw new Error('The Handy is not online. Turn it on and connect it to WiFi in the Handy app, then try again.')
      const i = await api('GET', '/info')
      if (i?.fw_status === 2)
        throw new Error(`The Handy needs a firmware update (it has ${i.fw_version ?? 'an old version'}; WiFi control needs v4).`)
      info.value = { model: String(i?.hw_model_name ?? 'Handy'), firmware: String(i?.fw_version ?? '') }
      await syncClock()
      run = null
      playing.value = false
      backoffUntil = 0
      preparedKey = null
      hspSession = false
      state.value = 'connected'
    }
    catch (e) {
      state.value = 'idle'
      info.value = null
      error.value = describe(e)
    }
  }

  async function disconnect() {
    halt()
    await queue
    prepareSeq++
    state.value = 'idle'
    info.value = null
    script.value = 'none'
    preparedKey = null
    hspSession = false
    run = null
    playing.value = false
  }

  /**
   * Called every frame while a video plays; sends only when something
   * changed. `hold` is the edge's (0–1).
   */
  function follow(want: HandyWant & { hold: number }) {
    if (state.value !== 'connected' || script.value !== 'ready' || pending)
      return
    const now = clientNow()
    if (now < backoffUntil)
      return
    const at = want.at + offsetMs.value
    let next: { cmd: AnyCommand | null, run: HandyRun | HspRun | null }
    if (protocol.value === 'hssp') {
      next = stepHandy(run, { playing: want.playing && enabled.value && want.hold < HSSP_HOLD_STOP, at, rate: want.rate }, now)
    }
    else {
      const b = base?.value
      if (!b)
        return
      next = stepHsp(run as HspRun | null, { playing: want.playing && enabled.value, at, rate: want.rate }, now, shapedNow(b, control.intensityScale, want.hold), hspBatch)
    }
    run = next.run
    if (next.cmd)
      enqueue(next.cmd)
  }

  function setEnabled(v: boolean) {
    enabled.value = v
    if (!v)
      halt()
  }

  return {
    connectionKey,
    appIdOverride,
    hasBuiltInAppId: !!ENV_APP_ID,
    enabled,
    protocol,
    offsetMs,
    state,
    connected: computed(() => state.value === 'connected'),
    error,
    info,
    script,
    playing,
    connect,
    disconnect,
    follow,
    halt,
    setEnabled,
  }
}
