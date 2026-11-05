<script setup lang="ts">
import { computed } from 'vue'
import PluginPanelHost from '~/components/plugins/PluginPanelHost.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiTabs from '~/components/ui/UiTabs.vue'
import { usePluginStore } from '~/stores/pluginStore'
import { useUiStore } from '~/stores/uiStore'

const plugins = usePluginStore()
const ui = useUiStore()

const withPanels = computed(() => plugins.plugins.filter(p => p.panel && p.status === 'on'))
const tabs = computed(() => withPanels.value.map(p => ({ value: p.manifest.id, label: p.panel?.title || p.manifest.name })))
const current = computed(() => withPanels.value.find(p => p.manifest.id === plugins.activePanel) ?? withPanels.value[0] ?? null)
const active = computed({
  get: () => current.value?.manifest.id ?? '',
  set: (id: string) => {
    plugins.activePanel = id
  },
})

function openSettings() {
  ui.settingsSection = 'plugins'
  ui.settingsOpen = true
}
</script>

<template>
  <div class="flex flex-1 flex-col min-h-0">
    <div v-if="tabs.length > 1" class="px-3 pt-2 shrink-0">
      <UiTabs v-model="active" :tabs="tabs" />
    </div>
    <PluginPanelHost v-if="current?.panel" :key="current.manifest.id" :panel="current.panel" :plugin-id="current.manifest.id" />
    <div v-else class="p-6 flex flex-1 flex-col gap-3 items-center justify-center">
      <UiEmpty icon="i-carbon-application" title="No plugin panels" description="Switched-on plugins that have a panel show up here." size="sm" />
      <UiButton icon="i-carbon-settings" @click="openSettings">
        Plugins in Settings
      </UiButton>
    </div>
  </div>
</template>
