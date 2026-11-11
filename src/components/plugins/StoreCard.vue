<script setup lang="ts">
import type { StoreEntry } from '~/plugins/storeEntry'
import { computed } from 'vue'
import PluginIcon from '~/components/plugins/PluginIcon.vue'
import TrustMark from '~/components/plugins/TrustMark.vue'
import UiButton from '~/components/ui/UiButton.vue'
import { iconRef } from '~/plugins/storeEntry'
import { ago, categoryOf, count } from '~/plugins/storeMeta'
import { usePluginStore } from '~/stores/pluginStore'

/**
 * A plugin in the store's grid. The whole card opens its details; the one
 * button on it installs or updates without going there.
 */
const props = defineProps<{ entry: StoreEntry, busy: boolean, disabled: boolean }>()
const emit = defineEmits<{ open: [], get: [] }>()
const store = usePluginStore()

const icon = computed(() => iconRef(props.entry, store.pluginFile))
const category = computed(() => categoryOf(props.entry.category ?? undefined))
const checking = computed(() => props.entry.source?.status === 'checking' && !props.entry.release)
const error = computed(() => (props.entry.source?.status === 'error' ? props.entry.source.error : ''))
</script>

<template>
  <div class="group p-3.5 card flex flex-col gap-2.5 min-w-0 transition-[border-color,box-shadow,transform] duration-200 relative hover:border-edge-strong hover:shadow-[var(--shadow-md)] hover:-translate-y-px">
    <!-- The card's click target, under the button. -->
    <button type="button" class="focusable rounded-[var(--radius-lg)] inset-0 absolute" :aria-label="`About ${entry.name}`" @click="emit('open')" />

    <div class="flex gap-3 min-w-0 pointer-events-none items-start relative">
      <PluginIcon :id="entry.id" :name="entry.name" :image="icon" :official="entry.trust === 'official'" :size="44" />
      <div class="flex flex-1 flex-col gap-0.5 min-w-0">
        <span class="flex gap-1.5 min-w-0 items-center">
          <span class="text-[13.5px] text-fg font-semibold truncate">{{ entry.name }}</span>
          <TrustMark :trust="entry.trust" class="pointer-events-auto" />
        </span>
        <span class="text-[11.5px] text-fg-faint truncate">{{ entry.author }}</span>
      </div>
    </div>

    <p v-if="checking" class="hint m-0 pointer-events-none relative">
      Checking…
    </p>
    <p v-else-if="error && !entry.release" class="text-[11.5px] text-danger leading-snug m-0 pointer-events-none relative">
      {{ error }}
    </p>
    <p v-else class="text-[12px] text-fg-muted leading-snug m-0 min-h-[2lh] pointer-events-none relative line-clamp-2">
      {{ entry.description || 'No description.' }}
    </p>

    <div class="mt-auto flex gap-2 min-w-0 pointer-events-none items-center relative">
      <div class="text-[11px] text-fg-faint flex flex-1 flex-wrap gap-x-2 gap-y-0.5 min-w-0 items-center">
        <span v-if="category" class="text-fg-muted flex gap-1 items-center">
          <span :class="category.icon" class="text-[12px]" />{{ category.label }}
        </span>
        <span v-if="entry.version" class="num">{{ entry.version }}</span>
        <span v-if="entry.release?.publishedAt">{{ ago(entry.release.publishedAt) }}</span>
        <span v-if="entry.release?.downloads" v-tip="`${entry.release.downloads} downloads`" class="flex gap-0.5 pointer-events-auto items-center">
          <span class="i-carbon-download text-[11px]" />{{ count(entry.release.downloads) }}
        </span>
      </div>

      <span v-if="entry.problem" v-tip="entry.problem" class="text-[11px] text-warn font-medium flex shrink-0 gap-1 pointer-events-auto items-center">
        <span class="i-carbon-warning-alt text-[13px]" /> {{ /needs the desktop app/.test(entry.problem) ? 'Needs the desktop app' : 'Can\'t install' }}
      </span>
      <UiButton
        v-else-if="entry.update"
        variant="primary"
        size="xs"
        icon="i-carbon-upgrade"
        class="pointer-events-auto"
        :loading="busy"
        :disabled="disabled"
        @click="emit('get')"
      >
        Update
      </UiButton>
      <span v-else-if="entry.installed" class="text-[11px] text-ok font-medium flex shrink-0 gap-1 items-center">
        <span class="i-carbon-checkmark text-[13px]" /> Installed
      </span>
      <UiButton
        v-else-if="entry.release"
        size="xs"
        icon="i-carbon-download"
        class="pointer-events-auto"
        :loading="busy"
        :disabled="disabled"
        @click="emit('get')"
      >
        Install
      </UiButton>
    </div>
  </div>
</template>
