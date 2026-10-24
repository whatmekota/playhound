<script setup lang="ts">
import type { ScriptSummary } from '~/lib/idb'
import type { VideoEntry } from '~/stores/libraryStore'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import { scriptBadge } from '~/lib/entryInfo'
import { thumbFailed } from '~/lib/thumbs'
import { formatTime } from '~/lib/time'
import Equaliser from './Equaliser.vue'
import IntensityMeter from './IntensityMeter.vue'

/**
 * One dense row for the drawer panels: picture, title, length, script and
 * intensity. `entry` is null for a playlist item whose file is not in the
 * library; it still shows, by `name`, so it can be removed.
 */
defineProps<{
  entry: VideoEntry | null
  name: string
  summary?: ScriptSummary | null
  current?: boolean
  playing?: boolean
}>()

defineEmits<{
  play: []
  playNext: []
  menu: [e: MouseEvent]
}>()
</script>

<template>
  <div
    class="lib-row group focusable"
    :class="{ 'is-current': current, 'is-missing': !entry }"
    tabindex="0"
    role="button"
    :aria-label="entry?.basename ?? name"
    @click="$emit('play')"
    @keydown.enter="$emit('play')"
    @contextmenu.prevent="$emit('menu', $event)"
  >
    <span class="rounded-[var(--radius-xs)] bg-surface-800 shrink-0 h-8 w-14 relative overflow-hidden">
      <img v-if="entry?.thumbnailUrl" :src="entry.thumbnailUrl" class="h-full w-full animate-fade-in object-cover" alt="" draggable="false">
      <span v-else-if="!entry" class="text-fg-faint center inset-0 absolute"><span class="i-carbon-unlink text-[13px]" /></span>
      <span v-else-if="!thumbFailed.has(entry.name)" class="skeleton inset-0 absolute" />
      <span v-if="current" class="text-white bg-black/45 center inset-0 absolute">
        <Equaliser :playing="!!playing" />
      </span>
    </span>

    <span class="flex-1 min-w-0">
      <span class="text-[12.5px] leading-4 block truncate" :class="current ? 'text-accent-300 font-medium' : 'text-fg'">
        {{ entry?.basename ?? name }}
      </span>
      <span class="text-[11px] text-fg-faint leading-4 mt-0.5 flex gap-1.5 items-center">
        <template v-if="entry">
          <span v-if="entry.duration" class="num">{{ formatTime(entry.duration) }}</span>
          <span
            v-if="entry.scriptType !== 'none'"
            v-tip="scriptBadge(entry).title"
            class="flex gap-0.5 items-center"
            :class="entry.scriptType === 'merged' ? 'text-info' : 'text-accent-300'"
          >
            <span :class="entry.scriptType === 'single' ? 'i-carbon-chart-line-smooth' : 'i-carbon-chart-multi-line'" class="text-[11px]" />
            <span v-if="scriptBadge(entry).short" class="num">{{ scriptBadge(entry).short }}</span>
          </span>
          <span v-else>No script</span>
          <IntensityMeter :summary="summary" />
        </template>
        <span v-else class="text-warn">Not in the library</span>
      </span>
    </span>

    <span v-if="entry?.starred" class="i-carbon-star-filled text-[12px] text-warn shrink-0" />
    <span class="opacity-0 flex shrink-0 transition-opacity items-center group-focus-within:opacity-100 group-hover:opacity-100">
      <UiIconButton v-if="entry" icon="i-carbon-add" label="Play next" size="xs" tip="left" @click.stop="$emit('playNext')" />
      <UiIconButton icon="i-carbon-overflow-menu-vertical" label="More" size="xs" tip="left" @click.stop="$emit('menu', $event)" />
    </span>
  </div>
</template>

<style scoped>
.lib-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 100%;
  padding: 0 6px 0 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    background-color var(--dur-fast),
    opacity var(--dur-fast);
}
.lib-row:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.lib-row.is-current {
  background: var(--accent-soft);
}
.lib-row.is-missing {
  opacity: 0.5;
}
.lib-row.is-missing:hover {
  opacity: 0.8;
}
</style>
