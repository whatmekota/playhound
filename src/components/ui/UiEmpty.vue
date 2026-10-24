<script setup lang="ts">
/** Empty state: icon in a soft tile, a title, one line of help and actions. */
withDefaults(defineProps<{
  icon?: string
  title: string
  description?: string
  size?: 'sm' | 'md' | 'lg'
}>(), { size: 'md' })
</script>

<template>
  <div
    class="text-center flex flex-col animate-rise items-center justify-center"
    :class="size === 'sm' ? 'gap-2 py-6 px-4' : size === 'md' ? 'gap-3 py-10 px-6' : 'gap-4 py-16 px-8'"
  >
    <div
      v-if="icon"
      class="text-fg-muted rounded-[var(--radius-lg)] bg-surface-800 center ring-1 ring-edge"
      :class="size === 'sm' ? 'h-10 w-10 text-[18px]' : size === 'md' ? 'h-12 w-12 text-[22px]' : 'h-16 w-16 text-[28px]'"
    >
      <span :class="icon" />
    </div>
    <div class="flex flex-col gap-1 max-w-[340px]">
      <p class="text-fg font-medium" :class="size === 'lg' ? 'text-[17px]' : 'text-[14px]'">
        {{ title }}
      </p>
      <p v-if="description" class="text-[12.5px] text-fg-muted leading-relaxed">
        {{ description }}
      </p>
      <slot name="description" />
    </div>
    <div v-if="$slots.default" class="mt-1 flex flex-wrap gap-2 justify-center">
      <slot />
    </div>
  </div>
</template>
