<script setup lang="ts">
/**
 * Scrolling body for an inspector or view.
 *
 * The shell draws the inspector's title bar, so an inspector component starts
 * with UiPanel and puts its content in the default slot:
 *
 *   <UiPanel>
 *     <template #toolbar> …search, filters… </template>
 *     <UiSection title="Connection"> … </UiSection>
 *     <template #footer> …primary action… </template>
 *   </UiPanel>
 *
 * `toolbar` stays pinned above the scroll area; `footer` pinned below.
 */
withDefaults(defineProps<{
  /** Content padding; `none` for edge-to-edge lists. */
  pad?: 'none' | 'sm' | 'md'
  /** Vertical gap between sections. */
  gap?: 'sm' | 'md'
}>(), { pad: 'sm', gap: 'sm' })
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div v-if="$slots.toolbar" class="px-3 py-2 border-b border-edge flex shrink-0 flex-col gap-2">
      <slot name="toolbar" />
    </div>
    <div
      class="scroll-y flex flex-1 flex-col"
      :class="[
        pad === 'none' ? '' : pad === 'sm' ? 'p-2.5' : 'p-4',
        gap === 'sm' ? 'gap-2.5' : 'gap-4',
      ]"
    >
      <slot />
    </div>
    <div v-if="$slots.footer" class="px-3 py-2.5 border-t border-edge bg-surface-900/60 flex shrink-0 gap-2 items-center">
      <slot name="footer" />
    </div>
  </div>
</template>
