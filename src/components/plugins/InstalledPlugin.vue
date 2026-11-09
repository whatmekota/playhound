<script setup lang="ts">
import type { ImageRef } from '~/plugins/storeCache'
import type { PluginInfo } from '~/stores/pluginStore'
import { ref, watch } from 'vue'
import PluginIcon from '~/components/plugins/PluginIcon.vue'
import PluginPermissions from '~/components/plugins/PluginPermissions.vue'
import PluginSettingsForm from '~/components/plugins/PluginSettingsForm.vue'
import TrustMark from '~/components/plugins/TrustMark.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { toast } from '~/composables/useToast'
import { trustOf } from '~/plugins/sources'
import { checkImage, readStoreFields } from '~/plugins/storeMeta'
import { usePluginStore } from '~/stores/pluginStore'
import { useUiStore } from '~/stores/uiStore'

/**
 * An installed plugin (or one loaded from a folder): its switch, and, opened,
 * what it may do, its settings, and Remove. A folder plugin also shows what
 * the store would make of its manifest, for its author.
 */
const props = defineProps<{ plugin: PluginInfo, expanded: boolean, icon: ImageRef | null, hasDetails: boolean }>()
const emit = defineEmits<{ toggle: [], details: [] }>()
const store = usePluginStore()
const ui = useUiStore()

const p = () => props.plugin

const confirmRemove = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null
async function remove() {
  const info = p()
  if (info.dev) {
    // Nothing is deleted: its folder, settings and data stay.
    await store.unloadDev(info.manifest.id)
    toast(`Unloaded ${info.manifest.name}`, { icon: 'i-carbon-folder' })
    return
  }
  if (!confirmRemove.value) {
    confirmRemove.value = true
    if (confirmTimer)
      clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => (confirmRemove.value = false), 3500)
    return
  }
  confirmRemove.value = false
  await store.remove(info.manifest.id)
  toast(`Removed ${info.manifest.name}`, { icon: 'i-carbon-application' })
}

function openPanel() {
  store.activePanel = p().manifest.id
  ui.settingsOpen = false
  ui.openInspector('plugins')
}

const reloading = ref(false)
async function reload() {
  reloading.value = true
  try {
    await store.reloadDev(p().manifest.id)
  }
  finally {
    reloading.value = false
  }
}

// ─── Store listing check, for a plugin's author ─────────────────────────────
const listing = ref<string[]>([])
watch(() => [props.plugin, props.expanded] as const, async ([info, open]) => {
  listing.value = []
  if (!info.dev || !open)
    return
  const problems: string[] = []
  try {
    const raw = JSON.parse(await (await store.pluginFile(info.manifest.id, 'manifest.json'))!.text())
    problems.push(...readStoreFields(raw).problems)
  }
  catch {}
  const look = async (file: string, role: 'icon' | 'screenshot') => {
    const blob = await store.pluginFile(info.manifest.id, file)
    if (!blob)
      return problems.push(`${file} is not in the folder (the store looks for it in the release; the installed plugin, in the zip)`)
    const check = checkImage(new Uint8Array(await blob.arrayBuffer()), role)
    if (!check.ok)
      problems.push(`${file}: ${check.problem}`)
  }
  if (info.manifest.icon)
    await look(info.manifest.icon, 'icon')
  for (const s of info.manifest.screenshots ?? [])
    await look(s.file, 'screenshot')
  if (props.plugin === info)
    listing.value = problems
}, { immediate: true })

const STATUS: Record<PluginInfo['status'], { label: string, tone: 'ok' | 'info' | 'danger' | 'neutral' }> = {
  on: { label: 'On', tone: 'ok' },
  loading: { label: 'Starting', tone: 'info' },
  error: { label: 'Failed', tone: 'danger' },
  off: { label: 'Off', tone: 'neutral' },
}
const kb = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
</script>

