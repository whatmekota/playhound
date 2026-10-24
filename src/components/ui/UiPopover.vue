<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

/**
 * Anchored floating panel.
 *
 *   <UiPopover placement="top">
 *     <template #trigger="{ toggle, open }">
 *       <UiButton :active="open" @click="toggle">Speed</UiButton>
 *     </template>
 *     …content…
 *   </UiPopover>
 *
 * Teleported to <body> so overflow:hidden parents cannot clip it; positioned
 * from the trigger's rect and kept inside the viewport. Closes on outside
 * click and Escape. v-model:open is optional.
 */
const props = withDefaults(defineProps<{
  placement?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  /** Gap between trigger and panel in px. */
  offset?: number
  /** Panel width; any CSS length. */
  width?: string
  /** Remove default padding. */
  flush?: boolean
}>(), { placement: 'bottom', align: 'center', offset: 8 })

const open = defineModel<boolean>('open', { default: false })

const triggerEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const pos = ref({ x: 0, y: 0 })
const origin = ref('center bottom')

function toggle() {
  open.value = !open.value
}
function close() {
  open.value = false
}

function place() {
  const t = triggerEl.value?.firstElementChild as HTMLElement | null ?? triggerEl.value
  const p = panelEl.value
  if (!t || !p)
    return
  const r = t.getBoundingClientRect()
  const pw = p.offsetWidth
  const ph = p.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  const m = 8
  let x = 0
  let y = 0
  let placement = props.placement

  // Flip when there is not enough room on the requested side.
  if (placement === 'top' && r.top - ph - props.offset < m)
    placement = 'bottom'
  else if (placement === 'bottom' && r.bottom + ph + props.offset > vh - m && r.top > ph)
    placement = 'top'

  const alignX = () => props.align === 'start' ? r.left : props.align === 'end' ? r.right - pw : r.left + r.width / 2 - pw / 2
  const alignY = () => props.align === 'start' ? r.top : props.align === 'end' ? r.bottom - ph : r.top + r.height / 2 - ph / 2

  if (placement === 'top') {
    x = alignX()
    y = r.top - ph - props.offset
  }
  else if (placement === 'bottom') {
    x = alignX()
    y = r.bottom + props.offset
  }
  else if (placement === 'left') {
    x = r.left - pw - props.offset
    y = alignY()
  }
  else {
    x = r.right + props.offset
    y = alignY()
  }
  x = Math.max(m, Math.min(vw - pw - m, x))
  y = Math.max(m, Math.min(vh - ph - m, y))
  pos.value = { x, y }
  origin.value = placement === 'top' ? 'center bottom' : placement === 'bottom' ? 'center top' : placement === 'left' ? 'right center' : 'left center'
}

function onDocDown(e: PointerEvent) {
  const target = e.target as Node
  if (panelEl.value?.contains(target) || triggerEl.value?.contains(target))
    return
  // Clicks inside another teleported popover (a nested menu) do not count.
  if ((target as HTMLElement).closest?.('[data-ui-popover]'))
    return
  close()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

watch(open, async (v) => {
  if (v) {
    await nextTick()
    place()
    document.addEventListener('pointerdown', onDocDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', place)
  }
  else {
    document.removeEventListener('pointerdown', onDocDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', place)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true)
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', place)
})

defineExpose({ close, place })
</script>

<template>
  <span ref="triggerEl" class="contents">
    <slot name="trigger" :open="open" :toggle="toggle" :close="close" />
  </span>
  <Teleport to="body">
    <Transition name="t-pop">
      <div
        v-if="open"
        ref="panelEl"
        data-ui-popover
        class="pop fixed z-[1000]"
        :class="flush ? '' : 'p-2'"
        :style="{ left: `${pos.x}px`, top: `${pos.y}px`, width, transformOrigin: origin }"
      >
        <slot :close="close" />
      </div>
    </Transition>
  </Teleport>
</template>
