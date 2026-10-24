<script setup lang="ts">
import type { MenuItem } from './menu'

/**
 * A list of actions. Used inside UiPopover (dropdowns) and UiContextMenu.
 * Items come from data so menus stay declarative; see ./menu.ts.
 */
defineProps<{ items: MenuItem[] }>()
const emit = defineEmits<{ done: [] }>()

function run(item: MenuItem) {
  if (item.disabled || item.separator)
    return
  item.run?.()
  emit('done')
}
</script>

<template>
  <div role="menu" class="flex flex-col min-w-[180px]">
    <template v-for="(item, i) in items" :key="i">
      <div v-if="item.separator" class="my-1 divider-y" role="separator" />
      <div v-else-if="item.heading" class="eyebrow px-2.5 pb-1 pt-2">
        {{ item.label }}
      </div>
      <button
        v-else
        type="button"
        role="menuitem"
        :disabled="item.disabled"
        class="text-[13px] px-2.5 text-left focusable rounded-[var(--radius-sm)] flex gap-2.5 h-8 transition-colors items-center disabled:opacity-40"
        :class="item.danger ? 'text-danger hover:bg-danger/12' : 'text-fg hover:bg-fg/8'"
        @click="run(item)"
      >
        <span :class="item.icon ?? ''" class="text-[15px] shrink-0 w-4" :style="{ opacity: item.icon ? 0.8 : 0 }" />
        <span class="flex-1 truncate">{{ item.label }}</span>
        <span v-if="item.checked" class="i-carbon-checkmark text-[14px] text-accent-300" />
        <kbd v-if="item.kbd" class="text-[11px] text-fg-faint font-mono">{{ item.kbd }}</kbd>
      </button>
    </template>
  </div>
</template>
