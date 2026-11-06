<script setup lang="ts">
import { computed } from 'vue'
import PluginPanelHost from '~/components/plugins/PluginPanelHost.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiSpinner from '~/components/ui/UiSpinner.vue'
import { usePluginStore } from '~/stores/pluginStore'
import { useUiStore } from '~/stores/uiStore'

/** A plugin's page on the main stage; the left nav has a button per plugin with one. */
defineOptions({ name: 'PluginStageView' })

const plugins = usePluginStore()
const ui = useUiStore()

const plugin = computed(() => plugins.plugins.find(p => p.manifest.id === ui.pluginView) ?? null)
/** Coming back to a plugin's page after a reload: it shows once the plugin has started. */
const starting = computed(() => !plugins.loaded || plugin.value?.status === 'loading')

function openSettings() {
  ui.settingsSection = 'plugins'
  ui.settingsOpen = true
}
</script>

<template>
  <section class="bg-surface-950 flex flex-col min-h-0">
    <PluginPanelHost v-if="plugin?.page" :key="plugin.manifest.id" :panel="plugin.page" :plugin-id="plugin.manifest.id" class="plugin-page" />
    <div v-else-if="starting" class="flex flex-1 items-center justify-center">
      <UiSpinner />
    </div>
    <div v-else class="p-6 flex flex-1 flex-col gap-3 items-center justify-center">
      <UiEmpty icon="i-carbon-application" title="This plugin's page isn't here" description="The plugin is switched off, was removed, or no longer has a page." size="sm" />
      <UiButton icon="i-carbon-settings" @click="openSettings">
        Plugins in Settings
      </UiButton>
    </div>
  </section>
</template>
