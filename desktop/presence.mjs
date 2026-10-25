// Discord Rich Presence, from the main process.
//
// Discord only accepts Rich Presence over its local IPC pipe, which a web page
// cannot reach — so the page decides *what* to show (it knows the session) and
// sends it here, and this file only owns the connection. It is off unless the
// page sends something, connects lazily, retries quietly while Discord is not
// running, and clears the activity on quit.
//
// Only the Application ID is ever needed. Never a bot token: presence goes to
// the Discord client on this machine, not to Discord's servers as a bot.

import { Client } from '@xhayper/discord-rpc'

const RETRY_MS = 30_000
/** Discord's own limit is about 5 updates per 20 s; stay well under it. */
const MIN_GAP_MS = 4_000

/**
 * @param {(status: string, detail?: string) => void} report
 *   Status for the page: 'off' | 'connecting' | 'connected' | 'no-discord' | 'error'.
 */
export function createPresence(report) {
  /** @type {Client | null} */
  let client = null
  let clientId = ''
  /** @type {Record<string, unknown> | null} */
  let wanted = null
  let connected = false
  let connecting = false
  let retryTimer = null
  let sendTimer = null
  let lastSentAt = 0
  let lastSentJson = ''

  function teardown() {
    clearTimeout(retryTimer)
    clearTimeout(sendTimer)
    retryTimer = null
    sendTimer = null
    connected = false
    connecting = false
    lastSentJson = ''
    const c = client
    client = null
    if (c) {
      c.user?.clearActivity().catch(() => {})
      c.destroy().catch(() => {})
    }
  }

  async function connect() {
    if (connecting || connected || !clientId || !wanted)
      return
    connecting = true
    report('connecting')
    const c = new Client({ clientId, transport: { type: 'ipc' } })
    client = c
    c.on('ready', () => {
      if (client !== c)
        return
      connected = true
      connecting = false
      report('connected', c.user?.username ? `as ${c.user.username}` : undefined)
      flush(true)
    })
    c.on('disconnected', () => {
      if (client !== c)
        return
      connected = false
      connecting = false
      lastSentJson = ''
      report('no-discord')
      scheduleRetry()
    })
    try {
      await c.login()
    }
    catch (err) {
      if (client !== c)
        return
      connecting = false
      client = null
      c.destroy().catch(() => {})
      // The usual reason: Discord is not running. Say so and try again later.
      const msg = String(err?.message ?? err)
      report(/ENOENT|ECONNREFUSED|Could not connect|connection/i.test(msg) ? 'no-discord' : 'error', msg)
      scheduleRetry()
    }
  }

  function scheduleRetry() {
    clearTimeout(retryTimer)
    if (!wanted || !clientId)
      return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void connect()
    }, RETRY_MS)
  }

  function flush(force = false) {
    if (!connected || !client?.user)
      return
    const json = JSON.stringify(wanted)
    if (!force && json === lastSentJson)
      return
    const wait = MIN_GAP_MS - (Date.now() - lastSentAt)
    if (wait > 0 && !force) {
      clearTimeout(sendTimer)
      sendTimer = setTimeout(() => flush(), wait)
      return
    }
    lastSentAt = Date.now()
    lastSentJson = json
    const user = client.user
    const done = wanted ? user.setActivity(wanted) : user.clearActivity()
    done.catch(err => report('error', String(err?.message ?? err)))
  }

  return {
    /**
     * Show `activity` (already sanitised) for application `id`, or clear with
     * null. Clearing disconnects entirely, so an off switch really is off.
     */
    set(id, activity) {
      if (!activity || !id) {
        wanted = null
        teardown()
        report('off')
        return
      }
      if (id !== clientId) {
        teardown()
        clientId = id
      }
      wanted = activity
      if (connected)
        flush()
      else
        void connect()
    },
    dispose() {
      wanted = null
      teardown()
    },
  }
}

const TEXT_MAX = 128
const KEY_MAX = 256

function text(v) {
  if (typeof v !== 'string')
    return undefined
  const s = v.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX)
  // Discord rejects one-character fields outright.
  return s.length >= 2 ? s : undefined
}

function key(v) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, KEY_MAX) : undefined
}

function stamp(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined
}

/**
 * The page is ours, but treat what it sends as data anyway: keep only the
 * fields Rich Presence understands, within Discord's limits.
 */
export function sanitiseActivity(a) {
  if (!a || typeof a !== 'object')
    return null
  const out = {
    // Playing (0), Listening to (2) or Watching (3); nothing else makes sense here.
    type: [0, 2, 3].includes(a.type) ? a.type : undefined,
    details: text(a.details),
    state: text(a.state),
    startTimestamp: stamp(a.startTimestamp),
    endTimestamp: stamp(a.endTimestamp),
    largeImageKey: key(a.largeImageKey),
    largeImageText: text(a.largeImageText),
    smallImageKey: key(a.smallImageKey),
    smallImageText: text(a.smallImageText),
    instance: false,
  }
  for (const k of Object.keys(out)) {
    if (out[k] === undefined)
      delete out[k]
  }
  return out
}

/** Application IDs are Discord snowflakes. */
export function validClientId(v) {
  return typeof v === 'string' && /^\d{15,22}$/.test(v)
}
