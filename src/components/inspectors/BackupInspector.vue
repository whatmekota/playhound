<script setup lang="ts">
import type { Backup, RestoreResult, StorageInventory } from '~/lib/backup'
import { computed, onMounted, ref } from 'vue'
import { toast } from '~/composables/useToast'
import { createBackup, downloadBackup, inventory, restoreBackup } from '~/lib/backup'

const inv = ref<StorageInventory | null>(null)
const refreshing = ref(false)
const exporting = ref(false)
const error = ref<string | null>(null)
const result = ref<RestoreResult | null>(null)

const origin = typeof location === 'undefined' ? '' : location.origin

/** Named entries the player keeps, so a missing one is obvious at a glance. */
const EXPECTED: { key: string, label: string, icon: string }[] = [
  { key: 'ph:playlists', label: 'Playlists', icon: 'i-carbon-list' },
  { key: 'ph:stats', label: 'Stats', icon: 'i-carbon-chart-bar' },
  { key: 'ph:bookmarks', label: 'Bookmarks', icon: 'i-carbon-bookmark' },
  { key: 'ph:library.starred', label: 'Starred', icon: 'i-carbon-star' },
  { key: 'ph:device.config', label: 'Device settings', icon: 'i-carbon-plug' },
]

const IDB_LABEL: Record<string, string> = {
  meta: 'Folder cache',
  playlists: 'Playlists',
  vidmeta: 'Video notes & tags',
  summaries: 'Script summaries',
}

const found = computed(() => {
  const map = new Map((inv.value?.local ?? []).map(e => [e.key, e.bytes]))
  return EXPECTED.map(e => ({ ...e, bytes: map.get(e.key) ?? 0 }))
})
const records = computed(() => inv.value?.idb.reduce((s, x) => s + x.records, 0) ?? 0)
const hasData = computed(() => !!inv.value && (inv.value.local.length > 0 || records.value > 0))

async function refresh() {
  refreshing.value = true
  try {
    inv.value = await inventory()
  }
  catch (e: any) {
    error.value = e?.message ?? 'Could not read storage'
  }
  finally {
    refreshing.value = false
  }
}
onMounted(refresh)

async function doExport() {
  exporting.value = true
  error.value = null
  try {
    downloadBackup(await createBackup())
    toast.success('Backup downloaded', { icon: 'i-carbon-download' })
  }
  catch (e: any) {
    error.value = e?.message ?? 'Export failed'
  }
  finally {
    exporting.value = false
  }
}

// ─── Import: pick, inspect, confirm, restore ─────────────────────────────────
const pending = ref<{ name: string, data: Backup } | null>(null)
const confirmOpen = ref(false)
const mode = ref<'merge' | 'replace'>('merge')
const restoring = ref(false)

const pendingSummary = computed(() => {
  const b = pending.value?.data
  if (!b)
    return null
  return {
    keys: Object.keys(b.local ?? {}).length,
    records: Object.values(b.idb ?? {}).reduce((s, r) => s + (r?.length ?? 0), 0),
    when: b._exportedAt ? new Date(b._exportedAt).toLocaleString() : 'unknown',
    from: b._origin ?? 'unknown',
    sameOrigin: b._origin === origin,
  }
})

function pickImport() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file)
      return
    error.value = null
    result.value = null
    try {
      const data = JSON.parse(await file.text()) as Backup
      if (!data || data._app !== 'playhound' || typeof data.local !== 'object')
        throw new Error('That file is not a playhound backup')
      pending.value = { name: file.name, data }
      mode.value = 'merge'
      confirmOpen.value = true
    }
    catch (e: any) {
      error.value = e instanceof SyntaxError ? 'That file is not valid JSON' : (e?.message ?? 'Could not read the file')
    }
  }
  input.click()
}

async function confirmRestore() {
  if (!pending.value)
    return
  restoring.value = true
  try {
    result.value = await restoreBackup(pending.value.data, mode.value)
    confirmOpen.value = false
    pending.value = null
    await refresh()
  }
  catch (e: any) {
    error.value = e?.message ?? 'Import failed'
    confirmOpen.value = false
  }
  finally {
    restoring.value = false
  }
}

