<script setup lang="ts">
import type { VideoEntry } from '~/stores/libraryStore'
import type { SmartRule } from '~/stores/playlistStore'
import { computed, ref } from 'vue'
import { useLibraryStore } from '~/stores/libraryStore'
import { evaluateSmartPlaylist, usePlaylistStore } from '~/stores/playlistStore'

const emit = defineEmits<{
  select: [entry: VideoEntry]
  queue: [entries: VideoEntry[], selected: VideoEntry]
}>()

const vFocus = { mounted: (el: HTMLElement) => el.focus() }

const plStore = usePlaylistStore()
const library = useLibraryStore()

// ─── View mode ────────────────────────────────────────────────────────────────
const viewMode = ref<'playlists' | 'smart'>('playlists')

// ─── Active playlist ──────────────────────────────────────────────────────────
const activeId = ref('favorites')
const activePl = computed(() => plStore.playlists.find(p => p.id === activeId.value))

const resolvedEntries = computed(() => {
  if (!activePl.value)
    return []
  return activePl.value.entries
    .map(e => library.videos.find(v => v.name === e.videoName))
    .filter(Boolean) as VideoEntry[]
})

// ─── Smart playlists ──────────────────────────────────────────────────────────
const activeSmartId = ref(plStore.smartPlaylists[0]?.id ?? '')
const activeSmartPl = computed(() => plStore.smartPlaylists.find(p => p.id === activeSmartId.value))
const smartEntries = computed(() => {
  if (!activeSmartPl.value)
    return []
  return evaluateSmartPlaylist(activeSmartPl.value, library.videos)
})

const showNewSmart = ref(false)
const newSmartName = ref('')
const newSmartRuleType = ref<SmartRule['type']>('has_script')
const newSmartRuleTag = ref('')
const newSmartRuleRating = ref(3)

function createSmart() {
  const name = newSmartName.value.trim()
  if (!name)
    return
  let rule: SmartRule
  if (newSmartRuleType.value === 'has_tag')
    rule = { type: 'has_tag', tag: newSmartRuleTag.value.trim() }
  else if (newSmartRuleType.value === 'min_rating')
    rule = { type: 'min_rating', rating: newSmartRuleRating.value }
  else rule = { type: newSmartRuleType.value } as SmartRule
  const pl = plStore.createSmartPlaylist(name, [rule])
  activeSmartId.value = pl.id
  showNewSmart.value = false
  newSmartName.value = ''
}

// ─── New playlist ─────────────────────────────────────────────────────────────
const creatingNew = ref(false)
const newName = ref('')

function confirmCreate() {
  const name = newName.value.trim()
  if (!name)
    return
  const pl = plStore.createPlaylist(name)
  activeId.value = pl.id
  creatingNew.value = false
  newName.value = ''
}

// ─── Rename ───────────────────────────────────────────────────────────────────
const renamingId = ref<string | null>(null)
const renameVal = ref('')

function startRename(id: string, current: string) { renamingId.value = id; renameVal.value = current }
function confirmRename() {
  if (renamingId.value)
    plStore.renamePlaylist(renamingId.value, renameVal.value.trim())
  renamingId.value = null
}

