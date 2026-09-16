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
/** Raw axis values, so "is the stick even being read?" is answerable. */
const axes = ref<number[]>([])
/** Non-standard pads report different axis indices; worth surfacing. */
const mapping = ref('')

export function useGamepadStatus() {
  return { connected, padName, axes, mapping }
}
