<script setup lang="ts">
import type { FsEntry } from '~/lib/fsWalk'
import type { FunscriptAction, ParsedAxis } from '~/lib/funscriptParser'
import type { OrgPair, PairStatus } from '~/stores/organizerStore'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { toast } from '~/composables/useToast'
import { extOf, sanitizeFilename } from '~/lib/fsRename'
import { parseFunscriptContent } from '~/lib/funscriptParser'
import { formatTime } from '~/lib/time'
import { useOrganizerStore } from '~/stores/organizerStore'

defineOptions({ name: 'OrganizerView' })

const organizer = useOrganizerStore()

onMounted(() => {
  if (!organizer.hasRoot)
    void organizer.restoreFolder()
})

const stem = (name: string) => name.slice(0, name.length - extOf(name).length)

// ─── Filter ──────────────────────────────────────────────────────────────────
type Filter = 'all' | PairStatus
const filter = ref<Filter>('all')
const search = ref('')

const filterOptions = computed(() => [
  { value: 'all' as Filter, label: `All ${organizer.pairs.length}` },
  { value: 'matched' as Filter, label: `Matched ${organizer.matchedCount}` },
  { value: 'video-only' as Filter, label: `No script ${organizer.missingScriptCount}` },
  { value: 'script-only' as Filter, label: `Orphans ${organizer.orphanScriptCount}` },
])

const shown = computed(() => {
  let list = organizer.pairs
  if (filter.value !== 'all')
    list = list.filter(p => p.status === filter.value)
  const q = search.value.trim().toLowerCase()
  if (q)
    list = list.filter(p => p.basename.toLowerCase().includes(q) || p.dir.toLowerCase().includes(q))
  return list
})

const STATUS: Record<PairStatus, { label: string, tone: 'ok' | 'warn' | 'danger' }> = {
  'matched': { label: 'Matched', tone: 'ok' },
  'video-only': { label: 'No script', tone: 'warn' },
  'script-only': { label: 'Orphan', tone: 'danger' },
}

// ─── Selection ───────────────────────────────────────────────────────────────
const selected = reactive(new Set<string>())
const shownSelected = computed(() => shown.value.filter(p => selected.has(p.key)).length)
const allShownSelected = computed(() => shown.value.length > 0 && shownSelected.value === shown.value.length)

function toggleAll() {
  if (allShownSelected.value)
    shown.value.forEach(p => selected.delete(p.key))
  else
    shown.value.forEach(p => selected.add(p.key))
}
function toggleOne(p: OrgPair) {
  if (selected.has(p.key))
    selected.delete(p.key)
  else
    selected.add(p.key)
}

// ─── Planned renames ─────────────────────────────────────────────────────────
// Nothing touches the disk until the plan is reviewed and confirmed. A row can
// carry one change: a new name for the pair (video and its scripts together),
// or new names for individual scripts — not both, since a pair rename derives
// each script's name from the old one.
const drafts = reactive(new Map<string, string>())
const scriptDrafts = reactive(new Map<string, string>())

const findOpen = ref(false)
const findText = ref('')
const replaceText = ref('')
const useRegex = ref(false)