function reload() {
  location.reload()
}

function fmtBytes(n: number) {
  if (n >= 1024 * 1024)
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  return n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`
}
</script>

<template>
  <UiPanel gap="sm">
    <!-- What is actually here -->
    <UiSection title="Stored here" icon="i-carbon-data-base">
      <template #actions>
        <UiIconButton icon="i-carbon-renew" label="Refresh" size="xs" :disabled="refreshing" @click="refresh" />
      </template>

      <p v-tip="'Storage belongs to this exact address'" class="text-[11.5px] text-fg-muted font-mono px-2 py-1.5 well break-all">
        {{ origin }}
      </p>

      <div v-if="inv" class="gap-3 grid grid-cols-3">
        <UiStat label="Keys" :value="inv.local.length" size="sm" />
        <UiStat label="Settings" :value="fmtBytes(inv.totalBytes)" size="sm" />
        <UiStat label="Records" :value="records" size="sm" />
      </div>
      <div v-else class="gap-3 grid grid-cols-3">
        <div v-for="i in 3" :key="i" class="skeleton rounded h-9" />
      </div>

      <ul class="flex flex-col gap-0.5">
        <li v-for="f in found" :key="f.key" class="text-[12.5px] flex gap-2 h-7 items-center">
          <span :class="[f.icon, f.bytes ? 'text-fg-muted' : 'text-fg-faint']" class="text-[14px] shrink-0" />
          <span :class="f.bytes ? 'text-fg' : 'text-fg-faint'" class="flex-1">{{ f.label }}</span>
          <span v-if="!inv" class="skeleton rounded h-3 w-10" />
          <UiBadge v-else-if="f.bytes" tone="ok" size="xs" dot>
            {{ fmtBytes(f.bytes) }}
          </UiBadge>
          <UiBadge v-else size="xs">
            none
          </UiBadge>
        </li>
      </ul>
    </UiSection>

    <UiSection v-if="inv" title="Details" icon="i-carbon-catalog" collapsible :open="false" :summary="`${inv.local.length + inv.idb.length} entries`">
      <div class="flex flex-col gap-2">
        <p class="eyebrow">
          Browser storage
        </p>
        <ul class="flex flex-col">
          <li v-for="e in inv.local" :key="e.key" class="text-[11.5px] flex gap-2 h-6 items-center">
            <span class="text-fg-muted font-mono flex-1 truncate">{{ e.key }}</span>
            <span class="text-fg-faint num">{{ fmtBytes(e.bytes) }}</span>
          </li>
        </ul>
        <p class="eyebrow mt-1">
          Database
        </p>
        <ul class="flex flex-col">
          <li v-for="s in inv.idb" :key="s.store" class="text-[11.5px] flex gap-2 h-6 items-center">
            <span class="text-fg-muted flex-1 truncate">{{ IDB_LABEL[s.store] ?? s.store }}</span>
            <span class="text-fg-faint num">{{ s.records }}</span>
          </li>
        </ul>
      </div>
    </UiSection>

    <!-- Nothing here: the usual cause is a different address -->
    <div v-if="inv && !hasData" class="p-3 border border-warn/25 rounded-[var(--radius-lg)] bg-warn/8 flex flex-col gap-2 animate-rise">
      <p class="text-[13px] text-warn font-medium flex gap-2 items-center">
        <span class="i-carbon-warning-alt" />
        Nothing stored on this address
      </p>
      <p class="hint">
        Storage is tied to the exact address in the URL bar — scheme, host and port.
        <span class="font-mono">localhost:6969</span> and <span class="font-mono">127.0.0.1:6969</span>
        are different places to the browser, as is the machine's network address. If you opened one of
        the Network links Vite prints, or followed the address for the phone remote, your data is still
        on whichever one you used before.
      </p>
      <p class="hint">
        The storage keys were deliberately kept from MWHOPlayer, so opening the address you used
        previously brings everything back. Export there, then import here.
      </p>
    </div>

    <!-- Back up / restore -->
    <UiSection title="Back up" icon="i-carbon-data-backup">
      <p class="hint">
        One file with settings, playlists, bookmarks, stats and video notes. Keep a copy before
        changing ports or browsers.
      </p>
      <div class="gap-2 grid grid-cols-2">
        <UiButton variant="primary" icon="i-carbon-download" :loading="exporting" :disabled="!hasData" @click="doExport">
          Export
        </UiButton>
        <UiButton icon="i-carbon-upload" :disabled="restoring" @click="pickImport">
          Import…
        </UiButton>
      </div>

      <Transition name="t-fade">
        <p v-if="error" class="text-[12px] text-danger flex gap-1.5 items-start">
          <span class="i-carbon-warning-filled mt-0.5 shrink-0" />
          {{ error }}
        </p>
      </Transition>

      <Transition name="t-slide-up">
        <div v-if="result" class="p-3 border border-ok/25 rounded-[var(--radius-md)] bg-ok/8 flex flex-col gap-2">
          <p class="text-[13px] text-ok font-medium flex gap-2 items-center">
            <span class="i-carbon-checkmark-filled" />
            Restored {{ result.localKeys }} settings and {{ result.idbRecords }} records
          </p>
          <p v-if="result.skipped.length" class="hint">
            Skipped: {{ result.skipped.join(', ') }}
          </p>
          <div class="flex gap-2 items-center">
            <span class="hint flex-1">Reload for everything to take effect.</span>
            <UiButton size="xs" variant="primary" icon="i-carbon-renew" @click="reload">
              Reload
            </UiButton>
          </div>
        </div>
      </Transition>
    </UiSection>

    <UiSection title="Not covered" icon="i-carbon-information" collapsible :open="false">
      <p class="hint">
        Saved folder permissions cannot move between addresses, and browsers drop them between
        sessions — if the library is empty but the numbers above are not zero, re-pick the folder
        rather than restoring anything. Thumbnails are a cache and regenerate on their own.
      </p>
    </UiSection>

    <!-- Confirm import -->
    <UiModal
      v-model:open="confirmOpen"
      title="Import backup"
      :subtitle="pending?.name"
      icon="i-carbon-upload"
      width="440px"
      :persistent="restoring"
    >
      <div v-if="pendingSummary" class="flex flex-col gap-4">
        <div class="p-3 well gap-3 grid grid-cols-2">
          <UiStat label="Settings" :value="pendingSummary.keys" size="sm" />
          <UiStat label="Records" :value="pendingSummary.records" size="sm" />
          <div class="flex flex-col gap-0.5 col-span-2">
            <span class="eyebrow">Exported</span>
            <span class="text-[12.5px] text-fg">{{ pendingSummary.when }}</span>
            <span class="text-[11.5px] text-fg-muted font-mono flex flex-wrap gap-2 break-all items-center">
              {{ pendingSummary.from }}
              <UiBadge v-if="pendingSummary.sameOrigin" size="xs">this address</UiBadge>
              <UiBadge v-else tone="info" size="xs">another address</UiBadge>
            </span>
          </div>
        </div>

        <UiSegmented
          v-model="mode"
          block
          :options="[
            { value: 'merge', label: 'Merge', icon: 'i-carbon-add' },
            { value: 'replace', label: 'Replace', icon: 'i-carbon-renew' },
          ]"
        />
        <p class="hint -mt-2">
          <template v-if="mode === 'merge'">
            Entries in the backup overwrite the same entries here; everything else stays.
          </template>
          <template v-else>
            <span class="text-danger">Clears this app's settings on this address first</span>, so the result
            matches the backup exactly. Database records are still merged.
          </template>
        </p>
      </div>
      <template #footer>
        <UiButton variant="ghost" :disabled="restoring" @click="confirmOpen = false">
          Cancel
        </UiButton>
        <UiButton :variant="mode === 'replace' ? 'danger' : 'primary'" :loading="restoring" icon="i-carbon-upload" @click="confirmRestore">
          {{ mode === 'replace' ? 'Replace and import' : 'Import' }}
        </UiButton>
      </template>
    </UiModal>
  </UiPanel>
</template>
