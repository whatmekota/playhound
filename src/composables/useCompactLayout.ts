import type { ComputedRef } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { computed, effectScope, watchEffect } from 'vue'
import { isAndroidApp } from '~/lib/platform'

/**
 * The phone layout: the Android app on a narrow screen, or a short one (a
 * phone held sideways). The nav moves to a bar along the bottom, the tool
 * panels open full screen, and small buttons get a bigger touch area
 * (styles/android.css, keyed off `ph-compact` on <html>).
 *
 * Only in the Android app: a narrow browser window keeps the desktop layout.
 */
let compact: ComputedRef<boolean> | null = null

export function useCompactLayout(): ComputedRef<boolean> {
  // Its own scope: shared by every component, owned by none of them.
  compact ??= effectScope(true).run(() => {
    const phone = useMediaQuery('(max-width: 767px), (max-height: 500px)')
    const c = computed(() => isAndroidApp && phone.value)
    if (isAndroidApp && typeof document !== 'undefined')
      watchEffect(() => document.documentElement.classList.toggle('ph-compact', c.value))
    return c
  })!
  return compact
}
