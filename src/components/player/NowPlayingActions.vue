<script setup lang="ts">
import type { MenuItem } from '~/components/ui/menu'
import type { VideoEntry } from '~/stores/libraryStore'
import { computed, ref, watchEffect } from 'vue'
import EntryInfoModal from '~/components/library/EntryInfoModal.vue'
import NewPlaylistModal from '~/components/library/NewPlaylistModal.vue'
import { showInFolderItem, useEntryActions } from '~/components/library/useEntryActions'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiMenu from '~/components/ui/UiMenu.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import { useUiStore } from '~/stores/uiStore'

/**
 * Beside the star over the playing video: "+" puts it in a playlist (or
 * takes it out of one, ticked), and "…" holds the rest — its info, its file
 * name, where it is on disk.
 */
const props = defineProps<{ entry: VideoEntry }>()
/** A menu or a dialog from one is open: the player keeps its bars up meanwhile. */
const busy = defineModel<boolean>('busy', { default: false })

const ui = useUiStore()
// The menus here never play anything, so `play` is never called.
const { infoEntry, newPlaylistFor, playlistItems, copyName } = useEntryActions({ play: () => {} })

const playlistsOpen = ref(false)
const moreOpen = ref(false)

const playlistMenu = computed<MenuItem[]>(() => [{ heading: true, label: 'Add to playlist' }, ...playlistItems([props.entry])])
const moreMenu = computed<MenuItem[]>(() => [
  { label: 'Info & tags…', icon: 'i-carbon-tag-edit', run: () => (infoEntry.value = props.entry) },
  { label: 'Copy file name', icon: 'i-carbon-copy', run: () => void copyName(props.entry) },
  ...showInFolderItem(props.entry),
  ...(props.entry.hasScript ? [{ label: 'Share card…', icon: 'i-carbon-image', run: () => (ui.shareCard = { kind: 'entry', entry: props.entry }) }] : []),
])

watchEffect(() => {
  busy.value = playlistsOpen.value || moreOpen.value || !!infoEntry.value || !!newPlaylistFor.value
})
</script>

<template>
  <UiPopover v-model:open="playlistsOpen" placement="bottom" align="end" flush>
    <template #trigger="{ toggle, open }">
      <UiIconButton
        icon="i-carbon-add-large"
        label="Add to playlist"
        variant="glass"
        size="md"
        tip="bottom"
        class="pointer-events-auto"
        :active="open"
        @click="toggle"
      />
    </template>
    <template #default="{ close }">
      <div class="p-1 max-h-[60vh] overflow-y-auto">
        <UiMenu :items="playlistMenu" @done="close" />
      </div>
    </template>
  </UiPopover>
  <UiPopover v-model:open="moreOpen" placement="bottom" align="end" flush>
    <template #trigger="{ toggle, open }">
      <UiIconButton
        icon="i-carbon-overflow-menu-horizontal"
        label="More"
        variant="glass"
        size="md"
        tip="bottom"
        class="pointer-events-auto"
        :active="open"
        @click="toggle"
      />
    </template>
    <template #default="{ close }">
      <div class="p-1">
        <UiMenu :items="moreMenu" @done="close" />
      </div>
    </template>
  </UiPopover>
  <EntryInfoModal v-model="infoEntry" />
  <NewPlaylistModal v-model="newPlaylistFor" />
</template>
