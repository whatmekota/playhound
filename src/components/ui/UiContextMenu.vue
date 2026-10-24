<script setup lang="ts">
import type { MenuItem } from './menu'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import UiMenu from './UiMenu.vue'

/**
 * Right-click menu at a point.
 *
 *   const menu = ref<{ x: number, y: number, items: MenuItem[] } | null>(null)
 *   <div @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, items: [...] }" />
 *   <UiContextMenu v-model="menu" />
 */
const model = defineModel<{ x: number, y: number, items: MenuItem[] } | null>({ default: null })
const el = ref<HTMLElement | null>(null)
const pos = ref({ x: 0, y: 0 })

function close() {
  model.value = null
}

function onDown(e: PointerEvent) {
  if (!el.value?.contains(e.target as Node))
    close()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

watch(model, async (m) => {
  if (m) {
    pos.value = { x: m.x, y: m.y }
    await nextTick()
    const r = el.value?.getBoundingClientRect()
    if (r) {
      pos.value = {
        x: Math.min(m.x, window.innerWidth - r.width - 8),
        y: Math.min(m.y, window.innerHeight - r.height - 8),
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
  }
  else {
    document.removeEventListener('pointerdown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', close)
    window.removeEventListener('resize', close)
  }
})

onBeforeUnmount(close)
</script>

<template>
  <Teleport to="body">
    <Transition name="t-pop">
      <div
        v-if="model"
        ref="el"
        data-ui-popover
        class="p-1 pop fixed z-[1100]"
        style="transform-origin: top left; --pop-dy: 0"
        :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
        @contextmenu.prevent
      >
        <UiMenu :items="model.items" @done="close" />
      </div>
    </Transition>
  </Teleport>
</template>
