import { ref } from 'vue'

/**
 * The easter egg: five quick clicks on the logo in Settings → About open a
 * party version of the splash (src/components/shell/PartySplash.vue).
 */

/** The party screen is showing. */
export const partyOpen = ref(false)

/** Clicks this close together count toward the five. */
export const PARTY_CLICK_GAP_MS = 700
export const PARTY_CLICKS = 5

/** Counts clicks; returns true on the one that opens the party. */
export function createPartyCounter(now: () => number = () => performance.now()) {
  let count = 0
  let last = -Infinity
  return () => {
    const t = now()
    count = t - last <= PARTY_CLICK_GAP_MS ? count + 1 : 1
    last = t
    if (count >= PARTY_CLICKS) {
      count = 0
      return true
    }
    return false
  }
}
