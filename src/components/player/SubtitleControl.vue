<script setup lang="ts">
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import { toast } from '~/composables/useToast'
import { useSubtitleStore } from '~/stores/subtitleStore'
import { useUiStore } from '~/stores/uiStore'

/**
 * The dock's subtitles button. One track: a toggle. Several: a menu to pick
 * one or switch them off. None: says how to add one.
 */
const subs = useSubtitleStore()
const ui = useUiStore()

function onClick(toggleMenu: () => void) {
  if (subs.tracks.length > 1)
    toggleMenu()
  else if (!subs.toggle())
    toast('No subtitles for this video', { detail: 'Drop a .srt or .vtt file on the player to add one', icon: 'i-carbon-closed-caption', key: 'subs' })
}

function pick(id: string | null, close: () => void) {
  subs.select(id)
  close()
}

function openSettings(close: () => void) {
  close()
  ui.settingsSection = 'playback'
  ui.settingsOpen = true
}
</script>

<template>
  <UiPopover placement="top" align="end" width="240px">
    <template #trigger="{ toggle, open }">
      <UiIconButton
        :icon="subs.activeId ? 'i-carbon-closed-caption-filled' : 'i-carbon-closed-caption'"
        :label="subs.active ? `Subtitles: ${subs.active.label}` : subs.tracks.length ? 'Subtitles off' : 'Subtitles'"
        kbd="V"
        size="sm"
        :active="!!subs.activeId || open"
        :class="subs.tracks.length ? '' : 'opacity-60'"
        @click="onClick(toggle)"
      />
    </template>
    <template #default="{ close }">
      <div class="flex flex-col gap-0.5">
        <span class="eyebrow px-2 pb-1">Subtitles</span>
        <button type="button" class="sub-row" :class="!subs.activeId ? 'is-on' : ''" @click="pick(null, close)">
          <span class="flex-1">Off</span>
          <span v-if="!subs.activeId" class="i-carbon-checkmark text-[12px]" />
        </button>
        <button
          v-for="t in subs.tracks"
          :key="t.id"
          v-tip="t.fileName"
          type="button"
          class="sub-row"
          :class="subs.activeId === t.id ? 'is-on' : ''"
          @click="pick(t.id, close)"
        >
          <span class="flex-1 truncate">{{ t.label }}</span>
          <span v-if="subs.activeId === t.id" class="i-carbon-checkmark text-[12px]" />
        </button>
        <div class="my-1 divider-y" />
        <button type="button" class="sub-row is-muted" @click="openSettings(close)">
          <span class="i-carbon-settings-adjust" />
          <span class="flex-1">Text size and position</span>
        </button>
      </div>
    </template>
  </UiPopover>
</template>

<style scoped>
.sub-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text);
  text-align: left;
  transition: background-color var(--dur-fast);
}
.sub-row:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
}
.sub-row.is-muted {
  color: var(--text-muted);
}
.sub-row.is-on {
  color: var(--accent-light);
}
</style>
