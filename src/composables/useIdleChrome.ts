import type { MaybeRefOrGetter } from 'vue'
import { onBeforeUnmount, ref, toValue, watch } from 'vue'

/**
 * Chrome that gets out of the way.
 *
 * Over a running canvas the toolbar should fade after a few seconds without
 * pointer movement and come straight back on the next one. `enabled` is when
 * hiding is allowed at all (something is running); `hold` pins it visible
 * (pointer over the toolbar, a sheet or popover open).
 */
export function useIdleChrome(opts: {
  enabled: MaybeRefOrGetter<boolean>
  hold?: MaybeRefOrGetter<boolean>
  delay?: number
}) {
  const visible = ref(true)
  const delay = opts.delay ?? 2600
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function poke() {
    visible.value = true
    clear()
    if (!toValue(opts.enabled) || toValue(opts.hold))
      return
    timer = setTimeout(() => {
      timer = null
      if (toValue(opts.enabled) && !toValue(opts.hold))
        visible.value = false
    }, delay)
  }

  watch(() => [toValue(opts.enabled), toValue(opts.hold)], poke, { immediate: true })
  onBeforeUnmount(clear)

  return { visible, poke }
}
