<script setup lang="ts">
import type { InspectorId } from '~/lib/views'
import { computed, ref } from 'vue'
import { INSPECTOR_COMPONENTS } from '~/lib/viewComponents'
import { findView } from '~/lib/views'
import { DRAWER_MAX, DRAWER_MIN, useUiStore } from '~/stores/uiStore'

const ui = useUiStore()

const slots = computed(() => {
  const out: { id: InspectorId, pinned: boolean }[] = []
  if (ui.pinned)
    out.push({ id: ui.pinned, pinned: true })
  if (ui.inspector && ui.inspector !== ui.pinned)
    out.push({ id: ui.inspector, pinned: false })
  return out
})

// ─── Width ──────────────────────────────────────────────────────────────────
const resizing = ref(false)
function onResizeDown(e: PointerEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startW = ui.drawerWidth
  resizing.value = true
  const move = (ev: PointerEvent) => {
    // The drawer sits on the right, so dragging left widens it.
    ui.drawerWidth = Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, startW - (ev.clientX - startX)))
  }
  const up = () => {
    resizing.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// ─── Split ──────────────────────────────────────────────────────────────────
const bodyEl = ref<HTMLElement | null>(null)
function onSplitDown(e: PointerEvent) {
  e.preventDefault()
  const startY = e.clientY
  const startH = ui.pinnedHeight
  const total = bodyEl.value?.clientHeight ?? 600
  const move = (ev: PointerEvent) => {
    ui.pinnedHeight = Math.max(20, Math.min(80, startH + ((ev.clientY - startY) / total) * 100))
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
</script>

<template>
  <Transition name="drawer">
    <aside
      v-if="ui.drawerOpen"
      class="border-l border-edge bg-surface-900 flex shrink-0 relative overflow-hidden"
      :style="{ width: `${ui.drawerWidth}px` }"
    >
      <div
        class="w-1.5 cursor-col-resize transition-colors bottom-0 left-0 top-0 absolute z-10"
        :class="resizing ? 'bg-accent/50' : 'hover:bg-accent/30'"
        @pointerdown="onResizeDown"
      />

      <div ref="bodyEl" class="flex flex-1 flex-col min-w-0" :style="{ width: `${ui.drawerWidth}px` }">
        <template v-for="(slot, i) in slots" :key="slot.id">
          <div
            v-if="i > 0"
            class="bg-edge shrink-0 h-1 cursor-row-resize transition-colors hover:bg-accent/40"
            @pointerdown="onSplitDown"
          />
          <section
            class="flex flex-col min-h-0"
            :class="slot.pinned && slots.length > 1 ? 'shrink-0' : 'flex-1'"
            :style="slot.pinned && slots.length > 1 ? { height: `${ui.pinnedHeight}%` } : undefined"
          >
            <header class="pl-4 pr-2 border-b border-edge flex shrink-0 gap-2 h-12 items-center">
              <span :class="findView(slot.id)?.icon" class="text-[16px] text-accent-300 shrink-0" />
              <h2 class="text-[14px] tracking-[-0.01em] font-semibold truncate">
                {{ findView(slot.id)?.label }}
              </h2>
              <div class="ml-auto flex shrink-0 gap-0.5 items-center">
                <UiIconButton
                  :icon="slot.pinned ? 'i-carbon-pin-filled' : 'i-carbon-pin'"
                  :label="slot.pinned ? 'Unpin' : 'Pin above other panels'"
                  :active="slot.pinned"
                  tip="bottom"
                  size="sm"
                  @click="ui.togglePin(slot.id)"
                />
                <UiIconButton icon="i-carbon-close" label="Close" tip="bottom" size="sm" @click="ui.closeInspector(slot.id)" />
              </div>
            </header>
            <Transition name="t-fade" mode="out-in">
              <KeepAlive :max="4">
                <component :is="INSPECTOR_COMPONENTS[slot.id]" :key="slot.id" class="flex-1 min-h-0" />
              </KeepAlive>
            </Transition>
          </section>
        </template>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.drawer-enter-active,
.drawer-leave-active {
  transition:
    width var(--dur-slow) var(--ease-out),
    opacity var(--dur) var(--ease-out);
}
.drawer-enter-from,
.drawer-leave-to {
  width: 0 !important;
  opacity: 0;
}
</style>
