<script setup lang="ts">
/**
 * A sheet in the phone layout: up from the bottom bar, or in from the right
 * when the phone is held sideways (styles/android.css). Tapping outside it
 * closes it. Used by the bottom bar's Tools and More, and the player's "…".
 */
defineProps<{ label: string }>()
const open = defineModel<boolean>('open', { required: true })
</script>

<template>
  <Teleport to="body">
    <Transition name="t-fade">
      <div v-if="open" class="mobile-sheet-backdrop bg-black/40 inset-0 fixed z-[640]" @pointerdown.self="open = false">
        <div
          class="mobile-sheet px-3 pb-3 pt-2 scroll-y border-t border-edge bg-surface-900 shadow-[var(--shadow-pop)] absolute"
          role="dialog"
          :aria-label="label"
        >
          <div class="mobile-sheet-handle mx-auto mb-2 rounded-full bg-fg/20 h-1 w-10" />
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
