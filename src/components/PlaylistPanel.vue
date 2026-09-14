<script setup lang="ts">
import { ref, computed } from 'vue'
import { usePlaylistStore, evaluateSmartPlaylist } from '~/stores/playlistStore'
import type { SmartRule } from '~/stores/playlistStore'
import { useLibraryStore } from '~/stores/libraryStore'
import type { VideoEntry } from '~/stores/libraryStore'

const emit = defineEmits<{
  select: [entry: VideoEntry]
  queue:  [entries: VideoEntry[], selected: VideoEntry]
}>()

const vFocus = { mounted: (el: HTMLElement) => el.focus() }

const plStore = usePlaylistStore()
const library = useLibraryStore()

// â”€â”€â”€ View mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const viewMode = ref<'playlists' | 'smart'>('playlists')

// â”€â”€â”€ Active playlist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const activeId = ref('favorites')
const activePl = computed(() => plStore.playlists.find(p => p.id === activeId.value))

const resolvedEntries = computed(() => {
  if (!activePl.value) return []
  return activePl.value.entries
    .map(e => library.videos.find(v => v.name === e.videoName))
    .filter(Boolean) as VideoEntry[]
})

// â”€â”€â”€ Smart playlists â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const activeSmartId = ref(plStore.smartPlaylists[0]?.id ?? '')
const activeSmartPl = computed(() => plStore.smartPlaylists.find(p => p.id === activeSmartId.value))
const smartEntries = computed(() => {
  if (!activeSmartPl.value) return []
  return evaluateSmartPlaylist(activeSmartPl.value, library.videos)
})

const showNewSmart = ref(false)
const newSmartName = ref('')
const newSmartRuleType = ref<SmartRule['type']>('has_script')
const newSmartRuleTag = ref('')
const newSmartRuleRating = ref(3)

function createSmart() {
  const name = newSmartName.value.trim()
  if (!name) return
  let rule: SmartRule
  if (newSmartRuleType.value === 'has_tag') rule = { type: 'has_tag', tag: newSmartRuleTag.value.trim() }
  else if (newSmartRuleType.value === 'min_rating') rule = { type: 'min_rating', rating: newSmartRuleRating.value }
  else rule = { type: newSmartRuleType.value } as SmartRule
  const pl = plStore.createSmartPlaylist(name, [rule])
  activeSmartId.value = pl.id
  showNewSmart.value = false
  newSmartName.value = ''
}

// â”€â”€â”€ New playlist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const creatingNew = ref(false)
const newName = ref('')

function confirmCreate() {
  const name = newName.value.trim()
  if (!name) return
  const pl = plStore.createPlaylist(name)
  activeId.value = pl.id
  creatingNew.value = false
  newName.value = ''
}

// â”€â”€â”€ Rename â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const renamingId = ref<string | null>(null)
const renameVal = ref('')

function startRename(id: string, current: string) { renamingId.value = id; renameVal.value = current }
function confirmRename() {
  if (renamingId.value) plStore.renamePlaylist(renamingId.value, renameVal.value.trim())
  renamingId.value = null
}

