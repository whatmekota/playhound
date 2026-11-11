import type { ComputedRef } from 'vue'
import { useMediaQuery, useWindowSize } from '@vueuse/core'
import { computed, effectScope, watchEffect } from 'vue'
import { devPhoneLayout } from '~/lib/android/detect'
import { isAndroidApp } from '~/lib/platform'

/**
 * The phone layout: the Android app on a narrow screen, or a short one (a
 * phone held sideways). The nav moves to a bar along the bottom, the tool
 * panels open full screen, and small buttons get a bigger touch area
 * (styles/android.css, keyed off `ph-compact` on <html>).
 *
 * Held sideways (or any phone-layout screen wider than it is tall), the bar
 * becomes a rail down the left side instead, so the player keeps the full
 * height (`ph-rail` on <html>). It follows rotation live.
 *
 * A phone is told by its screen, not the window: the shorter side under
 * 600 px (Android's own line between phones and tablets). The window alone
 * would flip the layout when fullscreen takes the status bar's room back on
 * a ~576 px-tall phone held sideways. A narrow or short window on a bigger
 * screen (split screen) still gets it too.
 *
 * Only in the Android app: a narrow browser window keeps the desktop layout.
 * (In development, `?phone` in the address lays a desktop browser out the
 * same way, for styling and screenshots; see android/detect.ts.)
 */
interface Layout {
  compact: ComputedRef<boolean>
  rail: ComputedRef<boolean>
}

let layout: Layout | null = null

const phoneLayoutHere = isAndroidApp || devPhoneLayout
/** Below this shorter side (CSS px) a screen is a phone's. */
export const PHONE_SHORT_SIDE = 600

function make(): Layout {
  // Its own scope: shared by every component, owned by none of them.
  return effectScope(true).run(() => {
    const small = useMediaQuery('(max-width: 767px), (max-height: 500px)')
    const landscape = useMediaQuery('(orientation: landscape)')
    // Read again on every resize: a foldable opening is a new screen.
    const win = useWindowSize()
    const phoneScreen = computed(() => {
      void win.width.value
      void win.height.value
      return typeof screen !== 'undefined' && Math.min(screen.width, screen.height) < PHONE_SHORT_SIDE
    })
    const compact = computed(() => phoneLayoutHere && (phoneScreen.value || small.value))
    const rail = computed(() => compact.value && landscape.value)
    if (phoneLayoutHere && typeof document !== 'undefined') {
      watchEffect(() => {
        document.documentElement.classList.toggle('ph-compact', compact.value)
        document.documentElement.classList.toggle('ph-rail', rail.value)
      })
    }
    return { compact, rail }
  })!
}

export function useCompactLayout(): ComputedRef<boolean> {
  layout ??= make()
  return layout.compact
}

/** The phone layout held sideways: the nav is a rail on the left, the player uses the full height. */
export function useRailLayout(): ComputedRef<boolean> {
  layout ??= make()
  return layout.rail
}
