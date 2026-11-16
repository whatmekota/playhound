<script setup lang="ts">
import PluginPanelHost from '~/components/plugins/PluginPanelHost.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import { usePluginStore } from '~/stores/pluginStore'
import { useUiStore } from '~/stores/uiStore'

/** The drawer for plugin panels: the rail has a button per plugin and picks which one shows here. */
const plugins = usePluginStore()
const ui = useUiStore()

/** The shown plugin's own status (ui.status), above its panel. */
const NOTE_DOT = { ok: 'bg-ok', warn: 'bg-warn', error: 'bg-danger', busy: 'bg-accent', neutral: 'bg-fg-faint' } as const

function openSettings() {
  ui.settingsSection = 'plugins'
  ui.settingsOpen = true
}
</script>

<template>
  <div class="flex flex-1 flex-col min-h-0">
    <div
      v-if="plugins.shownPanel?.panel && plugins.shownPanel.note"
      class="text-[12px] mx-3 mt-2.5 px-2.5 py-1.5 rounded-[var(--radius-md)] bg-fg/4 flex shrink-0 gap-2 items-baseline"
      role="status"
    >
      <span class="rounded-full shrink-0 h-1.5 w-1.5 self-center" :class="[NOTE_DOT[plugins.shownPanel.note.tone ?? 'neutral'], plugins.shownPanel.note.tone === 'busy' && 'animate-pulse']" />
      <span class="text-fg font-medium shrink-0">{{ plugins.shownPanel.note.text }}</span>
      <span v-if="plugins.shownPanel.note.detail" class="text-fg-faint truncate">{{ plugins.shownPanel.note.detail }}</span>
    </div>
    <PluginPanelHost v-if="plugins.shownPanel?.panel" :key="plugins.shownPanel.manifest.id" :panel="plugins.shownPanel.panel" :plugin-id="plugins.shownPanel.manifest.id" />
    <div v-else class="p-6 flex flex-1 flex-col gap-3 items-center justify-center">
      <UiEmpty icon="i-carbon-application" title="No plugin panels" description="Switched-on plugins that have a panel show up here." size="sm" />
      <UiButton icon="i-carbon-settings" @click="openSettings">
        Plugins in Settings
      </UiButton>
    </div>
  </div>
</template>
