/**
 * useHandy — the Handy over WiFi, through Handy's cloud API (v3).
 *
 * The stroke script is uploaded to Handy's script hosting, shaped by the knob
 * and the stroke axis range (see lib/handy.ts), and the device is set up to
 * play it (HSSP). From then on useVideoSync calls follow() every frame with
 * the video's script time, and only a play, a stop or an occasional clock
 * nudge goes over the network: the device plays the strokes itself, so fast
 * scripts cost nothing extra.
 *
 * The application ID comes from VITE_HANDY_APP_ID at build time (an ID is
 * meant to be shipped in clients); one typed in the panel overrides it. The
 * device is picked by its connection key, from the Handy app.
 *
 * Usage:
 *   const handy = useHandy()
 *   await handy.connect()
 *   handy.follow({ playing, at, rate })   // every frame
 *   handy.halt()                          // pause, end, panic
 */

import type { EffectScope } from 'vue'
import type { HandyCommand, HandyRun, HandyWant, TimeSample } from '~/lib/handy'
import { useLocalStorage } from '@vueuse/core'
import { computed, effectScope, ref, watch } from 'vue'
import { clockOffset, HANDY_API, HANDY_HOSTING, handyError, handyFunscript, handyScript, scriptKey, stepHandy } from '~/lib/handy'
import { KEYS } from '~/lib/persist'
import { logCommand } from '~/lib/serialLog'
import { useDeviceStore } from '~/stores/deviceStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'

const ENV_APP_ID = String(import.meta.env.VITE_HANDY_APP_ID ?? '').trim()
const TIME_SAMPLES = 20
/** After a failed command, wait this long before trying again. */
const BACKOFF_MS = 3000
/** The knob is rounded to this before shaping the script, so turning it does not upload a script per step. */
const KNOB_STEP = 0.05

class HandyApiError extends Error {
  constructor(message: string, readonly offline: boolean) {
    super(message)
  }
}

// ─── Shared state ─────────────────────────────────────────────────────────────
const connectionKey = useLocalStorage(KEYS.handyKey.key, '')
const appIdOverride = useLocalStorage(KEYS.handyAppId.key, '')
const enabled = useLocalStorage(KEYS.handyEnabled.key, true)
/** Script ms added on top of the script's own offset: positive plays the device earlier. */
const offsetMs = useLocalStorage(KEYS.handyOffset.key, 0)

const state = ref<'idle' | 'connecting' | 'connected'>('idle')
const error = ref<string | null>(null)
const info = ref<{ model: string, firmware: string } | null>(null)
/** The stroke script on the device: none to play, uploading, ready, or it could not be set up. */
const script = ref<'none' | 'loading' | 'ready' | 'failed'>('none')
const playing = ref(false)

const appId = computed(() => appIdOverride.value.trim() || ENV_APP_ID)

let csOffset = 0
let run: HandyRun | null = null
let backoffUntil = 0
/** Commands go out one at a time, in order; follow() skips frames while one is out. */
let queue: Promise<void> = Promise.resolve()
let pending = 0
let preparedKey: string | null = null
let prepareSeq = 0
const uploads = new Map<string, string>()
let scope: EffectScope | null = null

const clientNow = () => performance.timeOrigin + performance.now()

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

function enqueue(cmd: HandyCommand) {
  pending++
  queue = queue
    .then(() => send(cmd))
    .catch((e) => {
      error.value = describe(e)
      backoffUntil = clientNow() + BACKOFF_MS
      // A play that failed did not start: try again after the backoff.
      if (cmd.kind === 'play') {
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

async function send(cmd: HandyCommand) {
  switch (cmd.kind) {
    case 'play': {
      const body = { start_time: Math.round(cmd.at), server_time: Math.round(clientNow() + csOffset), playback_rate: cmd.rate }
      logCommand(`[Handy] play at=${body.start_time}ms rate=${cmd.rate}`)
      playing.value = true
      await api('PUT', '/hssp/play', body)
      error.value = null
      break
    }
    case 'stop':
      logCommand('[Handy] stop')
      playing.value = false
      await api('PUT', '/hssp/stop')
      break
    case 'synctime':
      await api('PUT', '/hssp/synctime', { current_time: Math.round(cmd.at), server_time: Math.round(clientNow() + csOffset) })
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
 * Put `text` on the device, unless it is already there. Setting up stops any
 * play, so the next frame starts it again from wherever the video is.
 */
async function prepare(text: string | null) {
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
    logCommand('[Handy] setup script')
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

/** Stop the device if it is playing (or about to). */
function halt() {
  if (state.value !== 'connected' || (!run && !pending && !playing.value))
    return
  run = null
  enqueue({ kind: 'stop' })
}

export function useHandy() {
  const scripts = useScriptStore()
  const device = useDeviceStore()
  const control = useSessionControlStore()

  /** The stroke script as the device should get it, or null when there is none. */
  const wanted = computed(() => {
    const s = scripts.activeScripts.find(x => x.channel === 'L0')
    if (!s || !s.parsed.actions.length)
      return null
    const axis = device.axisConfigs.L0
    const knob = Math.round(control.intensityScale / KNOB_STEP) * KNOB_STEP
    return handyFunscript(handyScript(s.parsed.actions, {
      knob,
      min: axis?.min ?? 0,
      max: axis?.max ?? 1,
      invert: axis?.invert ?? false,
    }))
  })

  // Once per app: keep the device's script in step with the loaded one.
  if (!scope) {
    scope = effectScope(true)
    scope.run(() => {
      let timer: ReturnType<typeof setTimeout> | undefined
      watch([wanted, state], ([text, st]) => {
        clearTimeout(timer)
        if (st !== 'connected')
          return
        // A knob turned step by step or a range dragged settles first.
        timer = setTimeout(() => void prepare(text), script.value === 'ready' || script.value === 'loading' ? 800 : 0)
      }, { immediate: true })
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
    run = null
    playing.value = false
  }

  /** Called every frame while a video plays; sends only when something changed. */
  function follow(want: HandyWant) {
    if (state.value !== 'connected' || script.value !== 'ready' || pending)
      return
    const now = clientNow()
    if (now < backoffUntil)
      return
    const { cmd, run: next } = stepHandy(run, {
      playing: want.playing && enabled.value,
      at: want.at + offsetMs.value,
      rate: want.rate,
    }, now)
    run = next
    if (cmd)
      enqueue(cmd)
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
