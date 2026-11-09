<script setup lang="ts">
import type { StoreEntry } from '~/plugins/storeEntry'
import type { PluginCategory } from '~/plugins/storeMeta'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import InstalledPlugin from '~/components/plugins/InstalledPlugin.vue'
import PluginIcon from '~/components/plugins/PluginIcon.vue'
import PluginPermissions from '~/components/plugins/PluginPermissions.vue'
import StoreCard from '~/components/plugins/StoreCard.vue'
import StoreDetail from '~/components/plugins/StoreDetail.vue'
import StoreMarkdown from '~/components/plugins/StoreMarkdown.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiSelect from '~/components/ui/UiSelect.vue'
import UiTabs from '~/components/ui/UiTabs.vue'
import { toast } from '~/composables/useToast'
import { buildEntries, iconRef } from '~/plugins/storeEntry'
import { ago, CATEGORIES, matchesQuery } from '~/plugins/storeMeta'
import { usePluginStore } from '~/stores/pluginStore'

/**
 * Settings → Plugins: the store (plugins from the GitHub repositories the
 * user follows), the installed plugins with their switches and settings, and
 * the updates waiting. Also: install from a zip, and, for writing one, load a
 * plugin from a folder. Nothing installs or updates without a click.
 */
const store = usePluginStore()
const root = ref<HTMLElement | null>(null)

type Tab = 'discover' | 'installed' | 'updates'
const tab = ref<Tab>(store.plugins.length ? 'installed' : 'discover')
const query = ref('')
const category = ref<'all' | PluginCategory>('all')
const detailKey = ref<string | null>(null)

const entries = computed(() => buildEntries(store.sourceList, store.sources, store.plugins))
const byInstalledId = computed(() => new Map(entries.value.filter(e => e.installed).map(e => [e.installed!.manifest.id, e])))
const updates = computed(() => entries.value.filter(e => e.update))
const detail = computed(() => entries.value.find(e => e.key === detailKey.value) ?? null)

const searchable = (e: StoreEntry) => ({ name: e.name, repo: e.repo, description: e.description, author: e.author, category: e.category ?? undefined, keywords: e.manifest?.keywords })
const fits = (e: StoreEntry) => (category.value === 'all' || e.category === category.value) && matchesQuery(searchable(e), query.value)

const discover = computed(() => entries.value
  .filter(e => !e.key.startsWith('local:') && fits(e))
  // Ones that can't be had sink to the end.
  .sort((a, b) => Number(!a.release) - Number(!b.release) || a.name.localeCompare(b.name)))
const installed = computed(() => store.plugins.filter((p) => {
  const e = byInstalledId.value.get(p.manifest.id)
  return e ? fits(e) : matchesQuery({ name: p.manifest.name, description: p.manifest.description }, query.value) && category.value === 'all'
}))
const filtering = computed(() => !!query.value.trim() || category.value !== 'all')

const TABS = computed(() => [
  { value: 'discover' as const, label: 'Discover', icon: 'i-carbon-apps' },
  { value: 'installed' as const, label: 'Installed', icon: 'i-carbon-checkmark-outline', badge: store.plugins.length || undefined },
  { value: 'updates' as const, label: 'Updates', icon: 'i-carbon-upgrade', badge: updates.value.length || undefined },
])
const CATEGORY_OPTIONS = [{ value: 'all' as const, label: 'All categories' }, ...CATEGORIES.map(c => ({ value: c.id, label: c.label }))]

// What's kept shows at once; a check runs if the last one is a while ago.
onMounted(() => void store.refreshSources().catch(() => {}))
async function checkNow() {
  await store.checkSources()
  if (!updates.value.length && tab.value === 'updates')
    toast('Everything is up to date', { icon: 'i-carbon-checkmark' })
}
// Shown in the Updates tab: re-reads the clock now and then.
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 30_000)
onBeforeUnmount(() => clearInterval(clock))
const lastChecked = computed(() => (store.checkedAt ? ago(store.checkedAt, now.value) : 'never'))

// ─── Going places ────────────────────────────────────────────────────────────
function top() {
  void nextTick(() => root.value?.scrollIntoView({ block: 'start' }))
}
function openDetail(key: string) {
  detailKey.value = key
  top()
}
function closeDetail() {
  detailKey.value = null
  top()
}
watch(tab, () => (detailKey.value = null))

