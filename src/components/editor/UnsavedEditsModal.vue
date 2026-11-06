<script setup lang="ts">
import { computed } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiModal from '~/components/ui/UiModal.vue'
import { useScriptEditStore } from '~/stores/scriptEditStore'

/** "You have unsaved edits": asked before anything replaces or closes edited scripts. */
const edit = useScriptEditStore()

const open = computed({
  get: () => !!edit.leavePrompt,
  // Closing the dialog any other way (Esc, the backdrop) keeps the edits.
  set: v => !v && edit.answerLeave('cancel'),
})

const names = computed(() => [...new Set(edit.dirtyScripts.map(s => s.filename))].join(', '))
</script>

<template>
  <UiModal
    v-model:open="open"
    title="Unsaved script edits"
    :subtitle="names"
    icon="i-carbon-edit"
    width="420px"
  >
    <p class="text-[13px] text-fg-muted">
      {{ edit.leavePrompt?.action ?? 'Leaving' }} will lose them. Save them next to the video first?
    </p>
    <template #footer>
      <UiButton variant="ghost" @click="edit.answerLeave('cancel')">
        Keep editing
      </UiButton>
      <UiButton variant="danger" @click="edit.answerLeave('discard')">
        Discard
      </UiButton>
      <UiButton variant="primary" icon="i-carbon-save" @click="edit.answerLeave('save')">
        Save
      </UiButton>
    </template>
  </UiModal>
</template>
