import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'

/**
 * Panic: one action that stops everything and covers the screen, and can put it
 * all back.
 *
 * Deliberately a store rather than a composable so any component can trigger it
 * and the cover can live at the top of the shell. What it suspends is recorded
 * on the way in so resuming restores exactly what was running, rather than
 * blanket-enabling things the user had switched off.
 */
export const useSafetyStore = defineStore('safety', () => {
  const panicked = ref(false)

  /** Also panic when the window loses focus. Off by default; some people want it. */
  const panicOnBlur = useLocalStorage('ph:safety.panicOnBlur', false)

  /** Stop the device automatically after this long with no input. 0 disables. */
  const idleStopMinutes = useLocalStorage('ph:safety.idleStopMinutes', 0)

  /** What was running when panic fired, so resume can be faithful. */
  const suspended = ref<{
    videoPlaying: boolean
    audioPlaying: boolean
    motionEnabled: boolean
    wasMuted: boolean
  } | null>(null)

  function remember(state: NonNullable<typeof suspended.value>) {
    suspended.value = state
  }

  function clear() {
    suspended.value = null
  }

  /**
   * Panic itself is wired in useSafety, which needs the shell's video controls;
   * it registers here so a command palette or button can reach it too.
   */
  const toggleHandler = shallowRef<(() => void) | null>(null)
  function toggle() {
    toggleHandler.value?.()
  }

  return { panicked, panicOnBlur, idleStopMinutes, suspended, remember, clear, toggleHandler, toggle }
})
