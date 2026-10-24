import { ref, shallowRef } from 'vue'

/**
 * Connection state published by useRemoteHost.
 *
 * The host link is a singleton owned by the shell; the panel only needs to read
 * it, and this is transient state rather than something to persist.
 */
const connected = ref(false)
const peers = ref({ hosts: 0, remotes: 0 })

/**
 * The host link's socket, shared. The CYD face is just another remote in the
 * same room, so the face link publishes over this rather than opening a second
 * host connection (which the relay would count, and every remote would see, as
 * a second desktop). Null until the host link exists.
 */
const send = shallowRef<((msg: unknown) => void) | null>(null)

type Listener = (msg: any) => void
const listeners = new Set<Listener>()

/** Hear every frame the host link receives (except the relay's own `peers`). */
function onMessage(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(msg: any) {
  for (const fn of listeners) {
    try {
      fn(msg)
    }
    catch (e) {
      console.warn('[remote] listener failed', e)
    }
  }
}

export function useRemoteStatus() {
  return { connected, peers, send, onMessage, emit }
}