/** Which installed plugins are open. Collapsed by default, so a long list stays a list. */
const open = ref<Set<string>>(new Set())
function toggle(id: string) {
  const next = new Set(open.value)
  if (!next.delete(id))
    next.add(id)
  open.value = next
}
async function reveal(id: string) {
  open.value = new Set([...open.value, id])
  tab.value = 'installed'
  detailKey.value = null
  query.value = ''
  category.value = 'all'
  await nextTick()
  root.value?.querySelector(`[data-plugin="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}
// A plugin's own "Settings" link: open its card.
watch(() => store.focusSettings, (id) => {
  if (id) {
    void reveal(id)
    store.focusSettings = null
  }
}, { immediate: true })
watch(() => store.focusTab, (t) => {
  if (t) {
    tab.value = t
    store.focusTab = null
  }
}, { immediate: true })

// ─── Install and update ──────────────────────────────────────────────────────
// An install waiting for a yes is shown at the top; leaving the page says no.
const confirmEl = ref<HTMLElement | null>(null)
watch(() => store.pendingInstall, async (p) => {
  if (p) {
    await nextTick()
    confirmEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
})
onBeforeUnmount(() => store.answerInstall(false))
const pendingEntry = computed(() => {
  const m = store.pendingInstall?.manifest
  return m ? entries.value.find(e => e.manifest?.id === m.id) ?? null : null
})

const busy = ref<string | null>(null)
async function get(e: StoreEntry) {
  if (!e.repo)
    return
  busy.value = e.key
  const was = !!e.installed
  try {
    const p = await store.installFromSource(e.repo)
    if (!p)
      return
    toast.success(was ? `Updated ${p.manifest.name} to ${p.manifest.version}` : `Installed ${p.manifest.name} ${p.manifest.version}`, {
      icon: 'i-carbon-application',
      detail: p.enabled ? undefined : 'Switch it on to use it',
      action: p.enabled ? undefined : { label: 'Switch on', run: () => void store.setEnabled(p.manifest.id, true) },
    })
  }
  catch (err) {
    toast.error(`Couldn't get ${e.name}`, { detail: err instanceof Error ? err.message : String(err) })
  }
  finally {
    busy.value = null
  }
}
async function updateAll() {
  for (const e of updates.value.filter(u => !u.problem))
    await get(e)
}

// ─── Following a repository ─────────────────────────────────────────────────
const addOpen = ref(false)
const addInput = ref('')
const addError = ref('')
const adding = ref(false)
const addEl = ref<InstanceType<typeof UiInput> | null>(null)
async function showAdd() {
  addOpen.value = true
  tab.value = 'discover'
  detailKey.value = null
  await nextTick()
  addEl.value?.focus()
}
watch(addInput, () => (addError.value = ''))
async function add() {
  adding.value = true
  addError.value = ''
  try {
    const repo = await store.addSource(addInput.value)
    addInput.value = ''
    addOpen.value = false
    openDetail(repo)
  }
  catch (err) {
    addError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    adding.value = false
  }
}

