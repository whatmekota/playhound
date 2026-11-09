<script setup lang="ts">
import type { SourceTrust } from '~/plugins/sources'

/**
 * The mark next to an official or trusted plugin's name: a check for
 * playhound's own, a heart for an author known to the project. `label` spells
 * it out next to the mark.
 */
defineProps<{ trust: SourceTrust, label?: boolean }>()

const INFO = {
  official: { tip: 'Official: made by playhound’s author', text: 'Official', icon: 'i-carbon-checkmark-filled text-accent-300' },
  trusted: { tip: 'Trusted author: known to playhound', text: 'Trusted author', icon: 'i-carbon-favorite-filled text-fg-muted' },
}
</script>

<template>
  <span v-if="trust" v-tip="label ? undefined : INFO[trust].tip" class="flex shrink-0 gap-1 items-center" :aria-label="INFO[trust].tip">
    <span :class="INFO[trust].icon" class="text-[13px]" />
    <span v-if="label" class="text-[11.5px] font-medium" :class="trust === 'official' ? 'text-accent-300' : 'text-fg-muted'">{{ INFO[trust].text }}</span>
  </span>
</template>
