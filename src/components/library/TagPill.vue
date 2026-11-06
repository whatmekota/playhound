<script setup lang="ts">
import { computed } from 'vue'
import { autoTagDef } from '~/lib/tags'

/**
 * One tag. Filled when someone gave it, outlined when it was worked out from
 * the video, so the two never read as the same kind of thing. `over` is for
 * sitting on a picture: white on dark whatever the theme.
 */
const props = defineProps<{
  tag: string
  auto?: boolean
  over?: boolean
  removable?: boolean
}>()

defineEmits<{ remove: [] }>()

const tip = computed(() => props.auto ? `Automatic · ${autoTagDef(props.tag)?.hint ?? 'worked out from the video'}` : undefined)
</script>

<template>
  <span v-tip="tip" class="tag-pill" :class="[auto ? 'is-auto' : 'is-manual', over ? 'is-over' : '']">
    <span class="truncate">{{ tag }}</span>
    <span v-if="auto" class="sr-only">(automatic)</span>
    <button
      v-if="removable && !auto"
      type="button"
      class="tag-x rounded center shrink-0 h-4 w-4"
      :aria-label="`Remove ${tag}`"
      @click.stop="$emit('remove')"
    >
      <span class="i-carbon-close text-[11px]" />
    </button>
  </span>
</template>

<style scoped>
.tag-pill {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  min-width: 0;
  height: 18px;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  border: 1px solid transparent;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}
.tag-pill:has(.tag-x) {
  height: 22px;
  padding-right: 2px;
  font-size: 11.5px;
}
.is-manual {
  color: var(--accent-light);
  background: var(--accent-soft);
}
.is-auto {
  color: var(--text-muted);
  border-color: var(--border-strong);
  border-style: dashed;
}
.is-over.is-manual {
  color: white;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(6px);
}
.is-over.is-auto {
  color: rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.35);
  border-color: rgba(255, 255, 255, 0.45);
  backdrop-filter: blur(6px);
}
.tag-x:hover {
  background: color-mix(in srgb, currentColor 15%, transparent);
}
</style>
