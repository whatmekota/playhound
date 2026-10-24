import { useLocalStorage } from '@vueuse/core'
import { onUnmounted, ref } from 'vue'
import { desktop } from '~/lib/browserApi'

export type RemoteAction
  = | 'togglePlay' | 'next' | 'prev' | 'random' | 'panic'
    | 'motionToggle' | 'intensityUp' | 'intensityDown' | 'audioToggle'

export interface RemoteState {
  title: string
  playing: boolean
  panicked: boolean
  motion: boolean
  audio: boolean
  intensity: number
  spm: number
  /** Session phase, so a remote can show what the session is doing. */
  phase: string
}

/** Relay port from es-proxy.mjs. */
export const RC_PORT = 7072

/**
 * Room id, generated and kept by the desktop.
 *
 * Nothing secret ever has to reach the relay out of band: the desktop invents
 * the room, the phone is given it in the pairing URL, and the relay only ever
 * matches peers that already know it.
 */
export const remoteRoom = useLocalStorage('ph:remote.room', () =>
  Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 8)).join(''))

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function remoteUrl(room: string): string {
  // The desktop window always runs on localhost, which a phone cannot open;
  // the desktop shell knows this machine's LAN address, so hand out that.
  const lan = desktop?.lan[0]?.address
  const host = LOOPBACK.has(location.hostname) && lan ? lan : location.hostname
  return `${location.protocol}//${host}:${location.port}/remote?room=${room}`
}

function socketUrl(room: string, role: 'host' | 'remote'): string {
  return `ws://${location.hostname}:${RC_PORT}/rc?room=${encodeURIComponent(room)}&role=${role}`
}

/**
 * Shared connection logic for both ends of the remote.
 *
 * Reconnects with a backoff, because a phone screen locking is the normal case
 * rather than an error.
 */
export function useRemoteLink(
  role: 'host' | 'remote',
  room: () => string,
  onMessage: (msg: any) => void,
) {
  const connected = ref(false)
  const peers = ref({ hosts: 0, remotes: 0 })

  let ws: WebSocket | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let backoff = 500
  let closedByUs = false

  function send(msg: unknown) {
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(msg))
  }

  function connect() {
    disconnect(false)
    closedByUs = false
    try {
      ws = new WebSocket(socketUrl(room(), role))
    }
    catch {
      scheduleRetry()
      return
    }

    ws.onopen = () => {
      connected.value = true
      backoff = 500
    }
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg?.type === 'peers') {
          peers.value = { hosts: msg.hosts ?? 0, remotes: msg.remotes ?? 0 }
          return
        }
        onMessage(msg)
      }
      catch {
        // ignore malformed frames
      }
    }
    ws.onclose = () => {
      connected.value = false
      if (!closedByUs)
        scheduleRetry()
    }
    ws.onerror = () => ws?.close()
  }

  function scheduleRetry() {
    if (retry !== null)
      return
    retry = setTimeout(() => {
      retry = null
      connect()
    }, backoff)
    backoff = Math.min(8000, backoff * 2)
  }

  function disconnect(permanent = true) {
    closedByUs = permanent
    if (retry !== null) {
      clearTimeout(retry)
      retry = null
    }
    ws?.close()
    ws = null
    connected.value = false
  }

  onUnmounted(() => disconnect())

  return { connected, peers, send, connect, disconnect }
}
