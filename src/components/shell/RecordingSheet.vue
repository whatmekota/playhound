<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiModal from '~/components/ui/UiModal.vue'
import UiStat from '~/components/ui/UiStat.vue'
import { cleanBase } from '~/lib/recording'
import { formatTime } from '~/lib/time'
import { useRecordingStore } from '~/stores/recordingStore'

/**
 * After a recording stops: what was caught, where it goes, Save or Discard.
 *
 * It stays until one of the two is chosen (no closing by Esc or a click
 * outside), so a long take is never lost to a stray click.
 */
const rec = useRecordingStore()

const name = ref('')
// The suggested name arrives once the folder has been looked at.
watch(() => rec.pending?.base, (base) => {
  if (base)
    name.value = base
})

const p = computed(() => rec.pending)
const files = computed(() => rec.filesFor(name.value))
const replaces = computed(() => files.value.filter(f => p.value?.existing.has(f.name.toLowerCase())).map(f => f.name))
const subtitle = computed(() => {
  if (!p.value)
    return ''
  return p.value.note ?? (p.value.video ? `In time with ${p.value.video}` : 'Timed from when it started')
})
const valid = computed(() => !!cleanBase(name.value))

function save() {
  if (valid.value && p.value?.target)
    void rec.save(name.value)
}
</script>

<template>
  <UiModal
    :open="rec.sheetOpen"
    title="Save recording"
    :subtitle="subtitle"
    icon="i-carbon-recording"
    width="440px"
    persistent
  >
    <div v-if="p" class="flex flex-col gap-4">
      <p v-if="p.plainReplay" class="text-[12px] text-fg-muted px-2.5 py-2 rounded-[var(--radius-md)] bg-fg/4 flex gap-2 items-start">
        <span class="i-carbon-information text-[14px] text-fg-faint mt-px shrink-0" />
        <span>Nothing new to record: this is the loaded script, played as written.</span>
      </p>

      <div class="gap-3 grid grid-cols-3">
        <UiStat label="Length" :value="formatTime(p.lengthMs / 1000)" size="sm" />
        <UiStat label="Points" :value="p.points.toLocaleString()" size="sm" />
        <UiStat :label="p.axes.length === 1 ? 'Axis' : 'Axes'" :value="p.axes.map(a => a.channel).join(' · ')" size="sm" />
      </div>

      <UiInput v-model="name" label="Name" size="md" mono :disabled="!p.target" @enter="save" />

      <div class="flex flex-col gap-1.5">
        <span class="label">Saves to</span>
        <div class="text-[12.5px] text-fg flex gap-2 min-w-0 items-center">
          <span :class="p.target?.kind === 'download' ? 'i-carbon-download' : 'i-carbon-folder'" class="text-[14px] text-fg-faint shrink-0" />
          <span class="truncate">{{ p.target?.label ?? 'Looking…' }}</span>
        </div>
        <ul class="flex flex-col gap-0.5">
          <li v-for="f in files" :key="f.name" class="text-[11.5px] text-fg-muted font-mono truncate">
            {{ f.name }}
          </li>
        </ul>
        <p v-if="replaces.length" class="hint text-warn">
          Replaces the {{ replaces.length === 1 ? 'file' : 'files' }} already there.
        </p>
      </div>
    </div>

    <template #footer>
      <UiButton variant="ghost" icon="i-carbon-trash-can" :disabled="rec.saving" @click="rec.discard()">
        Discard
      </UiButton>
      <UiButton
        :variant="p?.plainReplay ? 'secondary' : 'primary'"
        icon="i-carbon-save"
        :loading="rec.saving"
        :disabled="!valid || !p?.target"
        @click="save"
      >
        {{ replaces.length ? 'Replace' : 'Save' }}
      </UiButton>
    </template>
  </UiModal>
</template>
