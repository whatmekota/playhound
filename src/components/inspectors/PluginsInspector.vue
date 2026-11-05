<script setup lang="ts">
import PluginPanelHost from '~/components/plugins/PluginPanelHost.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import { usePluginStore } from '~/stores/pluginStore'
import { useUiStore } from '~/stores/uiStore'

/** The drawer for plugin panels: the rail has a button per plugin and picks which one shows here. */
const plugins = usePluginStore()
const ui = useUiStore()

function openSettings() {
  ui.settingsSection = 'plugins'
  ui.settingsOpen = true
}
</script>

<template>
  <div class="flex flex-1 flex-col min-h-0">
    <PluginPanelHost v-if="plugins.shownPanel?.panel" :key="plugins.shownPanel.manifest.id" :panel="plugins.shownPanel.panel" :plugin-id="plugins.shownPanel.manifest.id" />
    <div v-else class="p-6 flex flex-1 flex-col gap-3 items-center justify-center">
      <UiEmpty icon="i-carbon-application" title="No plugin panels" description="Switched-on plugins that have a panel show up here." size="sm" />
      <UiButton icon="i-carbon-settings" @click="openSettings">
        Plugins in Settings
      </UiButton>
    </div>
  </div>
</template>