const findRe = computed<RegExp | null | 'invalid'>(() => {
  if (!findOpen.value || !findText.value)
    return null
  try {
    return useRegex.value
      ? new RegExp(findText.value, 'g')
      : new RegExp(findText.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  }
  catch {
    return 'invalid'
  }
})

/** Find/replace applies to the selection when there is one, else to what is shown. */
const scopeKeys = computed(() => new Set((selected.size ? organizer.pairs.filter(p => selected.has(p.key)) : shown.value).map(p => p.key)))

function proposed(p: OrgPair): string | null {
  let next: string | undefined
  if (drafts.has(p.key))
    next = drafts.get(p.key)
  else if (findRe.value instanceof RegExp && scopeKeys.value.has(p.key))
    next = p.basename.replace(findRe.value, replaceText.value)
  if (next === undefined)
    return null
  const clean = sanitizeFilename(next)
  return clean && clean !== p.basename ? clean : null
}

const plan = computed(() => {
  const out = new Map<string, string>()
  for (const p of organizer.pairs) {
    const n = proposed(p)
    if (n)
      out.set(p.key, n)
  }
  return out
})

/** Two names landing on the same file in one folder; those rows are left out. */
const conflicts = computed(() => {
  const seen = new Map<string, string[]>()
  for (const p of organizer.pairs) {
    const id = `${p.dir}\u0000${(plan.value.get(p.key) ?? p.basename).toLowerCase()}`
    seen.set(id, [...(seen.get(id) ?? []), p.key])
  }
  const out = new Set<string>()
  for (const keys of seen.values()) {
    if (keys.length > 1)
      keys.filter(k => plan.value.has(k)).forEach(k => out.add(k))
  }
  return out
})

interface Change {
  pair: OrgPair
  kind: 'pair' | 'script'
  entry?: FsEntry
  from: string
  to: string
}

const changes = computed<Change[]>(() => {
  const out: Change[] = []
  for (const p of organizer.pairs) {
    const next = plan.value.get(p.key)
    if (next && !conflicts.value.has(p.key)) {
      out.push({ pair: p, kind: 'pair', from: p.basename, to: next })
      continue
    }
    if (next)
      continue
    for (const s of p.scripts) {
      const raw = scriptDrafts.get(s.relPath)
      const to = raw === undefined ? '' : sanitizeFilename(raw)
      if (to && to !== stem(s.name))
        out.push({ pair: p, kind: 'script', entry: s, from: s.name, to: to + extOf(s.name) })
    }
  }
  return out
})

/** What each script is called after a pair rename, keeping alt-axis suffixes like " (Bounce)". */
function scriptAfter(p: OrgPair, s: FsEntry): string | null {
  const next = plan.value.get(p.key)
  if (next)
    return next + stem(s.name).slice(p.basename.length) + extOf(s.name)
  const raw = scriptDrafts.get(s.relPath)
  const to = raw === undefined ? '' : sanitizeFilename(raw)
  return to && to !== stem(s.name) ? to + extOf(s.name) : null
}

function discardAll() {
  drafts.clear()
  scriptDrafts.clear()
  findText.value = ''
  replaceText.value = ''
}

// ─── Inline editing ──────────────────────────────────────────────────────────
const editing = ref<string | null>(null)
const editDraft = ref('')

function startEdit(p: OrgPair) {
  editing.value = p.key
  editDraft.value = plan.value.get(p.key) ?? p.basename
}
function commitEdit(p: OrgPair) {
  if (editing.value !== p.key)
    return
  editing.value = null
  const v = editDraft.value.trim()
  if (!v || v === p.basename) {
    drafts.delete(p.key)
    return
  }
  drafts.set(p.key, v)
  p.scripts.forEach(s => scriptDrafts.delete(s.relPath))
}
function unstage(p: OrgPair) {
  drafts.delete(p.key)
  p.scripts.forEach(s => scriptDrafts.delete(s.relPath))
}

/** Focus and select an input the moment it mounts; it lives inside a v-for. */
function focusSelect(el: unknown) {
  if (el instanceof HTMLInputElement) {
    el.focus()
    el.select()
  }
}

const editingScript = ref<string | null>(null)
const scriptDraft = ref('')
function startEditScript(s: FsEntry) {
  editingScript.value = s.relPath
  scriptDraft.value = scriptDrafts.get(s.relPath) ?? stem(s.name)
}
function commitEditScript(p: OrgPair, s: FsEntry) {
  if (editingScript.value !== s.relPath)
    return
  editingScript.value = null
  const v = scriptDraft.value.trim()
  if (!v || v === stem(s.name)) {
    scriptDrafts.delete(s.relPath)
    return
  }
  scriptDrafts.set(s.relPath, v)
  drafts.delete(p.key)
}

// ─── Detail sheet: video preview and script shapes ───────────────────────────
const openKey = ref<string | null>(null)
const openPair = computed(() => organizer.pairs.find(p => p.key === openKey.value) ?? null)
const previewUrl = ref<string | null>(null)
const previews = reactive(new Map<string, { loading: boolean, error?: string, axes?: ParsedAxis[] }>())

function revokePreview() {
  if (previewUrl.value)
    URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = null
}

watch(openPair, async (p, old) => {
  if (p && old && p.key === old.key)
    return
  revokePreview()
  if (!p)
    return
  if (p.video)
    previewUrl.value = URL.createObjectURL(p.video.file)
  for (const s of p.scripts) {
    if (previews.has(s.relPath))
      continue
    previews.set(s.relPath, { loading: true })
    try {
      const parsed = parseFunscriptContent(await s.file.text(), s.relPath, p.basename)
      previews.set(s.relPath, { loading: false, axes: parsed.axes })
    }
    catch {
      previews.set(s.relPath, { loading: false, error: 'Could not parse this .funscript' })
    }
  }
})
onBeforeUnmount(revokePreview)

function toggleOpen(p: OrgPair) {
  openKey.value = openKey.value === p.key ? null : p.key
}

/** A downsampled position trace, for a quick read of the stroke pattern. */
function tracePoints(actions: FunscriptAction[]): string {
  if (!actions.length)
    return ''
  const duration = actions[actions.length - 1].at || 1
  const stride = Math.max(1, Math.floor(actions.length / 400))
  const pts: string[] = []
  for (let i = 0; i < actions.length; i += stride)
    pts.push(`${((actions[i].at / duration) * 400).toFixed(1)},${(30 - actions[i].pos * 28 - 1).toFixed(1)}`)
  return pts.join(' ')
}

// ─── Apply ───────────────────────────────────────────────────────────────────
const reviewOpen = ref(false)
const applying = ref(false)
const progress = ref({ done: 0, total: 0, current: '' })
const results = ref<{ ok: number, failed: { from: string, error: string }[] } | null>(null)

function review() {
  results.value = null
  reviewOpen.value = true
}

async function apply() {
  const list = [...changes.value]
  applying.value = true
  progress.value = { done: 0, total: list.length, current: '' }
  const failed: { from: string, error: string }[] = []
  let ok = 0
  for (const c of list) {
    progress.value.current = c.from
    organizer.error = null
    if (c.kind === 'pair')
      await organizer.renamePair(c.pair, c.to)
    else
      await organizer.renameSingle(c.pair, c.entry!, c.to)
    // The store reports failures through `error` and resyncs from disk.
    const err = organizer.error as string | null
    if (err)
      failed.push({ from: c.from, error: err.replace(/^Rename failed:\s*/, '') })
    else
      ok++
    progress.value.done++
  }
  organizer.error = null
  applying.value = false
  results.value = { ok, failed }
  discardAll()
  selected.clear()
  findOpen.value = false
  if (!failed.length)
    toast.success(`Renamed ${ok} item${ok === 1 ? '' : 's'}`, { icon: 'i-carbon-edit' })
}

// ─── Keyboard ────────────────────────────────────────────────────────────────
// Captured on the document so Esc closes the sheet instead of reaching the
// shell, where a bare Esc is the panic key.
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !openKey.value || reviewOpen.value || (e.target as HTMLElement).closest?.('input, textarea, select'))
    return
  e.stopPropagation()
  openKey.value = null
}
onMounted(() => document.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))

