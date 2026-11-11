import { reactive } from 'vue'

/**
 * The player's controls, shown or faded while a video plays untouched
 * (VideoPlayer owns the timer). The phone layout held sideways lays its
 * player bar over the video and fades it with them; touching the bar keeps
 * them up.
 */
export const playerChrome = reactive({
  /** The player's own bars are showing (or would be, on the full-size player). */
  shown: true,
  /** Wake them, as moving the pointer over the video does. Set by VideoPlayer. */
  poke: () => {},
})
