<script setup lang="ts">
import { computed, ref } from 'vue'
import StoreMarkdown from '~/components/plugins/StoreMarkdown.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiModal from '~/components/ui/UiModal.vue'
import { useUpdates } from '~/composables/useUpdates'
import { REPO } from '~/lib/android/updater'

/**
 * The Android app: a newer release is out (lib/android/updater.ts). One
 * line at the top with "Update"; "What's new" shows the release notes. A
 * debug build is told to install the release by hand, since Android will
 * not update it with a build signed by another key.
 */

const updates = useUpdates()
const s = computed(() => updates.state.value)
/** Hidden for this version until the app starts again. */
const dismissed = ref<string | null>(null)
const notesOpen = ref(false)

const shown = computed(() => {
  const st = s.value
  if (!st?.version || dismissed.value === st.version)
    return false
  return st.status === 'available' || st.status === 'downloading' || st.status === 'ready' || (st.status === 'error' && !!st.version)
})

const line = computed(() => {
  const st = s.value
  if (!st)
    return ''
  if (st.status === 'downloading')
    return `Downloading playhound ${st.version}… ${st.percent}%`
  if (st.status === 'error')
    return st.error ?? 'The update did not go through'
  return `playhound ${st.version} is available`
})

function update() {
  if (s.value?.manual)
    notesOpen.value = true
  else
    updates.install()
}

function openRelease() {
  window.open(s.value?.url ?? `https://github.com/${REPO}/releases/latest`, '_blank', 'noopener')
}
</script>

<template>
  <Transition name="t-fade">
    <div
      v-if="shown"
      role="status"
      class="update-banner text-[13px] text-fg pl-3 pr-1 border-b border-accent/25 bg-surface-850 flex gap-2 items-center"
    >
      <span class="i-carbon-renew text-[16px] text-accent-300 shrink-0" />
      <button type="button" class="leading-tight text-left flex-1 min-w-0 truncate" @click="notesOpen = true">
        {{ line }}
      </button>
      <UiButton size="md" variant="ghost" @click="notesOpen = true">
        What's new
      </UiButton>
      <UiButton size="md" variant="primary" icon="i-carbon-download" :loading="s?.status === 'downloading'" @click="update">
        Update
      </UiButton>
      <UiIconButton icon="i-carbon-close" label="Not now" size="lg" @click="dismissed = s?.version ?? null" />
    </div>
  </Transition>

  <UiModal v-model:open="notesOpen" :title="`playhound ${s?.version ?? ''}`" subtitle="What's new" icon="i-carbon-renew" width="560px">
    <div class="flex flex-col gap-3">
      <p v-if="s?.manual" class="text-[12.5px] text-warn leading-relaxed">
        This is a debug build of the app, signed with a different key: Android will not update it with a
        release. Uninstall it (your library folders stay where they are, but the app's settings go), then install
        the release from its page.
      </p>
      <p v-if="s?.status === 'error' && s.error" class="text-[12.5px] text-danger">
        {{ s.error }}
      </p>
      <div class="text-[13px] max-h-[55vh] overflow-y-auto">
        <StoreMarkdown v-if="s?.notes" :source="s.notes" :repo="REPO" />
        <p v-else class="hint">
          No notes with this release.
        </p>
      </div>
    </div>
    <template #footer>
      <UiButton variant="ghost" class="mr-auto" @click="openRelease">
        Release page
      </UiButton>
      <UiButton v-if="!s?.manual" variant="primary" icon="i-carbon-download" :loading="s?.status === 'downloading'" @click="updates.install()">
        {{ s?.status === 'downloading' ? `Downloading ${s.percent}%` : s?.status === 'ready' ? 'Install' : 'Update' }}
      </UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
.update-banner {
  min-height: 52px;
  padding-top: env(safe-area-inset-top, 0px);
}
</style>
