<script setup lang="ts">
import type { RestoreResult, StorageInventory } from '~/lib/backup'
import { computed, onMounted, ref } from 'vue'
import { createBackup, downloadBackup, inventory, restoreBackup } from '~/lib/backup'

const busy = ref(false)
const result = ref<RestoreResult | null>(null)
const error = ref<string | null>(null)
const replace = ref(false)
const inv = ref<StorageInventory | null>(null)

const origin = ref(typeof location === 'undefined' ? '' : location.origin)

const hasData = computed(() =>
  !!inv.value && (inv.value.local.length > 0 || inv.value.idb.some(s => s.records > 0)),
)

/** Named entries the player keeps, so their absence is obvious at a glance. */
const EXPECTED: { key: string, label: string }[] = [
  { key: 'mwhoplayer:playlists', label: 'Playlists' },
  { key: 'mwhoplayer:stats', label: 'Stats' },
  { key: 'mwhoplayer:bookmarks', label: 'Bookmarks' },
  { key: 'mwhoplayer:starred', label: 'Starred' },
  { key: 'deviceConfig', label: 'Device settings' },
]

const found = computed(() => {
  const map = new Map((inv.value?.local ?? []).map(e => [e.key, e.bytes]))
  return EXPECTED.map(e => ({ ...e, bytes: map.get(e.key) ?? 0 }))
})

async function refresh() {
  busy.value = true
  try {
    inv.value = await inventory()
  }
  finally {
    busy.value = false
  }
}

onMounted(refresh)

async function doExport() {
  busy.value = true
  error.value = null
  result.value = null
  try {
    downloadBackup(await createBackup())
  }
  catch (e: any) {
    error.value = e?.message ?? 'Export failed'
  }
  finally {
    busy.value = false
  }
}

function doImport() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file)
      return
    busy.value = true
    error.value = null
    result.value = null
    try {
      const data = JSON.parse(await file.text())
      result.value = await restoreBackup(data, replace.value ? 'replace' : 'merge')
      await refresh()
    }
    catch (e: any) {
      error.value = e?.message ?? 'Import failed'
    }
    finally {
      busy.value = false
    }
  }
  input.click()
}

function fmtBytes(n: number) {
  return n > 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="p-3 space-y-4">
      <!-- What is actually here -->
      <section class="panel p-2.5 space-y-2">
        <div class="flex items-baseline justify-between">
          <p class="label">
            Stored on this address
          </p>
          <button class="btn-icon h-5 w-5" title="Refresh" :disabled="busy" @click="refresh">
            <div class="i-carbon-renew text-[11px]" />
          </button>
        </div>

        <p class="text-[11px] text-fg-muted font-mono break-all">
          {{ origin }}
        </p>

        <div class="pt-1 space-y-0.5">
          <div
            v-for="f in found"
            :key="f.key"
            class="text-[11px] flex gap-2 items-baseline"
          >
            <span
              class="rounded-full shrink-0 h-1.5 w-1.5"
              :class="f.bytes > 0 ? 'bg-emerald-400' : 'bg-red-400/60'"
            />
            <span :class="f.bytes > 0 ? 'text-fg-muted' : 'text-fg-faint'">{{ f.label }}</span>
            <span class="text-fg-faint font-mono ml-auto">
              {{ f.bytes > 0 ? fmtBytes(f.bytes) : 'none' }}
            </span>
          </div>
        </div>

        <div v-if="inv" class="text-[10px] text-fg-faint font-mono pt-1 border-t border-edge">
          {{ inv.local.length }} keys &middot; {{ fmtBytes(inv.totalBytes) }}
          &middot; {{ inv.idb.reduce((s, x) => s + x.records, 0) }} records
        </div>
      </section>

      <!-- Where it went -->
      <section v-if="!hasData" class="space-y-1.5">
        <p class="label text-amber-400/80">
          Nothing stored here
        </p>
        <p class="hint">
          Storage is tied to the exact address in the URL bar — scheme, host and
          port. <span class="font-mono">localhost:6969</span> and
          <span class="font-mono">127.0.0.1:6969</span> are different places to
          the browser, as is the machine's network address. If you opened one of
          the Network links Vite prints, or followed the network address for the
          phone remote, your data is still on whichever one you used before.
        </p>
        <p class="hint">
          The storage keys were deliberately kept from MWHOPlayer, so opening
          the address you used previously should bring everything straight back.
          Export it there, then import here.
        </p>
      </section>

      <section v-else class="space-y-1.5">
        <p class="hint">
          Keep a copy before changing ports or browsers. Export writes settings,
          playlists, bookmarks, stats and video metadata to one file.
        </p>
      </section>

      <!-- Actions -->
      <div class="space-y-2">
        <button class="btn-subtle text-xs py-2 w-full" :disabled="busy" @click="doExport">
          <div class="i-carbon-download" />
          Export everything
        </button>

        <button class="btn-subtle text-xs py-2 w-full" :disabled="busy" @click="doImport">
          <div class="i-carbon-upload" />
          Import a backup
        </button>

        <label class="text-[11px] text-fg-muted flex gap-2 cursor-pointer items-center">
          <input v-model="replace" type="checkbox">
          Replace instead of merging
        </label>
      </div>

      <p v-if="error" class="hint text-red-400">
        {{ error }}
      </p>

      <section v-if="result" class="panel p-2.5 space-y-1">
        <p class="label">
          Restored
        </p>
        <p class="text-xs text-fg-muted">
          {{ result.localKeys }} settings, {{ result.idbRecords }} records.
        </p>
        <p v-if="result.skipped.length" class="hint">
          Skipped: {{ result.skipped.join(', ') }}
        </p>
        <p class="hint">
          Reload for everything to take effect.
        </p>
      </section>

      <section class="pt-1 border-t border-edge space-y-1.5">
        <p class="label">
          Not covered
        </p>
        <p class="hint">
          Saved folder permissions cannot move between addresses, and browsers
          drop them between sessions — if the library is empty but the numbers
          above are not zero, re-pick the folder rather than restoring anything.
          Thumbnails are a cache and regenerate on their own.
        </p>
      </section>
    </div>
  </div>
</template>
