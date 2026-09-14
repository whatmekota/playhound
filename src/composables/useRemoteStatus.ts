import { ref } from 'vue'

/**
 * Connection state published by useRemoteHost.
 *
 * The host link is a singleton owned by the shell; the panel only needs to read
 * it, and this is transient state rather than something to persist.
 */
const connected = ref(false)
const peers = ref({ hosts: 0, remotes: 0 })

export function useRemoteStatus() {
  return { connected, peers }
}
