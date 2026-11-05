<script setup lang="ts">
import type { PluginInfo } from '~/stores/pluginStore'
import { ref, watch } from 'vue'
import PluginSettingsForm from '~/components/plugins/PluginSettingsForm.vue'
import PluginSources from '~/components/plugins/PluginSources.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { toast } from '~/composables/useToast'
import { usePluginStore } from '~/stores/pluginStore'
import { useUiStore } from '~/stores/uiStore'

/** Settings → Plugins: install from a zip, switch on and off, configure, remove. */
const store = usePluginStore()
const ui = useUiStore()
const fileEl = ref<HTMLInputElement | null>(null)
const installing = ref(false)
const dragging = ref(false)

/** Which plugins are open. Collapsed by default, so a long list stays a list. */
const open = ref<Set<string>>(new Set())
const isOpen = (id: string) => open.value.has(id)
// A plugin's own "Settings" link: open its card.
watch(() => store.focusSettings, (id) => {
  if (id) {
    open.value = new Set([...open.value, id])
    store.focusSettings = null
  }
}, { immediate: true })
function toggle(id: string) {
  const next = new Set(open.value)
  if (!next.delete(id))
    next.add(id)
  open.value = next
}

async function installFile(file: File | undefined) {
  if (!file)
    return
  installing.value = true
  try {
    const p = await store.install(file)
    open.value = new Set([...open.value, p.manifest.id])
    toast.success(`Installed ${p.manifest.name} ${p.manifest.version}`, {
      icon: 'i-carbon-application',
      detail: p.enabled ? undefined : 'Switch it on to use it',
    })
  }
  catch (err) {
    toast.error(`Couldn't install ${file.name}`, { detail: err instanceof Error ? err.message : String(err) })
  }
  finally {
    installing.value = false
    if (fileEl.value)
      fileEl.value.value = ''
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false
  const f = [...(e.dataTransfer?.files ?? [])].find(f => /\.zip$/i.test(f.name))
  void installFile(f)
}

const confirmRemove = ref<string | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | null = null
async function remove(p: PluginInfo) {
  const id = p.manifest.id
  if (confirmRemove.value !== id) {
    confirmRemove.value = id
    if (confirmTimer)
      clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => (confirmRemove.value = null), 3500)
    return
  }
  confirmRemove.value = null
  await store.remove(id)
  toast(`Removed ${p.manifest.name}`, { icon: 'i-carbon-application' })
}

function openPanel(id: string) {
  store.activePanel = id
  ui.settingsOpen = false
  ui.openInspector('plugins')
}

const STATUS: Record<PluginInfo['status'], { label: string, tone: 'ok' | 'info' | 'danger' | 'neutral' }> = {
  on: { label: 'On', tone: 'ok' },
  loading: { label: 'Starting', tone: 'info' },
  error: { label: 'Failed', tone: 'danger' },
  off: { label: 'Off', tone: 'neutral' },
}
const kb = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="hint text-warn/90 m-0 flex gap-1.5 items-start">
      <span class="i-carbon-warning-alt text-[14px] mt-px shrink-0" />
      A plugin runs inside playhound with the same access playhound has, including your device. Install only ones you trust.
    </p>

    <PluginSources @installed="id => (open = new Set([...open, id]))" />

    <div v-for="p in store.plugins" :key="p.manifest.id" class="card flex flex-col">
      <!-- Header: always visible. Click to open; the switch works on its own. -->
      <div class="px-4 py-3 flex gap-3 items-center">
        <button
          type="button"
          class="text-left focusable rounded-[var(--radius-sm)] flex flex-1 gap-2.5 min-w-0 items-center"
          :aria-expanded="isOpen(p.manifest.id)"
          @click="toggle(p.manifest.id)"
        >
          <span class="i-carbon-chevron-right text-[14px] text-fg-faint shrink-0 transition-transform duration-150" :class="isOpen(p.manifest.id) && 'rotate-90'" />
          <span class="flex flex-1 flex-col gap-0.5 min-w-0">
            <span class="flex gap-2 min-w-0 items-center">
              <span class="text-[14px] text-fg font-medium truncate">{{ p.manifest.name }}</span>
              <span class="text-[11.5px] text-fg-faint num shrink-0">{{ p.manifest.version }}</span>
              <UiBadge :tone="STATUS[p.status].tone" size="xs" dot class="shrink-0">
                {{ STATUS[p.status].label }}
              </UiBadge>
            </span>
            <span v-if="p.manifest.description && !isOpen(p.manifest.id)" class="hint truncate">{{ p.manifest.description }}</span>
          </span>
        </button>
        <span v-tip="p.enabled ? 'Switch off' : 'Switch on'" class="shrink-0">
          <UiSwitch :model-value="p.enabled" @update:model-value="store.setEnabled(p.manifest.id, $event)" />
        </span>
      </div>
      <p v-if="p.error" class="text-[12px] text-danger mx-4 mb-3 mt-0 px-2.5 py-2 rounded-[var(--radius-md)] bg-danger/10">
        {{ p.error }}
      </p>

      <div v-if="isOpen(p.manifest.id)" class="px-4 pb-4 pt-3 border-t border-edge flex flex-col gap-3">
        <div class="flex flex-col gap-0.5">
          <span v-if="p.manifest.description" class="hint">{{ p.manifest.description }}</span>
          <span class="text-[11px] text-fg-faint">
            {{ p.manifest.id }}<template v-if="p.manifest.author"> · {{ p.manifest.author }}</template> · {{ kb(p.size) }}
          </span>
        </div>
        <PluginSettingsForm v-if="p.status === 'on' && p.fields?.length" :plugin="p" />
        <p v-else-if="p.status !== 'on'" class="hint m-0">
          Switch it on to see its settings.
        </p>
        <div class="flex flex-wrap gap-2">
          <UiButton v-if="p.status === 'on' && p.panel" icon="i-carbon-side-panel-open" @click="openPanel(p.manifest.id)">
            Open panel
          </UiButton>
          <UiButton variant="danger" icon="i-carbon-trash-can" class="ml-auto" @click="remove(p)">
            {{ confirmRemove === p.manifest.id ? 'Click again to remove' : 'Remove' }}
          </UiButton>
        </div>
      </div>
    </div>

    <p v-if="!store.plugins.length" class="hint m-0">
      No plugins installed.
    </p>

    <div
      class="p-4 border rounded-[var(--radius-lg)] border-dashed flex gap-3 transition-colors items-center"
      :class="dragging ? 'border-accent bg-accent-soft' : 'border-edge-strong'"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <span class="text-accent-300 rounded-[var(--radius-md)] bg-accent-soft center shrink-0 h-10 w-10">
        <span class="i-carbon-application text-[19px]" />
      </span>
      <div class="flex flex-1 flex-col gap-0.5 min-w-0">
        <span class="text-[13.5px] text-fg font-medium">Install from a file</span>
        <span class="hint">A plugin .zip from anywhere else: drop it here, or pick it. Installing one that is already here updates it.</span>
      </div>
      <UiButton variant="primary" icon="i-carbon-upload" :loading="installing" @click="fileEl?.click()">
        Install from zip
      </UiButton>
      <input ref="fileEl" type="file" accept=".zip,application/zip" class="hidden" @change="installFile(($event.target as HTMLInputElement).files?.[0])">
    </div>
  </div>
</template>
