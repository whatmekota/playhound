import { ref } from 'vue'

/**
 * Connection state published by useGamepad.
 *
 * The polling loop is a singleton owned by the shell; panels only need to read
 * whether a pad is there, so the state lives here rather than in the store —
 * it is transient, not persisted.
 */
const connected = ref(false)
const padName = ref('')

export function useGamepadStatus() {
  return { connected, padName }
}