// ─── From a file ─────────────────────────────────────────────────────────────
const fileEl = ref<HTMLInputElement | null>(null)
const installing = ref(false)
const dragging = ref(false)
async function installFile(file: File | undefined) {
  if (!file)
    return
  installing.value = true
  try {
    const p = await store.install(file)
    if (!p)
      return
    void reveal(p.manifest.id)
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

// ─── Dev mode ────────────────────────────────────────────────────────────────
const loadingFolder = ref(false)
async function loadFolder() {
  loadingFolder.value = true
  try {
    const p = await store.loadFromFolder()
    if (p) {
      void reveal(p.manifest.id)
      toast.success(`Loaded ${p.manifest.name} from its folder`, { icon: 'i-carbon-folder', detail: 'It reloads when you save a file in it' })
    }
  }
  catch (err) {
    toast.error('Couldn\'t load that folder', { detail: err instanceof Error ? err.message : String(err) })
  }
  finally {
    loadingFolder.value = false
  }
}
async function retry(key: string) {
  try {
    const p = await store.retryDev(key)
    void reveal(p.manifest.id)
  }
  catch (err) {
    toast.error('Couldn\'t load that folder', { detail: err instanceof Error ? err.message : String(err) })
  }
}
</script>

<template>
  <div ref="root" class="flex flex-col gap-4 scroll-mt-5">
    <!-- An install waiting for the user's yes -->
    <div v-if="store.pendingInstall" ref="confirmEl" class="p-4 card flex flex-col gap-3 ring-1 ring-accent/50" role="group" aria-label="Confirm install">
      <div class="flex gap-3 items-start">
        <PluginIcon
          :id="store.pendingInstall.manifest.id"
          :name="store.pendingInstall.manifest.name"
          :image="pendingEntry ? iconRef(pendingEntry, store.pluginFile) : null"
          :size="40"
        />
        <div class="flex flex-1 flex-col gap-0.5 min-w-0">
          <span class="text-[14px] text-fg font-medium">
            {{ store.pendingInstall.was ? `Update ${store.pendingInstall.manifest.name} to ${store.pendingInstall.manifest.version}?` : `Install ${store.pendingInstall.manifest.name} ${store.pendingInstall.manifest.version}?` }}
          </span>
          <span v-if="store.pendingInstall.manifest.description" class="hint">{{ store.pendingInstall.manifest.description }}</span>
          <span v-if="store.pendingInstall.was" class="hint">This version asks for more than the one installed.</span>
        </div>
      </div>
      <PluginPermissions :manifest="store.pendingInstall.manifest" :added="store.pendingInstall.was ? store.pendingInstall.added : undefined" />
      <p v-if="!pendingEntry?.trust" class="text-[12px] text-warn m-0 flex gap-1.5 items-start">
        <span class="i-carbon-warning-alt text-[14px] mt-px shrink-0" />
        Not reviewed by playhound. A plugin runs inside playhound, with access to your device; install only ones you trust.
      </p>
      <div class="flex gap-2 justify-end">
        <UiButton @click="store.answerInstall(false)">
          Cancel
        </UiButton>
        <UiButton variant="primary" :icon="store.pendingInstall.was ? 'i-carbon-upgrade' : 'i-carbon-download'" @click="store.answerInstall(true)">
          {{ store.pendingInstall.was ? 'Update' : 'Install' }}
        </UiButton>
      </div>
    </div>

    <!-- One plugin -->
    <StoreDetail
      v-if="detail"
      :entry="detail"
      :busy="busy === detail.key"
      :disabled="!!busy"
      @back="closeDetail"
      @get="get(detail)"
      @settings="reveal"
    />

    <template v-else>
      <div class="flex flex-wrap gap-x-3 gap-y-2 items-end">
        <UiTabs v-model="tab" :tabs="TABS" class="flex-1 min-w-[280px]" />
      </div>

      <!-- Search and filter, for the store and the installed list -->
      <div v-if="tab !== 'updates'" class="flex flex-wrap gap-2 items-center">
        <div class="flex-1 min-w-[200px]">
          <UiInput v-model="query" placeholder="Search plugins" icon="i-carbon-search" clearable size="sm" />
        </div>
        <UiSelect v-model="category" :options="CATEGORY_OPTIONS" />
        <template v-if="tab === 'discover'">
          <UiIconButton icon="i-carbon-renew" label="Check again" :disabled="store.checking" :class="store.checking && 'animate-spin'" @click="store.checkSources()" />
          <UiButton icon="i-carbon-logo-github" :active="addOpen" @click="addOpen ? (addOpen = false) : showAdd()">
            Add from GitHub
          </UiButton>
        </template>
      </div>

      <!-- Discover -->
      <template v-if="tab === 'discover'">
        <form v-if="addOpen" class="p-3.5 card flex flex-col gap-2 animate-rise" @submit.prevent="add">
          <div class="flex flex-col gap-0.5">
            <span class="text-[13px] text-fg font-medium">Add a plugin from GitHub</span>
            <span class="hint">Any repository whose releases carry a playhound plugin: paste <code class="num">owner/repo</code> or its github.com link. Its latest release shows here, and updates with it.</span>
          </div>
          <div class="flex gap-2 items-center">
            <UiInput ref="addEl" v-model="addInput" class="flex-1" placeholder="owner/repo or https://github.com/owner/repo" size="sm" icon="i-carbon-logo-github" @escape="addOpen = false" />
            <UiButton type="submit" variant="primary" :loading="adding" :disabled="!addInput.trim()">
              Add
            </UiButton>
          </div>
          <p v-if="addError" class="text-[12px] text-danger m-0 flex gap-1.5 items-start" role="alert">
            <span class="i-carbon-warning-alt text-[14px] mt-px shrink-0" />{{ addError }}
          </p>
        </form>

        <div v-if="discover.length" class="store-grid gap-3 grid">
          <StoreCard
            v-for="e in discover"
            :key="e.key"
            :entry="e"
            :busy="busy === e.key"
            :disabled="!!busy"
            @open="openDetail(e.key)"
            @get="get(e)"
          />
          <button
            v-if="!filtering && !addOpen"
            type="button"
            class="text-fg-muted p-4 focusable border border-edge-strong rounded-[var(--radius-lg)] border-dashed flex flex-col gap-1.5 min-h-[132px] transition-colors items-center justify-center hover:text-fg hover:border-accent/60 hover:bg-accent-soft"
            @click="showAdd"
          >
            <span class="i-carbon-add text-[20px]" />
            <span class="text-[12.5px] font-medium">Add from GitHub</span>
            <span class="hint text-center">A plugin someone else made</span>
          </button>
        </div>
        <UiEmpty v-else-if="filtering" size="sm" icon="i-carbon-search" title="Nothing matches" description="Try other words, or all categories." />
        <UiEmpty v-else size="sm" icon="i-carbon-apps" title="No plugin sources" description="Follow a GitHub repository that publishes a playhound plugin, and it shows here.">
          <UiButton variant="primary" icon="i-carbon-logo-github" @click="showAdd">
            Add from GitHub
          </UiButton>
        </UiEmpty>

        <p class="hint m-0 flex gap-1.5 items-start">
          <span class="i-carbon-warning-alt text-[13px] text-warn mt-px shrink-0" />
          A plugin runs inside playhound with the access it asks for, and there is no sandbox. The check marks playhound's own; anything else isn't reviewed.
        </p>
      </template>

      <!-- Installed -->
      <template v-else-if="tab === 'installed'">
        <InstalledPlugin
          v-for="p in installed"
          :key="p.manifest.id"
          :data-plugin="p.manifest.id"
          :plugin="p"
          :expanded="open.has(p.manifest.id)"
          :icon="byInstalledId.get(p.manifest.id) ? iconRef(byInstalledId.get(p.manifest.id)!, store.pluginFile) : null"
          :has-details="!!byInstalledId.get(p.manifest.id)?.repo"
          @toggle="toggle(p.manifest.id)"
          @details="openDetail(byInstalledId.get(p.manifest.id)!.key)"
        />

        <!-- Folders loaded before that didn't come back -->
        <div v-for="f in store.devFailed" :key="f.key" class="px-4 py-3 card flex gap-3 items-center">
          <span class="i-carbon-folder text-[16px] text-fg-faint shrink-0" />
          <div class="flex flex-1 flex-col gap-0.5 min-w-0">
            <span class="text-[13px] text-fg truncate">{{ f.label }}</span>
            <span class="text-[11.5px] text-warn">{{ f.error }}</span>
          </div>
          <UiButton size="sm" icon="i-carbon-renew" @click="retry(f.key)">
            Load again
          </UiButton>
          <UiButton size="sm" variant="ghost" @click="store.forgetFailedDev(f.key)">
            Forget
          </UiButton>
        </div>

        <UiEmpty v-if="!store.plugins.length" size="sm" icon="i-carbon-application" title="No plugins installed" description="Find one under Discover, or install a zip below.">
          <UiButton variant="primary" icon="i-carbon-apps" @click="tab = 'discover'">
            Discover plugins
          </UiButton>
        </UiEmpty>
        <UiEmpty v-else-if="!installed.length" size="sm" icon="i-carbon-search" title="Nothing matches" />

        <div
          class="p-4 border rounded-[var(--radius-lg)] border-dashed flex flex-wrap gap-3 transition-colors items-center"
          :class="dragging ? 'border-accent bg-accent-soft' : 'border-edge-strong'"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="onDrop"
        >
          <span class="text-accent-300 rounded-[var(--radius-md)] bg-accent-soft center shrink-0 h-10 w-10">
            <span class="i-carbon-application text-[19px]" />
          </span>
          <div class="flex flex-1 flex-col gap-0.5 min-w-[180px]">
            <span class="text-[13.5px] text-fg font-medium">Install from a file</span>
            <span class="hint">A plugin .zip from anywhere else: drop it here, or pick it. Installing one that is already here updates it.</span>
          </div>
          <UiButton variant="primary" icon="i-carbon-upload" :loading="installing" @click="fileEl?.click()">
            Install from zip
          </UiButton>
          <input ref="fileEl" type="file" accept=".zip,application/zip" class="hidden" @change="installFile(($event.target as HTMLInputElement).files?.[0])">
        </div>

        <div class="px-4 flex flex-wrap gap-3 items-center">
          <div class="flex flex-1 flex-col gap-0.5 min-w-[180px]">
            <span class="text-[13px] text-fg">Writing a plugin?</span>
            <span class="hint">Load it straight from its folder. It reloads each time you save, and isn't installed.</span>
          </div>
          <UiButton icon="i-carbon-folder" :loading="loadingFolder" @click="loadFolder">
            Load from folder…
          </UiButton>
        </div>
      </template>

      <!-- Updates -->
      <template v-else>
        <div class="flex flex-wrap gap-2 items-center">
          <span class="hint flex-1 min-w-[160px]">
            {{ store.checking ? 'Checking…' : `Checked ${lastChecked}. playhound looks once a day, and when this page opens.` }}
          </span>
          <UiButton icon="i-carbon-renew" :loading="store.checking" @click="checkNow">
            Check now
          </UiButton>
          <UiButton v-if="updates.length > 1" variant="primary" icon="i-carbon-upgrade" :disabled="!!busy" @click="updateAll">
            Update all
          </UiButton>
        </div>

        <div v-for="e in updates" :key="e.key" class="p-3.5 card flex flex-col gap-2.5">
          <div class="flex gap-3 items-center">
            <PluginIcon :id="e.id" :name="e.name" :image="iconRef(e, store.pluginFile)" :size="36" />
            <button type="button" class="text-left focusable rounded-[var(--radius-sm)] flex flex-1 flex-col gap-0.5 min-w-0" @click="openDetail(e.key)">
              <span class="text-[13.5px] text-fg font-medium truncate">{{ e.name }}</span>
              <span class="text-[11.5px] text-fg-faint num">{{ e.installed!.manifest.version }} → {{ e.update!.version }} · {{ ago(e.update!.publishedAt, now) }}</span>
            </button>
            <span v-if="e.problem" v-tip="e.problem" class="text-[11.5px] text-warn flex shrink-0 gap-1 items-center">
              <span class="i-carbon-warning-alt text-[13px]" /> Can't update yet
            </span>
            <UiButton v-else variant="primary" icon="i-carbon-upgrade" :loading="busy === e.key" :disabled="!!busy" @click="get(e)">
              Update
            </UiButton>
          </div>
          <div v-if="e.update!.notes.trim()" class="pl-3 border-l-2 border-edge-strong max-h-[140px] relative overflow-hidden" :class="e.update!.notes.length > 360 && 'notes-fold'">
            <StoreMarkdown :source="e.update!.notes" :repo="e.repo" />
          </div>
        </div>

        <UiEmpty v-if="!updates.length" size="sm" icon="i-carbon-checkmark-outline" title="Everything is up to date" :description="store.plugins.length ? 'Your plugins are on their latest releases.' : 'Install a plugin and its updates show here.'" />

        <!-- Sources that couldn't be checked -->
        <div v-for="e in entries.filter(x => x.source?.status === 'error')" :key="`err:${e.key}`" class="text-[12px] px-3 py-2 rounded-[var(--radius-md)] bg-danger/8 flex gap-2 items-start">
          <span class="i-carbon-warning-alt text-[14px] text-danger mt-px shrink-0" />
          <span class="text-fg-muted"><span class="text-fg font-medium">{{ e.repo }}</span>: {{ e.source!.error }}</span>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.store-grid {
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}
.notes-fold {
  mask-image: linear-gradient(to bottom, #000 60%, transparent);
}
</style>