<template>
  <div class="card flex flex-col">
    <!-- Header: always visible. Click to open; the switch works on its own. -->
    <div class="px-3.5 py-3 flex gap-3 items-center">
      <button
        type="button"
        class="text-left focusable rounded-[var(--radius-sm)] flex flex-1 gap-3 min-w-0 items-center"
        :aria-expanded="expanded"
        @click="emit('toggle')"
      >
        <PluginIcon :id="plugin.manifest.id" :name="plugin.manifest.name" :image="icon" :size="36" />
        <span class="flex flex-1 flex-col gap-0.5 min-w-0">
          <span class="flex gap-2 min-w-0 items-center">
            <span class="text-[13.5px] text-fg font-medium truncate">{{ plugin.manifest.name }}</span>
            <TrustMark v-if="plugin.source" :trust="trustOf(plugin.source)" />
            <span class="text-[11.5px] text-fg-faint num shrink-0">{{ plugin.manifest.version }}</span>
            <UiBadge v-if="plugin.dev" v-tip="'Loaded from a folder; reloads when you save'" tone="accent" size="xs" class="shrink-0">
              dev
            </UiBadge>
            <UiBadge :tone="STATUS[plugin.status].tone" size="xs" dot class="shrink-0">
              {{ STATUS[plugin.status].label }}
            </UiBadge>
          </span>
          <span v-if="plugin.manifest.description && !expanded" class="hint truncate">{{ plugin.manifest.description }}</span>
        </span>
        <span class="i-carbon-chevron-down text-[14px] text-fg-faint shrink-0 transition-transform duration-150" :class="expanded && 'rotate-180'" />
      </button>
      <span v-tip="plugin.enabled ? 'Switch off' : 'Switch on'" class="shrink-0">
        <UiSwitch :model-value="plugin.enabled" @update:model-value="store.setEnabled(plugin.manifest.id, $event)" />
      </span>
    </div>
    <p v-if="plugin.error" class="text-[12px] text-danger mx-3.5 mb-3 mt-0 px-2.5 py-2 rounded-[var(--radius-md)] bg-danger/10">
      {{ plugin.error }}
    </p>
    <p v-if="plugin.dev?.error" class="text-[12px] text-warn mx-3.5 mb-3 mt-0 px-2.5 py-2 rounded-[var(--radius-md)] bg-warn/10">
      Reload failed, still running the version before: {{ plugin.dev.error }}
    </p>

    <div v-if="expanded" class="px-3.5 pb-4 pt-3 border-t border-edge flex flex-col gap-3">
      <div class="flex flex-col gap-0.5">
        <span v-if="plugin.manifest.description" class="hint">{{ plugin.manifest.description }}</span>
        <span class="text-[11px] text-fg-faint">
          {{ plugin.manifest.id }}<template v-if="plugin.manifest.author"> · {{ plugin.manifest.author }}</template> · {{ kb(plugin.size) }}<template v-if="plugin.source"> · {{ plugin.source }}</template>
        </span>
        <span v-if="plugin.dev" class="text-[11px] text-fg-faint flex gap-1 min-w-0 items-center">
          <span class="i-carbon-folder text-[12px] shrink-0" />
          <span class="truncate">{{ plugin.dev.label }}</span>
        </span>
      </div>
      <PluginPermissions :manifest="plugin.manifest" />
      <PluginSettingsForm v-if="plugin.status === 'on' && plugin.fields?.length" :plugin="plugin" />
      <p v-else-if="plugin.status !== 'on'" class="hint m-0">
        Switch it on to see its settings.
      </p>
      <div v-if="plugin.dev" class="px-3 py-2.5 rounded-[var(--radius-md)] flex flex-col gap-1" :class="listing.length ? 'bg-warn/8' : 'bg-fg/4'">
        <span class="text-[12px] font-medium" :class="listing.length ? 'text-warn' : 'text-fg-muted'">
          {{ listing.length ? 'Store listing: worth a look' : 'Store listing: looks right' }}
        </span>
        <ul v-if="listing.length" class="text-[11.5px] text-fg-muted m-0 pl-4 list-disc">
          <li v-for="(l, i) in listing" :key="i">
            {{ l }}
          </li>
        </ul>
        <span v-else class="hint">Its icon, screenshots and other store fields read fine. See docs/plugins.md, “The store listing”.</span>
      </div>
      <div class="flex flex-wrap gap-2">
        <UiButton v-if="plugin.status === 'on' && plugin.panel" icon="i-carbon-side-panel-open" @click="openPanel">
          Open panel
        </UiButton>
        <UiButton v-if="hasDetails" icon="i-carbon-information" @click="emit('details')">
          Details
        </UiButton>
        <UiButton v-if="plugin.dev" icon="i-carbon-renew" :loading="reloading" @click="reload">
          Reload
        </UiButton>
        <UiButton v-if="plugin.dev" v-tip="'Its folder, settings and data stay'" icon="i-carbon-folder-off" class="ml-auto" @click="remove">
          Unload
        </UiButton>
        <UiButton v-else variant="danger" icon="i-carbon-trash-can" class="ml-auto" @click="remove">
          {{ confirmRemove ? 'Click again to remove' : 'Remove' }}
        </UiButton>
      </div>
    </div>
  </div>
</template>
