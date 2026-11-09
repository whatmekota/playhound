<script setup lang="ts">
import { computed, ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import { toast } from '~/composables/useToast'
import { normalisePattern, thumbPath, uniqueName } from '~/lib/scriptPatterns'
import { useScriptEditStore } from '~/stores/scriptEditStore'
import { useScriptPatternStore } from '~/stores/scriptPatternStore'

/** Keep the selected points as a pattern, to fill with or insert later. */

const emit = defineEmits<{ close: [] }>()

const edit = useScriptEditStore()
const patterns = useScriptPatternStore()

const name = ref(uniqueName(`Pattern ${patterns.saved.length + 1}`, patterns.all.map(p => p.name)))
const picked = computed(() => edit.selection.map(i => edit.points[i]).filter(Boolean))
const preview = computed(() => normalisePattern(picked.value, name.value, 'preview'))
const path = computed(() => (preview.value ? thumbPath({ kind: 'pattern', points: preview.value.points }, 248, 40) : ''))

function save() {
  const p = patterns.add(picked.value, name.value)
  if (!p)
    return
  toast.success('Pattern saved', { detail: `${p.name} · in Fill (Shift I)`, icon: 'i-carbon-save-series', key: 'pattern-save' })
  emit('close')
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <span class="text-[13px] text-fg font-medium">Save the selection as a pattern</span>
    <template v-if="preview">
      <div class="text-accent-300 px-1 py-1.5 well">
        <svg width="248" height="40" viewBox="0 0 248 40" class="block" aria-hidden="true">
          <path :d="path" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        </svg>
      </div>
      <p class="hint num">
        {{ preview.points.length }} points · {{ (preview.durationMs / 1000).toFixed(1) }} s · range {{ preview.lo }}–{{ preview.hi }}
      </p>
      <UiInput v-model="name" label="Name" autofocus @enter="save" />
    </template>
    <p v-else class="hint">
      Select at least two points at different times.
    </p>
    <div class="flex gap-2 justify-end">
      <UiButton variant="ghost" size="sm" @click="emit('close')">
        Cancel
      </UiButton>
      <UiButton variant="primary" size="sm" icon="i-carbon-save-series" :disabled="!preview" @click="save">
        Save
      </UiButton>
    </div>
  </div>
</template>
