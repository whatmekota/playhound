<script setup lang="ts">
/**
 * A titled group of controls inside a panel.
 *
 * Collapsible when `collapsible` is set (state via v-model:open). The summary
 * shows on the right while collapsed, so a closed section still tells you what
 * it is set to. `live` puts a pulsing dot on the header when the section is
 * actively doing something (audio playing, device moving).
 */
const props = withDefaults(defineProps<{
  title?: string
  icon?: string
  /** Shown on the right of the header, mostly while collapsed. */
  summary?: string
  collapsible?: boolean
  live?: boolean
  /** Remove the card chrome and just stack. */
  flat?: boolean
}>(), {})

const open = defineModel<boolean>('open', { default: true })

function toggle() {
  if (props.collapsible)
    open.value = !open.value
}
</script>

<template>
  <section :class="flat ? '' : 'card'">
    <header
      v-if="title || $slots.actions"
      class="px-3 flex gap-2 h-10 select-none items-center"
      :class="collapsible ? 'cursor-pointer hover:bg-fg/3 rounded-[var(--radius-lg)] transition-colors' : ''"
      @click="toggle"
    >
      <span
        v-if="collapsible"
        class="i-carbon-chevron-right text-[12px] text-fg-faint shrink-0 transition-transform duration-200"
        :class="open ? 'rotate-90' : ''"
      />
      <span v-if="icon" :class="icon" class="text-[15px] text-fg-muted shrink-0" />
      <span class="text-[13px] text-fg font-medium truncate">{{ title }}</span>
      <span v-if="live" class="text-ok rounded-full bg-ok shrink-0 h-1.5 w-1.5 animate-pulse-dot" />
      <span v-if="summary && (!open || !collapsible)" class="text-[11.5px] text-fg-faint num ml-auto truncate">
        {{ summary }}
      </span>
      <div v-if="$slots.actions" class="flex shrink-0 gap-1 items-center" :class="summary && (!open || !collapsible) ? '' : 'ml-auto'" @click.stop>
        <slot name="actions" />
      </div>
    </header>
    <Transition name="t-collapse">
      <div v-if="open || !collapsible">
        <div class="min-h-0 overflow-hidden">
          <div class="flex flex-col gap-3" :class="flat ? '' : (title || $slots.actions ? 'px-3 pb-3' : 'p-3')">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>