// â”€â”€â”€ Export / Import â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    const f = input.files?.[0]; if (!f) return
    const text = await f.text()
    if (!plStore.importAll(text)) alert('Invalid playlist file')
  }
  input.click()
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0 text-sm">

    <!-- â”€â”€ Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
    <div class="flex items-center gap-1.5 px-3 py-2 border-b border-white/5 shrink-0">
      <!-- View toggle -->
      <div class="flex rounded overflow-hidden border border-white/10 text-[11px] shrink-0">
        <button class="px-2 py-0.5 transition-colors" :class="viewMode==='playlists'?'bg-accent-600 text-white':'text-white/40 hover:text-white/70'" @click="viewMode='playlists'">Lists</button>
        <button class="px-2 py-0.5 transition-colors" :class="viewMode==='smart'?'bg-accent-600 text-white':'text-white/40 hover:text-white/70'" @click="viewMode='smart'">Smart</button>
      </div>
      <div class="flex-1" />
      <template v-if="viewMode === 'playlists'">
        <button class="btn-ghost px-1.5 py-1" title="Export" @click="exportPlaylists">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
        </button>
        <button class="btn-ghost px-1.5 py-1" title="Import" @click="importPlaylists">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12"/></svg>
        </button>
        <button class="btn-primary text-[11px] px-2 py-1 shrink-0" @click="creatingNew = true">+ New</button>
      </template>
      <template v-else>
        <button class="btn-primary text-[11px] px-2 py-1 shrink-0" @click="showNewSmart = !showNewSmart">+ Smart</button>
      </template>
    </div>

    <!-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• PLAYLISTS VIEW â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• -->
    <template v-if="viewMode === 'playlists'">
      <!-- Playlist tabs -->
      <div class="flex flex-wrap gap-1 px-3 py-2 border-b border-white/5 shrink-0">
        <button
          v-for="pl in plStore.playlists" :key="pl.id"
          class="text-[11px] px-2 py-0.5 rounded-full transition-all truncate max-w-[120px]"
          :class="activeId === pl.id ? 'text-white font-semibold' : 'text-white/40 hover:text-white/70'"
          :style="activeId === pl.id ? { background: 'var(--accent)' } : {}"
          :title="pl.name"
          @click="activeId = pl.id"
          @dblclick="pl.id !== 'favorites' && startRename(pl.id, pl.name)"
        >
          <template v-if="renamingId === pl.id">
            <input v-model="renameVal" class="bg-transparent outline-none w-20 text-white"
              @blur="confirmRename" @keydown.enter="confirmRename" @keydown.esc="renamingId = null" @click.stop v-focus />
          </template>
          <template v-else>{{ pl.name }} <span class="opacity-50">({{ pl.entries.length }})</span></template>
        </button>
        <div v-if="creatingNew" class="flex items-center gap-1">
          <input v-model="newName" placeholder="Nameâ€¦" class="input text-[11px] py-0.5 px-2 h-6 w-28"
            @keydown.enter="confirmCreate" @keydown.esc="creatingNew=false;newName=''" v-focus />
          <button class="btn-ghost px-1 py-0.5 text-[11px] text-accent-400" @click="confirmCreate">âœ“</button>
          <button class="btn-ghost px-1 py-0.5 text-[11px] text-white/30" @click="creatingNew=false;newName=''">âœ•</button>
        </div>
      </div>

      <!-- Actions row -->
      <div v-if="activePl && activePl.id !== 'favorites'" class="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 shrink-0">
        <span class="text-[11px] flex-1" style="color:var(--text-faint)">{{ resolvedEntries.length }} / {{ activePl.entries.length }} loaded</span>
        <button class="text-[11px] text-red-400/60 hover:text-red-400 transition-colors" @click="plStore.deletePlaylist(activePl.id); activeId='favorites'">Delete list</button>
      </div>

      <!-- Empty -->
      <div v-if="!activePl || activePl.entries.length === 0" class="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center">
        <svg class="w-10 h-10 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/>
        </svg>
        <p class="text-xs" style="color:var(--text-faint)">
          {{ activePl?.id === 'favorites' ? 'Star videos in the library to add them here.' : 'Right-click videos in the library to add them.' }}
        </p>
      </div>

      <!-- Video list -->
      <div v-else class="flex-1 overflow-y-auto">
        <div v-for="entry in resolvedEntries" :key="entry.name"
          class="group flex items-center gap-2.5 px-3 py-2 hover:bg-white/5 transition-colors border-b border-white/[0.04] cursor-pointer"
          @click="emit('select', entry); emit('queue', resolvedEntries, entry)">
          <div class="w-14 h-8 rounded bg-surface-800 shrink-0 overflow-hidden">
            <img v-if="entry.thumbnailUrl" :src="entry.thumbnailUrl" class="w-full h-full object-cover" />
            <div v-else class="w-full h-full flex items-center justify-center">
              <svg class="w-4 h-4 text-white/15" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-xs text-white/70 group-hover:text-white truncate transition-colors">{{ entry.basename }}</p>
            <p class="text-[10px]" style="color:var(--text-faint)">{{ (entry.file.size/1024/1024).toFixed(0) }} MB</p>
          </div>
          <button class="opacity-0 group-hover:opacity-100 btn-ghost px-1 py-0.5 text-white/30 hover:text-red-400 transition-all"
            @click.stop="plStore.removeFromPlaylist(activeId, entry.name)">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div v-for="entry in activePl!.entries.filter(e => !library.videos.find(v => v.name === e.videoName))"
          :key="entry.videoName" class="flex items-center gap-2.5 px-3 py-2 border-b border-white/[0.04] opacity-40">
          <div class="w-14 h-8 rounded bg-surface-800 shrink-0" />
          <p class="text-xs flex-1 truncate" style="color:var(--text-faint)">{{ entry.videoName }}</p>
          <button class="btn-ghost px-1 py-0.5 text-white/20 hover:text-red-400" @click="plStore.removeFromPlaylist(activeId, entry.videoName)">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
    </template>

    <!-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• SMART PLAYLISTS VIEW â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• -->
    <template v-else>
      <!-- New smart playlist form -->
      <Transition name="slide-down">
        <div v-if="showNewSmart" class="px-3 py-2.5 border-b border-white/5 shrink-0 flex flex-col gap-2">
          <input v-model="newSmartName" class="input w-full text-xs py-1" placeholder="Playlist nameâ€¦" v-focus />
          <div class="flex gap-2">
            <select v-model="newSmartRuleType" class="input flex-1 text-xs py-1">
              <option value="has_script">Has Script</option>
              <option value="no_script">No Script</option>
              <option value="starred">Starred</option>
              <option value="multi_axis">Multi-Axis</option>
              <option value="has_tag">Has Tag</option>
              <option value="min_rating">Min Rating</option>
            </select>
          </div>
          <input v-if="newSmartRuleType === 'has_tag'" v-model="newSmartRuleTag" class="input w-full text-xs py-1" placeholder="Tag nameâ€¦" />
          <div v-if="newSmartRuleType === 'min_rating'" class="flex items-center gap-1">
            <span class="text-[11px] text-white/40 mr-1">Min:</span>
            <button v-for="n in 5" :key="n" class="text-base transition-colors"
              :class="newSmartRuleRating >= n ? 'text-yellow-400' : 'text-white/15 hover:text-white/40'"
              @click="newSmartRuleRating = n">â˜…</button>
          </div>
          <div class="flex gap-1.5">
            <button class="btn-primary flex-1 text-xs py-1" @click="createSmart">Create</button>
            <button class="btn-ghost flex-1 text-xs py-1" @click="showNewSmart=false">Cancel</button>
          </div>
        </div>
      </Transition>

      <!-- Smart playlist tabs -->
      <div class="flex flex-wrap gap-1 px-3 py-2 border-b border-white/5 shrink-0">
        <button v-for="pl in plStore.smartPlaylists" :key="pl.id"
          class="text-[11px] px-2 py-0.5 rounded-full transition-all truncate max-w-[140px]"
          :class="activeSmartId === pl.id ? 'text-white font-semibold' : 'text-white/40 hover:text-white/70'"
          :style="activeSmartId === pl.id ? { background: 'var(--accent)' } : {}"
          @click="activeSmartId = pl.id">
          {{ pl.name }}
        </button>
      </div>

      <!-- Smart result count + actions -->
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 shrink-0">
        <span class="text-[11px] flex-1" style="color:var(--text-faint)">
          {{ smartEntries.length }} video{{ smartEntries.length !== 1 ? 's' : '' }} match
          <span v-if="!library.hasVideos" class="text-amber-400/70"> Â· open a folder first</span>
        </span>
        <button v-if="activeSmartPl && !activeSmartPl.id.startsWith('smart:')"
          class="text-[11px] text-red-400/60 hover:text-red-400 transition-colors"
          @click="plStore.deleteSmartPlaylist(activeSmartPl.id); activeSmartId = plStore.smartPlaylists[0]?.id ?? ''">Delete</button>
        <button v-if="smartEntries.length" class="btn-ghost text-[11px] px-2 py-0.5"
          @click="if(smartEntries.length){emit('select', smartEntries[0]); emit('queue', smartEntries, smartEntries[0])}">
          â–¶ Play All
        </button>
      </div>

      <!-- Smart entries -->
      <div v-if="smartEntries.length" class="flex-1 overflow-y-auto">
        <div v-for="entry in smartEntries" :key="entry.name"
          class="group flex items-center gap-2.5 px-3 py-2 hover:bg-white/5 transition-colors border-b border-white/[0.04] cursor-pointer"
          @click="emit('select', entry); emit('queue', smartEntries, entry)">
          <div class="w-14 h-8 rounded bg-surface-800 shrink-0 overflow-hidden">
            <img v-if="entry.thumbnailUrl" :src="entry.thumbnailUrl" class="w-full h-full object-cover" />
            <div v-else class="w-full h-full flex items-center justify-center">
              <svg class="w-4 h-4 text-white/15" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-xs text-white/70 group-hover:text-white truncate transition-colors">{{ entry.basename }}</p>
            <div class="flex items-center gap-1 mt-0.5">
              <p class="text-[10px]" style="color:var(--text-faint)">{{ (entry.file.size/1024/1024).toFixed(0) }} MB</p>
              <span v-if="entry.hasScript" class="text-[9px] px-1 rounded bg-accent-600/20 text-accent-300">âœ¦</span>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center">
        <p class="text-xs opacity-30">No videos match this rule.</p>
      </div>
    </template>

  </div>
</template>

<style scoped>
.slide-down-enter-active, .slide-down-leave-active { transition: all 0.18s ease; overflow: hidden; }
.slide-down-enter-from, .slide-down-leave-to { opacity: 0; max-height: 0; }
.slide-down-enter-to, .slide-down-leave-from { opacity: 1; max-height: 300px; }
</style>