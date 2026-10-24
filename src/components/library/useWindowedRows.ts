import type { MaybeRefOrGetter, Ref } from 'vue'
import { useElementSize } from '@vueuse/core'
import { computed, onBeforeUnmount, ref, toValue, watch } from 'vue'

export interface WindowRow<T> {
  index: number
  top: number
  cells: { item: T, index: number }[]
}

/**
 * Only the rows in view (plus a margin) are rendered, so ten thousand videos
 * cost the same as forty. Rows are absolutely placed inside a spacer of the
 * full height, which keeps the native scrollbar honest.
 *
 * `cols` and `rowH` are functions of the scroller's inner width, which this
 * measures, so a grid can fit as many columns as the space allows.
 */
export function useWindowedRows<T>(opts: {
  scroller: Ref<HTMLElement | null>
  items: MaybeRefOrGetter<readonly T[]>
  cols?: (width: number) => number
  rowH: number | ((width: number, cols: number) => number)
  overscan?: number
}) {
  const { width, height } = useElementSize(opts.scroller)
  const scrollTop = ref(0)
  const overscan = opts.overscan ?? 2
  let raf = 0

  function onScroll() {
    if (raf)
      return
    raf = requestAnimationFrame(() => {
      raf = 0
      scrollTop.value = opts.scroller.value?.scrollTop ?? 0
    })
  }
  onBeforeUnmount(() => cancelAnimationFrame(raf))

  // The scroller is re-created when the body switches between states.
  watch(opts.scroller, el => (scrollTop.value = el?.scrollTop ?? 0))

  const cols = computed(() => Math.max(1, opts.cols?.(width.value) ?? 1))
  const rowH = computed(() => Math.max(1, typeof opts.rowH === 'number' ? opts.rowH : opts.rowH(width.value, cols.value)))
  const count = computed(() => toValue(opts.items).length)
  const rowCount = computed(() => Math.ceil(count.value / cols.value))
  const totalH = computed(() => rowCount.value * rowH.value)

  const rows = computed(() => {
    const h = rowH.value
    const c = cols.value
    const list = toValue(opts.items)
    const first = Math.max(0, Math.floor(scrollTop.value / h) - overscan)
    const last = Math.min(rowCount.value, Math.ceil((scrollTop.value + Math.max(height.value, 400)) / h) + overscan)
    const out: WindowRow<T>[] = []
    for (let r = first; r < last; r++) {
      const start = r * c
      out.push({
        index: r,
        top: r * h,
        cells: list.slice(start, start + c).map((item, j) => ({ item, index: start + j })),
      })
    }
    return out
  })

  const visible = computed(() => rows.value.flatMap(r => r.cells.map(c => c.item)))

  /** Bring item `i` to the middle of the view. */
  function scrollToIndex(i: number, behavior: ScrollBehavior = 'smooth') {
    const el = opts.scroller.value
    if (i < 0 || !el)
      return
    const row = Math.floor(i / cols.value)
    el.scrollTo({ top: Math.max(0, row * rowH.value - height.value / 2 + rowH.value / 2), behavior })
  }

  function scrollToTop() {
    opts.scroller.value?.scrollTo({ top: 0 })
  }

  return { width, height, scrollTop, onScroll, rows, visible, totalH, cols, rowH, scrollToIndex, scrollToTop }
}