// ─── Export / Import ──────────────────────────────────────────────────────────
function exportPlaylists() {
  const json = plStore.exportAll()
  const blob = new Blob([json], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'mwhoplayer-playlists.json'
  a.click()
  URL.revokeObjectURL(a.href)
}

function importPlaylists() {
  const input = document.createElement('input')
  input.type = 'file'; input.accept = '.json'
  input.onchange = async () => {
    const f = input.files?.[0]; if (!f)
      return
    const text = await f.text()
    if (!plStore.importAll(text))
      // eslint-disable-next-line no-alert -- deliberate, minimal failure feedback
      alert('Invalid playlist file')
  }
  input.click()
}
</script>

<template>
  <div class="text-sm flex flex-col h-full min-h-0">
    <!-- ── Header ──────────────────────────────────────────────────────────── -->
    <div class="px-3 py-2 border-b border-white/5 flex shrink-0 gap-1.5 items-center">
      <!-- View toggle -->
      <div class="text-[11px] border border-white/10 rounded flex shrink-0 overflow-hidden">
        <button class="px-2 py-0.5 transition-colors" :class="viewMode === 'playlists' ? 'bg-accent-600 text-white' : 'text-white/40 hover:text-white/70'" @click="viewMode = 'playlists'">
          Lists
        </button>
        <button class="px-2 py-0.5 transition-colors" :class="viewMode === 'smart' ? 'bg-accent-600 text-white' : 'text-white/40 hover:text-white/70'" @click="viewMode = 'smart'">
          Smart
        </button>
      </div>
      <div class="flex-1" />
      <template v-if="viewMode === 'playlists'">
        <button class="btn-ghost px-1.5 py-1" title="Export" @click="exportPlaylists">
          <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
        </button>
        <button class="btn-ghost px-1.5 py-1" title="Import" @click="importPlaylists">
          <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12" /></svg>
        </button>
        <button class="btn-primary text-[11px] px-2 py-1 shrink-0" @click="creatingNew = true">
          + New
        </button>
      </template>
      <template v-else>
        <button class="btn-primary text-[11px] px-2 py-1 shrink-0" @click="showNewSmart = !showNewSmart">
          + Smart
        </button>
      </template>
    </div>

    <!-- ══════════════════ PLAYLISTS VIEW ═══════════════════════════════════ -->
    <template v-if="viewMode === 'playlists'">
      <!-- Playlist tabs -->
      <div class="px-3 py-2 border-b border-white/5 flex shrink-0 flex-wrap gap-1">
        <button
          v-for="pl in plStore.playlists" :key="pl.id"
          class="text-[11px] px-2 py-0.5 rounded-full max-w-[120px] truncate transition-all"
          :class="activeId === pl.id ? 'text-white font-semibold' : 'text-white/40 hover:text-white/70'"
          :style="activeId === pl.id ? { background: 'var(--accent)' } : {}"
          :title="pl.name"
          @click="activeId = pl.id"
          @dblclick="pl.id !== 'favorites' && startRename(pl.id, pl.name)"
        >
          <template v-if="renamingId === pl.id">
            <input
              v-model="renameVal" v-focus
              class="text-white outline-none bg-transparent w-20" @blur="confirmRename" @keydown.enter="confirmRename" @keydown.esc="renamingId = null" @click.stop
            >
          </template>
          <template v-else>
            {{ pl.name }} <span class="opacity-50">({{ pl.entries.length }})</span>
          </template>
        </button>
        <div v-if="creatingNew" class="flex gap-1 items-center">
          <input
            v-model="newName" v-focus placeholder="Name…"
            class="input text-[11px] px-2 py-0.5 h-6 w-28" @keydown.enter="confirmCreate" @keydown.esc="creatingNew = false;newName = ''"
          >
          <button class="btn-ghost text-[11px] text-accent-400 px-1 py-0.5" @click="confirmCreate">
            ✓
          </button>
          <button class="btn-ghost text-[11px] text-white/30 px-1 py-0.5" @click="creatingNew = false;newName = ''">
            ✕
          </button>
        </div>
      </div>

      <!-- Actions row -->
      <div v-if="activePl && activePl.id !== 'favorites'" class="px-3 py-1.5 border-b border-white/5 flex shrink-0 gap-2 items-center">
        <span class="text-[11px] flex-1" style="color:var(--text-faint)">{{ resolvedEntries.length }} / {{ activePl.entries.length }} loaded</span>
        <button class="text-[11px] text-red-400/60 transition-colors hover:text-red-400" @click="plStore.deletePlaylist(activePl.id); activeId = 'favorites'">
          Delete list
        </button>
      </div>

      <!-- Empty -->
      <div v-if="!activePl || activePl.entries.length === 0" class="px-4 text-center flex flex-1 flex-col gap-2 items-center justify-center">
        <svg class="opacity-20 h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
        </svg>
        <p class="text-xs" style="color:var(--text-faint)">
          {{ activePl?.id === 'favorites' ? 'Star videos in the library to add them here.' : 'Right-click videos in the library to add them.' }}
        </p>
      </div>

      <!-- Video list -->
      <div v-else class="flex-1 overflow-y-auto">
        <div
          v-for="entry in resolvedEntries" :key="entry.name"
          class="group px-3 py-2 border-b border-white/[0.04] flex gap-2.5 cursor-pointer transition-colors items-center hover:bg-white/5"
          @click="emit('select', entry); emit('queue', resolvedEntries, entry)"
        >
          <div class="rounded bg-surface-800 shrink-0 h-8 w-14 overflow-hidden">
            <img v-if="entry.thumbnailUrl" :src="entry.thumbnailUrl" class="h-full w-full object-cover">
            <div v-else class="flex h-full w-full items-center justify-center">
              <svg class="text-white/15 h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-xs text-white/70 truncate transition-colors group-hover:text-white">
              {{ entry.basename }}
            </p>
            <p class="text-[10px]" style="color:var(--text-faint)">
              {{ (entry.file.size / 1024 / 1024).toFixed(0) }} MB
            </p>
          </div>
          <button
            class="btn-ghost text-white/30 px-1 py-0.5 opacity-0 transition-all hover:text-red-400 group-hover:opacity-100"
            @click.stop="plStore.removeFromPlaylist(activeId, entry.name)"
          >
            <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div
          v-for="entry in activePl!.entries.filter(e => !library.videos.find(v => v.name === e.videoName))"
          :key="entry.videoName" class="px-3 py-2 border-b border-white/[0.04] opacity-40 flex gap-2.5 items-center"
        >
          <div class="rounded bg-surface-800 shrink-0 h-8 w-14" />
          <p class="text-xs flex-1 truncate" style="color:var(--text-faint)">
            {{ entry.videoName }}
          </p>
          <button class="btn-ghost text-white/20 px-1 py-0.5 hover:text-red-400" @click="plStore.removeFromPlaylist(activeId, entry.videoName)">
            <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </div>
    </template>

    <!-- ══════════════════ SMART PLAYLISTS VIEW ══════════════════════════════ -->
    <template v-else>
      <!-- New smart playlist form -->
      <Transition name="slide-down">
        <div v-if="showNewSmart" class="px-3 py-2.5 border-b border-white/5 flex shrink-0 flex-col gap-2">
          <input v-model="newSmartName" v-focus class="input text-xs py-1 w-full" placeholder="Playlist name…">
          <div class="flex gap-2">
            <select v-model="newSmartRuleType" class="input text-xs py-1 flex-1">
              <option value="has_script">
                Has Script
              </option>
              <option value="no_script">
                No Script
              </option>
              <option value="starred">
                Starred
              </option>
              <option value="multi_axis">
                Multi-Axis
              </option>
              <option value="has_tag">
                Has Tag
              </option>
              <option value="min_rating">
                Min Rating
              </option>
            </select>
          </div>
          <input v-if="newSmartRuleType === 'has_tag'" v-model="newSmartRuleTag" class="input text-xs py-1 w-full" placeholder="Tag name…">
          <div v-if="newSmartRuleType === 'min_rating'" class="flex gap-1 items-center">
            <span class="text-[11px] text-white/40 mr-1">Min:</span>
            <button
              v-for="n in 5" :key="n" class="text-base transition-colors"
              :class="newSmartRuleRating >= n ? 'text-yellow-400' : 'text-white/15 hover:text-white/40'"
              @click="newSmartRuleRating = n"
            >
              ★
            </button>
          </div>
          <div class="flex gap-1.5">
            <button class="btn-primary text-xs py-1 flex-1" @click="createSmart">
              Create
            </button>
            <button class="btn-ghost text-xs py-1 flex-1" @click="showNewSmart = false">
              Cancel
            </button>
          </div>
        </div>
      </Transition>

      <!-- Smart playlist tabs -->
      <div class="px-3 py-2 border-b border-white/5 flex shrink-0 flex-wrap gap-1">
        <button
          v-for="pl in plStore.smartPlaylists" :key="pl.id"
          class="text-[11px] px-2 py-0.5 rounded-full max-w-[140px] truncate transition-all"
          :class="activeSmartId === pl.id ? 'text-white font-semibold' : 'text-white/40 hover:text-white/70'"
          :style="activeSmartId === pl.id ? { background: 'var(--accent)' } : {}"
          @click="activeSmartId = pl.id"
        >
          {{ pl.name }}
        </button>
      </div>

      <!-- Smart result count + actions -->
      <div class="px-3 py-1.5 border-b border-white/5 flex shrink-0 gap-2 items-center">
        <span class="text-[11px] flex-1" style="color:var(--text-faint)">
          {{ smartEntries.length }} video{{ smartEntries.length !== 1 ? 's' : '' }} match
          <span v-if="!library.hasVideos" class="text-amber-400/70"> · open a folder first</span>
        </span>
        <button
          v-if="activeSmartPl && !activeSmartPl.id.startsWith('smart:')"
          class="text-[11px] text-red-400/60 transition-colors hover:text-red-400"
          @click="plStore.deleteSmartPlaylist(activeSmartPl.id); activeSmartId = plStore.smartPlaylists[0]?.id ?? ''"
        >
          Delete
        </button>
        <button
          v-if="smartEntries.length" class="btn-ghost text-[11px] px-2 py-0.5"
          @click="if (smartEntries.length){ emit('select', smartEntries[0]); emit('queue', smartEntries, smartEntries[0]) }"
        >
          ▶ Play All
        </button>
      </div>

      <!-- Smart entries -->
      <div v-if="smartEntries.length" class="flex-1 overflow-y-auto">
        <div
          v-for="entry in smartEntries" :key="entry.name"
          class="group px-3 py-2 border-b border-white/[0.04] flex gap-2.5 cursor-pointer transition-colors items-center hover:bg-white/5"
          @click="emit('select', entry); emit('queue', smartEntries, entry)"
        >
          <div class="rounded bg-surface-800 shrink-0 h-8 w-14 overflow-hidden">
            <img v-if="entry.thumbnailUrl" :src="entry.thumbnailUrl" class="h-full w-full object-cover">
            <div v-else class="flex h-full w-full items-center justify-center">
              <svg class="text-white/15 h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-xs text-white/70 truncate transition-colors group-hover:text-white">
              {{ entry.basename }}
            </p>
            <div class="mt-0.5 flex gap-1 items-center">
              <p class="text-[10px]" style="color:var(--text-faint)">
                {{ (entry.file.size / 1024 / 1024).toFixed(0) }} MB
              </p>
              <span v-if="entry.hasScript" class="text-accent-300 text-[9px] px-1 rounded bg-accent-600/20">✦</span>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="px-4 text-center flex flex-1 flex-col gap-2 items-center justify-center">
        <p class="text-xs opacity-30">
          No videos match this rule.
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 0.18s ease;
  overflow: hidden;
}
.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  max-height: 0;
}
.slide-down-enter-to,
.slide-down-leave-from {
  opacity: 1;
  max-height: 300px;
}
</style>