const isNewGroup = (i: number) => i === 0 || shown.value[i - 1].dir !== shown.value[i].dir
</script>

<template>
  <div class="bg-surface-950 flex flex-col h-full min-h-0 relative">
    <!-- Header -->
    <header class="px-6 pb-4 pt-5 flex shrink-0 gap-4 items-end">
      <div class="flex-1 min-w-0">
        <h1 class="h-view">
          Organizer
        </h1>
        <p class="text-[12.5px] text-fg-muted mt-0.5 flex gap-1.5 min-w-0 items-center">
          <template v-if="organizer.hasRoot">
            <span class="i-carbon-folder shrink-0" />
            <span class="text-fg truncate">{{ organizer.rootName }}</span>
            <span class="text-fg-faint shrink-0">· rename videos and their scripts together</span>
          </template>
          <template v-else>
            Rename videos and their scripts together, and find what is missing a match.
          </template>
        </p>
      </div>
      <div class="flex shrink-0 gap-1.5 items-center">
        <UiIconButton
          v-if="organizer.hasRoot"
          icon="i-carbon-renew"
          label="Rescan folder"
          size="md"
          :disabled="organizer.scanning"
          @click="organizer.rescan()"
        />
        <UiButton size="md" variant="ghost" icon="i-carbon-video-chat" @click="organizer.useLibraryFolder()">
          Use library folder
        </UiButton>
        <UiButton size="md" :variant="organizer.hasRoot ? 'secondary' : 'primary'" icon="i-carbon-folder-open" @click="organizer.openFolder()">
          Open folder
        </UiButton>
      </div>
    </header>

    <!-- Banners -->
    <div class="px-6 flex shrink-0 flex-col gap-2">
      <Transition name="t-collapse">
        <div v-if="organizer.hasRoot && !organizer.writable">
          <div class="min-h-0 overflow-hidden">
            <div class="mb-3 px-3 py-2 border border-warn/25 rounded-[var(--radius-md)] bg-warn/8 flex gap-3 items-center">
              <span class="i-carbon-locked text-warn shrink-0" />
              <span class="text-[12.5px] text-fg flex-1">Read-only — the browser has not allowed changes to this folder.</span>
              <UiButton size="xs" @click="organizer.retryPermission()">
                Enable editing
              </UiButton>
            </div>
          </div>
        </div>
      </Transition>
      <Transition name="t-collapse">
        <div v-if="organizer.error && !applying">
          <div class="min-h-0 overflow-hidden">
            <div class="mb-3 px-3 py-2 border border-danger/25 rounded-[var(--radius-md)] bg-danger/8 flex gap-3 items-center">
              <span class="i-carbon-warning-filled text-danger shrink-0" />
              <span class="text-[12.5px] text-fg flex-1">{{ organizer.error }}</span>
              <UiIconButton icon="i-carbon-close" label="Dismiss" size="xs" @click="organizer.error = null" />
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <!-- Empty -->
    <div v-if="!organizer.hasRoot && !organizer.restoring" class="center flex-1">
      <UiEmpty
        size="lg"
        icon="i-carbon-folder-details"
        title="Open a folder to organize"
        description="Videos and .funscript files are paired by name in each folder. Rename a pair and every script follows, alternate takes included."
      >
        <UiButton variant="ghost" icon="i-carbon-video-chat" @click="organizer.useLibraryFolder()">
          Use library folder
        </UiButton>
        <UiButton variant="primary" icon="i-carbon-folder-open" @click="organizer.openFolder()">
          Choose folder
        </UiButton>
      </UiEmpty>
    </div>

    <template v-else>
      <!-- Toolbar -->
      <div class="px-6 pb-3 flex shrink-0 flex-col gap-2.5">
        <div class="flex flex-wrap gap-2 items-center">
          <UiInput v-model="search" icon="i-carbon-search" placeholder="Filter by name or folder" clearable class="flex-1 max-w-[280px] min-w-[180px]" />
          <UiSegmented v-model="filter" :options="filterOptions" />
          <div class="flex-1" />
          <UiButton :active="findOpen" icon="i-carbon-edit" @click="findOpen = !findOpen">
            Find &amp; replace
          </UiButton>
        </div>

        <Transition name="t-collapse">
          <div v-if="findOpen">
            <div class="min-h-0 overflow-hidden">
              <div class="p-2.5 card flex flex-wrap gap-2 items-center">
                <UiInput v-model="findText" placeholder="Find" :mono="useRegex" class="flex-1 min-w-[160px]" autofocus />
                <span class="i-carbon-arrow-right text-fg-faint shrink-0" />
                <UiInput v-model="replaceText" placeholder="Replace with" class="flex-1 min-w-[160px]" />
                <UiButton v-tip="'Treat Find as a regular expression; $1 works in Replace'" variant="ghost" :active="useRegex" icon="i-carbon-code" @click="useRegex = !useRegex">
                  Regex
                </UiButton>
                <span class="hint w-full" :class="findRe === 'invalid' ? '!text-danger' : ''">
                  <template v-if="findRe === 'invalid'">That is not a valid regular expression.</template>
                  <template v-else>
                    Applies to {{ selected.size ? `the ${selected.size} selected` : `the ${shown.length} shown` }}.
                    Changes are previewed in the list — nothing is renamed until you apply.
                  </template>
                </span>
              </div>
            </div>
          </div>
        </Transition>

        <!-- Pending changes -->
        <Transition name="t-collapse">
          <div v-if="changes.length || conflicts.size">
            <div class="min-h-0 overflow-hidden">
              <div class="py-2 pl-3 pr-2 border border-accent/30 rounded-[var(--radius-md)] bg-accent-soft flex gap-3 items-center">
                <span class="i-carbon-edit text-accent-300 shrink-0" />
                <span class="text-[13px] text-fg flex-1">
                  <b class="num">{{ changes.length }}</b> rename{{ changes.length === 1 ? '' : 's' }} planned
                  <span v-if="conflicts.size" class="text-warn"> · {{ conflicts.size }} skipped, name already taken</span>
                </span>
                <UiButton variant="ghost" size="sm" @click="discardAll">
                  Discard
                </UiButton>
                <UiButton variant="primary" size="sm" icon="i-carbon-checkmark" :disabled="!changes.length || !organizer.writable" @click="review">
                  Review &amp; apply
                </UiButton>
              </div>
            </div>
          </div>
        </Transition>
      </div>

      <!-- Table -->
      <div class="border-t border-edge flex flex-1 min-h-0">
        <div class="scroll-y flex-1 min-w-0">
          <div class="text-[11px] text-fg-faint tracking-[0.06em] font-semibold px-6 border-b border-edge bg-surface-950/90 flex gap-3 h-9 uppercase items-center top-0 sticky z-2 backdrop-blur">
            <button
              type="button"
              class="text-[15px] focusable rounded shrink-0"
              :class="selected.size ? 'text-accent-300' : 'text-fg-faint hover:text-fg'"
              :aria-label="allShownSelected ? 'Select none' : 'Select all shown'"
              @click="toggleAll"
            >
              <span :class="allShownSelected ? 'i-carbon-checkbox-checked-filled' : shownSelected ? 'i-carbon-checkbox-indeterminate-filled' : 'i-carbon-checkbox'" class="block" />
            </button>
            <span class="flex-1">Name</span>
            <span class="w-40 hidden xl:block">Files</span>
            <span class="w-24">Status</span>
            <span class="w-16" />
          </div>

          <!-- Loading -->
          <div v-if="organizer.restoring || (organizer.scanning && !organizer.pairs.length)" class="px-6 py-3 flex flex-col gap-2">
            <div v-for="i in 8" :key="i" class="skeleton rounded-[var(--radius-sm)] h-10" :style="{ opacity: 1 - i * 0.1 }" />
          </div>

          <UiEmpty
            v-else-if="!shown.length"
            icon="i-carbon-filter"
            :title="organizer.pairs.length ? 'Nothing matches' : 'No videos or scripts here'"
            :description="organizer.pairs.length ? 'Try another filter or clear the search.' : 'This folder has no video or .funscript files in it.'"
          />

          <div v-else class="pb-[240px]">
            <template v-for="(p, i) in shown" :key="p.key">
              <div v-if="isNewGroup(i)" class="eyebrow px-6 pb-1.5 pt-4 flex gap-1.5 items-center">
                <span class="i-carbon-folder" />
                {{ p.dir || organizer.rootName }}
              </div>
              <div
                class="group px-6 border-b border-edge/60 flex gap-3 min-h-11 cursor-default transition-colors [contain-intrinsic-size:auto_44px] [content-visibility:auto] items-center"
                :class="openKey === p.key ? 'bg-accent-soft/60' : selected.has(p.key) ? 'bg-fg/4' : 'hover:bg-fg/3'"
                @click="toggleOpen(p)"
              >
                <button
                  type="button"
                  class="text-[15px] focusable rounded shrink-0"
                  :class="selected.has(p.key) ? 'text-accent-300' : 'text-fg-faint hover:text-fg'"
                  :aria-label="selected.has(p.key) ? 'Deselect' : 'Select'"
                  @click.stop="toggleOne(p)"
                >
                  <span :class="selected.has(p.key) ? 'i-carbon-checkbox-checked-filled' : 'i-carbon-checkbox'" class="block" />
                </button>

                <!-- Name: before → after -->
                <div class="py-2 flex flex-1 gap-2 min-w-0 items-center">
                  <input
                    v-if="editing === p.key"
                    :ref="focusSelect"
                    v-model="editDraft"
                    class="text-[13px] text-fg px-2 outline-none border border-accent/70 rounded-[var(--radius-sm)] bg-surface-900 flex-1 h-7 min-w-0 ring-3 ring-accent-soft"
                    @click.stop
                    @blur="commitEdit(p)"
                    @keydown.enter="commitEdit(p)"
                    @keydown.escape.stop="editing = null"
                  >
                  <template v-else-if="plan.get(p.key)">
                    <span v-tip="p.basename" class="text-[12.5px] text-fg-faint line-through truncate">{{ p.basename }}</span>
                    <span class="i-carbon-arrow-right text-accent-300 shrink-0" />
                    <span
                      v-tip="plan.get(p.key)"
                      class="text-[13px] font-medium truncate"
                      :class="conflicts.has(p.key) ? 'text-warn' : 'text-accent-300'"
                    >{{ plan.get(p.key) }}</span>
                    <UiBadge v-if="conflicts.has(p.key)" tone="warn" size="xs" icon="i-carbon-warning-alt">
                      taken
                    </UiBadge>
                  </template>
                  <span v-else v-tip="p.basename" class="text-[13px] text-fg truncate">{{ p.basename }}</span>
                  <UiBadge v-if="!plan.get(p.key) && p.scripts.some(s => scriptAfter(p, s))" tone="accent" size="xs" icon="i-carbon-edit">
                    script renamed
                  </UiBadge>
                  <span v-if="organizer.renamingKey === p.key" class="text-accent-300 shrink-0"><UiSpinner :size="12" /></span>
                </div>

                <div class="text-[11.5px] text-fg-muted gap-1.5 w-40 hidden items-center xl:flex">
                  <span v-if="p.video" v-tip="p.video.name" class="flex gap-1 items-center"><span class="i-carbon-video" /> 1</span>
                  <span v-if="p.scripts.length" v-tip="p.scripts.map(s => s.name).join('\n')" class="flex gap-1 items-center">
                    <span class="i-carbon-chart-line" /> {{ p.scripts.length }}
                  </span>
                </div>

                <div class="w-24">
                  <UiBadge :tone="STATUS[p.status].tone" size="xs" dot>
                    {{ STATUS[p.status].label }}
                  </UiBadge>
                </div>

                <div class="flex w-16 justify-end">
                  <UiIconButton
                    v-if="plan.get(p.key) || p.scripts.some(s => scriptDrafts.has(s.relPath))"
                    icon="i-carbon-undo"
                    label="Undo this change"
                    size="xs"
                    @click.stop="unstage(p)"
                  />
                  <UiIconButton
                    icon="i-carbon-edit"
                    label="Rename"
                    size="xs"
                    class="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                    @click.stop="startEdit(p)"
                  />
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- Detail sheet -->
        <Transition name="t-slide-right">
          <aside v-if="openPair" :key="openPair.key" class="border-l border-edge bg-surface-900 flex shrink-0 flex-col w-[380px]">
            <div class="pl-4 pr-2 border-b border-edge flex shrink-0 gap-2 h-11 items-center">
              <span class="text-[13px] text-fg font-medium flex-1 truncate">{{ openPair.basename }}</span>
              <UiIconButton icon="i-carbon-close" label="Close" kbd="Esc" size="sm" @click="openKey = null" />
            </div>
            <div class="p-4 pb-[240px] scroll-y flex flex-1 flex-col gap-4">
              <video
                v-if="previewUrl"
                :src="previewUrl"
                controls
                preload="metadata"
                class="rounded-[var(--radius-md)] bg-black w-full aspect-video"
              />
              <div v-else class="text-[12px] text-fg-faint rounded-[var(--radius-md)] bg-surface-800 flex flex-col gap-1 w-full aspect-video items-center justify-center">
                <span class="i-carbon-video-off text-[22px]" />
                No video for this script
              </div>

              <div class="flex flex-col gap-1.5">
                <span class="eyebrow">Files</span>
                <div v-if="openPair.video" class="text-[12px] px-2.5 py-2 well flex gap-2 items-start">
                  <span class="i-carbon-video text-fg-muted mt-0.5 shrink-0" />
                  <div class="flex flex-col min-w-0">
                    <span class="text-fg break-all">{{ openPair.video.name }}</span>
                    <span v-if="plan.get(openPair.key)" class="text-accent-300 break-all">→ {{ plan.get(openPair.key) }}{{ extOf(openPair.video.name) }}</span>
                  </div>
                </div>

                <div v-for="s in openPair.scripts" :key="s.relPath" class="text-[12px] px-2.5 py-2 well flex flex-col gap-2">
                  <div class="flex gap-2 items-start">
                    <span class="i-carbon-chart-line text-fg-muted mt-0.5 shrink-0" />
                    <div class="flex flex-1 flex-col min-w-0">
                      <input
                        v-if="editingScript === s.relPath"
                        :ref="focusSelect"
                        v-model="scriptDraft"
                        class="text-[12px] text-fg px-2 outline-none border border-accent/70 rounded-[var(--radius-sm)] bg-surface-900 h-6 ring-3 ring-accent-soft"
                        @blur="commitEditScript(openPair, s)"
                        @keydown.enter="commitEditScript(openPair, s)"
                        @keydown.escape.stop="editingScript = null"
                      >
                      <span v-else class="text-fg break-all">{{ s.name }}</span>
                      <span v-if="scriptAfter(openPair, s) && editingScript !== s.relPath" class="text-accent-300 break-all">→ {{ scriptAfter(openPair, s) }}</span>
                    </div>
                    <UiIconButton
                      v-if="editingScript !== s.relPath"
                      icon="i-carbon-edit"
                      label="Rename just this script"
                      size="xs"
                      @click="startEditScript(s)"
                    />
                  </div>

                  <p v-if="previews.get(s.relPath)?.loading" class="skeleton rounded h-8" />
                  <p v-else-if="previews.get(s.relPath)?.error" class="text-[11.5px] text-danger">
                    {{ previews.get(s.relPath)!.error }}
                  </p>
                  <template v-else>
                    <div v-for="axis in previews.get(s.relPath)?.axes ?? []" :key="axis.channel" class="flex flex-col gap-1">
                      <div class="text-[11px] text-fg-faint flex gap-2 items-center">
                        <UiBadge size="xs" tone="accent">
                          {{ axis.channel }}
                        </UiBadge>
                        {{ axis.label }}
                        <span class="num ml-auto">{{ axis.actions.length.toLocaleString() }} pts · {{ formatTime(axis.duration / 1000) }}</span>
                      </div>
                      <svg v-if="axis.actions.length" viewBox="0 0 400 30" preserveAspectRatio="none" class="h-8 w-full">
                        <polyline :points="tracePoints(axis.actions)" fill="none" stroke="var(--accent)" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
                      </svg>
                    </div>
                  </template>
                </div>
                <p v-if="!openPair.scripts.length" class="hint px-1">
                  No script matched. Scripts pair up when their name starts with the video's name.
                </p>
              </div>

              <div class="flex gap-2">
                <UiButton icon="i-carbon-edit" block @click="startEdit(openPair)">
                  Rename pair
                </UiButton>
                <UiButton v-if="plan.get(openPair.key) || openPair.scripts.some(s => scriptDrafts.has(s.relPath))" variant="ghost" icon="i-carbon-undo" @click="unstage(openPair)">
                  Undo
                </UiButton>
              </div>
            </div>
          </aside>
        </Transition>
      </div>
    </template>

    <!-- Review & apply -->
    <UiModal
      v-model:open="reviewOpen"
      :title="results ? 'Renamed' : `Rename ${changes.length} item${changes.length === 1 ? '' : 's'}?`"
      :subtitle="results ? undefined : 'Files are renamed on disk. There is no undo, so check the list.'"
      icon="i-carbon-edit"
      width="620px"
      :persistent="applying"
    >
      <!-- Running -->
      <div v-if="applying" class="py-2 flex flex-col gap-3">
        <div class="flex gap-3 items-baseline justify-between">
          <span class="text-[13px] text-fg truncate">{{ progress.current }}</span>
          <span class="text-[12px] text-fg-muted num shrink-0">{{ progress.done }} / {{ progress.total }}</span>
        </div>
        <UiProgress :value="progress.total ? progress.done / progress.total : 0" />
      </div>

      <!-- Done -->
      <div v-else-if="results" class="flex flex-col gap-3 animate-rise">
        <div class="gap-3 grid grid-cols-2">
          <div class="p-3 well">
            <UiStat label="Renamed" :value="results.ok" tone="ok" />
          </div>
          <div class="p-3 well">
            <UiStat label="Failed" :value="results.failed.length" :tone="results.failed.length ? 'danger' : 'fg'" />
          </div>
        </div>
        <ul v-if="results.failed.length" class="flex flex-col gap-1">
          <li v-for="f in results.failed" :key="f.from" class="text-[12px] px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-danger/8 flex flex-col">
            <span class="text-fg truncate">{{ f.from }}</span>
            <span class="text-danger">{{ f.error }}</span>
          </li>
        </ul>
        <p v-if="results.failed.length" class="hint">
          The folder was rescanned after the failure, so the list shows what is really on disk.
        </p>
      </div>

      <!-- Review -->
      <ul v-else class="flex flex-col">
        <li v-for="c in changes" :key="`${c.kind}:${c.entry?.relPath ?? c.pair.key}`" class="py-2 border-b border-edge flex flex-col gap-0.5 last:border-0">
          <div class="text-[11px] text-fg-faint flex gap-1.5 items-center">
            <span :class="c.kind === 'pair' ? 'i-carbon-video' : 'i-carbon-chart-line'" />
            {{ c.pair.dir || organizer.rootName }}
            <span v-if="c.kind === 'pair' && c.pair.scripts.length">· with {{ c.pair.scripts.length }} script{{ c.pair.scripts.length === 1 ? '' : 's' }}</span>
          </div>
          <div class="text-[12.5px] gap-2 grid grid-cols-[1fr_auto_1fr] items-center">
            <span class="text-fg-muted truncate">{{ c.from }}</span>
            <span class="i-carbon-arrow-right text-fg-faint" />
            <span class="text-fg font-medium truncate">{{ c.to }}</span>
          </div>
        </li>
      </ul>

      <template #footer>
        <template v-if="results">
          <UiButton variant="primary" @click="reviewOpen = false">
            Done
          </UiButton>
        </template>
        <template v-else>
          <UiButton variant="ghost" :disabled="applying" @click="reviewOpen = false">
            Cancel
          </UiButton>
          <UiButton variant="primary" icon="i-carbon-checkmark" :loading="applying" :disabled="!changes.length" @click="apply">
            Rename {{ changes.length }}
          </UiButton>
        </template>
      </template>
    </UiModal>
  </div>
</template>
