import { usePlayerStore } from '@/stores/playerStore'

export function useLoopSection() {
  const playerStore = usePlayerStore()

  function setLoopStart(time?: number) {
    const t = time ?? playerStore.currentTime
    playerStore.setLoopStart(t)
    // If end is set but before new start, clear end
    if (playerStore.loopEnd !== null && playerStore.loopEnd <= t) {
      playerStore.setLoopEnd(null)
    }
  }

  function setLoopEnd(time?: number) {
    const t = time ?? playerStore.currentTime
    playerStore.setLoopEnd(t)
    // If start is not set, set it to 0
    if (playerStore.loopStart === null) {
      playerStore.setLoopStart(0)
    }
  }

  function toggleLoop() {
    if (playerStore.hasLoop) {
      playerStore.loopEnabled = !playerStore.loopEnabled
    }
  }

  function clearLoop() {
    playerStore.clearLoop()
  }

  /**
   * Check if a seek/loop is needed at the current time.
   * Call this from the video's timeupdate handler.
   * Returns the time to seek to, or null if no action needed.
   */
  function checkLoop(currentTime: number): number | null {
    if (!playerStore.loopActive) return null
    const { loopStart, loopEnd } = playerStore
    if (loopStart === null || loopEnd === null) return null

    if (currentTime >= loopEnd) {
      return loopStart
    }
    return null
  }

  return { setLoopStart, setLoopEnd, toggleLoop, clearLoop, checkLoop }
}
