import { useLocalStorage } from '@vueuse/core'

/**
 * Whether the desktop is listening for a phone remote.
 *
 * Lives here rather than in composables/ because that directory is scanned for
 * auto-imports, and the scanner mis-reads a default argument in an exported
 * `useLocalStorage` call as an export name of its own.
 */
export const remoteEnabled = useLocalStorage('ph:remote.enabled', false)

/** Whether a connected phone may drive the stroke with its stroke pad. */
export const remotePad = useLocalStorage('ph:remote.pad', true)
