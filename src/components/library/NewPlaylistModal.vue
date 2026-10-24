<script setup lang="ts">
import type { VideoEntry } from '~/stores/libraryStore'
import { computed, nextTick, ref, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiModal from '~/components/ui/UiModal.vue'
import { toast } from '~/composables/useToast'
import { plural } from '~/lib/entryInfo'
import { usePlaylistStore } from '~/stores/playlistStore'
import { useUiStore } from '~/stores/uiStore'

/** "New playlist…" from a menu: name it, and the videos go straight in. */
const entries = defineModel<VideoEntry[] | null>({ default: null })

const plStore = usePlaylistStore()
const ui = useUiStore()

const name = ref('')
const input = ref<InstanceType<typeof UiInput> | null>(null)

const open = computed({
  get: () => !!entries.value,
  set: (v) => {
    if (!v)
      entries.value = null
  },
})

watch(entries, (list) => {
  if (list) {
    name.value = ''
    void nextTick(() => input.value?.focus())
  }
})

function create() {
  const list = entries.value
  if (!list)
    return
  const n = name.value.trim() || `Playlist ${plStore.playlists.length}`
  const pl = plStore.createPlaylist(n)
  for (const e of list)
    plStore.addToPlaylist(pl.id, e.name)
  toast.success(`Created ${n}`, {
    detail: plural(list.length, 'video'),
    icon: 'i-carbon-playlist',
    action: { label: 'Open', run: () => ui.openView('playlists') },
  })
  entries.value = null
}
</script>

<template>
  <UiModal v-model:open="open" title="New playlist" icon="i-carbon-playlist" width="400px" :subtitle="entries ? `With ${plural(entries.length, 'video')}` : ''">
    <UiInput ref="input" v-model="name" size="md" placeholder="Playlist name" @enter="create" />
    <template #footer>
      <UiButton variant="ghost" @click="open = false">
        Cancel
      </UiButton>
      <UiButton variant="primary" icon="i-carbon-add" @click="create">
        Create
      </UiButton>
    </template>
  </UiModal>
</template>
