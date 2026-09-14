<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useOrganizerStore, type OrgPair } from '@/stores/organizerStore'
import { extOf } from '@/lib/fsRename'
import type { FsEntry } from '@/lib/fsWalk'
import { parseFunscriptContent, type ParsedAxis, type FunscriptAction } from '@/lib/funscriptParser'

const organizer = useOrganizerStore()

// ─── Filter / search ────────────────────────────────────────────────────────
type FilterMode = 'all' | 'matched' | 'video-only' | 'script-only'
const filterMode = ref<FilterMode>('all')
const search = ref('')

const filteredPairs = computed(() => {
  let list = organizer.pairs
  if (filterMode.value !== 'all') list = list.filter(p => p.status === filterMode.value)
  const q = search.value.trim().toLowerCase()
  if (q) list = list.filter(p => p.basename.toLowerCase().includes(q) || p.dir.toLowerCase().includes(q))
  return list
})

function statusLabel(s: OrgPair['status']) {
  return s === 'matched' ? 'Matched' : s === 'video-only' ? 'No script' : 'Orphan script'
}
function statusBadgeClass(s: OrgPair['status']) {
  if (s === 'matched') return 'bg-emerald-900/30 text-emerald-400'
  if (s === 'video-only') return 'bg-amber-900/30 text-amber-400'
  return 'bg-rose-900/30 text-rose-400'
}
function statusDotClass(s: OrgPair['status']) {
  if (s === 'matched') return 'bg-emerald-400'
  if (s === 'video-only') return 'bg-amber-400'
  return 'bg-rose-400'
}

// ─── Inline rename: pair basename (renames video + all its matched scripts) ──
const editingKey = ref<string | null>(null)
const editDraft = ref('')
let skipCommit = false

/** Function-ref: focuses the rename input as soon as it mounts. Using a plain
 * ref object here would collect into an array (these inputs live inside a
 * v-for), so a function ref is used instead to target the single element. */
function focusAndSelect(el: unknown) {
  if (!el) return
  const input = el as HTMLInputElement
  input.focus()
  input.select()
}

function startEdit(pair: OrgPair) {
  editingKey.value = pair.key
  editDraft.value = pair.basename
  skipCommit = false
}
function cancelEdit() { skipCommit = true; editingKey.value = null }
async function commitEdit(pair: OrgPair) {
  if (skipCommit) { skipCommit = false; return }
  const val = editDraft.value
  editingKey.value = null
  if (val.trim() && val.trim() !== pair.basename) {
    if (expandedKey.value === pair.key) collapse()
    await organizer.renamePair(pair, val)
  }
}

// ─── Inline rename: a single script file within a pair (e.g. fix one alt-axis name) ──
const editingScript = ref<FsEntry | null>(null)
const editScriptDraft = ref('')
let skipScriptCommit = false

function startEditScript(s: FsEntry) {
  editingScript.value = s
  editScriptDraft.value = s.name.slice(0, s.name.length - extOf(s.name).length)
  skipScriptCommit = false
}
function cancelEditScript() { skipScriptCommit = true; editingScript.value = null }
async function commitEditScript(pair: OrgPair, s: FsEntry) {
  if (skipScriptCommit) { skipScriptCommit = false; return }
  const val = editScriptDraft.value.trim()
  editingScript.value = null
  const currentBase = s.name.slice(0, s.name.length - extOf(s.name).length)
  if (val && val !== currentBase) await organizer.renameSingle(pair, s, val + extOf(s.name))
}

// ─── Preview: expand a pair to show the video player + script sparklines ────
interface ScriptPreview { loading: boolean; error?: string; axes?: ParsedAxis[] }
const expandedKey = ref<string | null>(null)
const videoUrls = new Map<string, string>()          // pair.key -> object URL
const scriptPreviews = reactive(new Map<string, ScriptPreview>()) // FsEntry.relPath -> preview

function collapse() {
  if (expandedKey.value) {
    const url = videoUrls.get(expandedKey.value)
    if (url) { URL.revokeObjectURL(url); videoUrls.delete(expandedKey.value) }
  }
  expandedKey.value = null
}

async function toggleExpand(pair: OrgPair) {
  if (expandedKey.value === pair.key) { collapse(); return }
  collapse()
  expandedKey.value = pair.key

  if (pair.video) videoUrls.set(pair.key, URL.createObjectURL(pair.video.file))

  for (const s of pair.scripts) {
    if (scriptPreviews.has(s.relPath)) continue
    scriptPreviews.set(s.relPath, { loading: true })
    try {
      const text = await s.file.text()
      const parsed = parseFunscriptContent(text, s.relPath, pair.basename)
      scriptPreviews.set(s.relPath, { loading: false, axes: parsed.axes })
    } catch {
      scriptPreviews.set(s.relPath, { loading: false, error: 'Could not parse this .funscript' })
    }
  }
}

/** Downsampled SVG polyline points for a quick visual read of the stroke pattern */
function sparklinePoints(actions: FunscriptAction[]): string {
  if (!actions.length) return ''
  const duration = actions[actions.length - 1].at || 1
  const stride = Math.max(1, Math.floor(actions.length / 300))
  const pts: string[] = []
  for (let i = 0; i < actions.length; i += stride) {
    const a = actions[i]
    pts.push(`${((a.at / duration) * 300).toFixed(1)},${(40 - a.pos * 40).toFixed(1)}`)
  }
  return pts.join(' ')
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60), sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

onUnmounted(collapse)

// ─── Bulk find/replace ────────────────────────────────────────────────────────
const bulkOpen = ref(false)
const findText = ref('')
const replaceText = ref('')
const useRegex = ref(false)
const bulkStatus = ref<string | null>(null)

const bulkPreviewCount = computed(() => {
  if (!findText.value) return 0
  try {
    const re = useRegex.value
      ? new RegExp(findText.value, 'g')
      : new RegExp(findText.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    return filteredPairs.value.filter(p => p.basename.replace(re, replaceText.value) !== p.basename).length
  } catch {
    return 0
  }
})

async function applyBulkRename() {
  bulkStatus.value = null
  const n = await organizer.bulkRename(filteredPairs.value, findText.value, replaceText.value, useRegex.value)
  bulkStatus.value = organizer.error ? null : `Renamed ${n} item${n === 1 ? '' : 's'}`
  if (n > 0) { findText.value = ''; replaceText.value = '' }
}

// ─── Directory grouping (for header rows in the flat sorted list) ────────────
function isNewGroup(list: OrgPair[], i: number) {
  return i === 0 || list[i - 1].dir !== list[i].dir
}

onMounted(async () => {
  await organizer.restoreFolder()
})
</script>

<template>
  <div class="flex flex-col h-full min-h-0 text-xs">

    <!-- ══ Header ═════════════════════════════════════════════════════════════ -->
    <div class="flex items-center gap-1 px-2 py-1.5 border-b border-white/5 shrink-0">
      <span class="truncate flex-1 min-w-0 font-medium" style="color:var(--text-muted)">
        {{ organizer.rootName || 'Organizer' }}
        <span v-if="organizer.hasRoot" style="color:var(--text-faint)"> [{{ filteredPairs.length }}/{{ organizer.pairs.length }}]</span>
      </span>

      <button v-if="organizer.hasRoot && !organizer.writable" class="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-400 hover:bg-amber-900/50 transition-colors shrink-0" @click="organizer.retryPermission">
        ⚠ Read-only — enable editing
      </button>

      <button v-if="organizer.hasRoot" class="btn-ghost px-1.5 py-1" title="Rescan folder" @click="organizer.rescan" :disabled="organizer.scanning">
        <svg class="w-3.5 h-3.5" :class="organizer.scanning ? 'animate-spin' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
      </button>
      <button class="btn-ghost px-2 py-1 shrink-0" title="Reuse the folder open in Library" @click="organizer.useLibraryFolder">Use Library</button>
      <button class="btn-primary px-2 py-1 shrink-0" @click="organizer.openFolder">Open</button>
    </div>

    <!-- ══ Error ══════════════════════════════════════════════════════════════ -->
    <div v-if="organizer.error" class="flex items-center gap-2 px-3 py-1.5 shrink-0 text-red-400 text-[11px] bg-red-950/30 border-b border-red-900/30">
      <span class="flex-1">{{ organizer.error }}</span>
      <button class="text-white/30 hover:text-white/60" @click="organizer.error = null">✕</button>
    </div>

    <!-- ══ Empty ══════════════════════════════════════════════════════════════ -->
    <div v-if="!organizer.hasRoot && !organizer.restoring" class="flex-1 flex flex-col items-center justify-center gap-3 px-4 text-center" style="color:var(--text-faint)">
      <svg class="w-12 h-12 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
      </svg>
      <div>
        <p class="text-sm font-medium mb-1 text-white/50">Open a folder to organize</p>
        <p class="text-[11px] opacity-60">Videos and .funscript files get paired up automatically per folder.</p>
      </div>
      <div class="flex gap-2">
        <button class="btn-ghost px-3 py-1.5" @click="organizer.useLibraryFolder">Use Library Folder</button>
        <button class="btn-primary px-3 py-1.5" @click="organizer.openFolder">Choose Folder</button>
      </div>
    </div>

    <template v-else-if="organizer.hasRoot">
      <!-- ══ Search + filters ═══════════════════════════════════════════════ -->
      <div class="shrink-0 px-2 pt-2 pb-1.5 border-b border-white/5 flex flex-col gap-1.5">
        <input v-model="search" type="text" placeholder="Search…" class="input w-full py-1 h-7" />
        <div class="flex items-center gap-1 flex-wrap">
          <button class="chip" :class="filterMode==='all' ? 'chip-active' : ''" @click="filterMode='all'">All {{ organizer.pairs.length }}</button>
          <button class="chip chip-warn" :class="filterMode==='video-only' ? 'chip-active-warn' : ''" @click="filterMode='video-only'">⚠ No script {{ organizer.missingScriptCount }}</button>
          <button class="chip chip-danger" :class="filterMode==='script-only' ? 'chip-active-danger' : ''" @click="filterMode='script-only'">⚠ Orphan {{ organizer.orphanScriptCount }}</button>
          <button class="chip chip-ok" :class="filterMode==='matched' ? 'chip-active-ok' : ''" @click="filterMode='matched'">✓ Matched {{ organizer.matchedCount }}</button>
        </div>
      </div>

      <!-- ══ Bulk rename ═══════════════════════════════════════════════════ -->
      <div class="shrink-0 border-b border-white/5">
        <button class="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] hover:bg-white/5 transition-colors" style="color:var(--text-muted)" @click="bulkOpen = !bulkOpen">
          <svg class="w-3 h-3 transition-transform" :class="bulkOpen ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
          Find &amp; replace (bulk rename)
        </button>
        <div v-if="bulkOpen" class="px-2 pb-2 flex flex-col gap-1.5">
          <div class="flex gap-1.5">
            <input v-model="findText" class="input flex-1 h-7 py-1" placeholder="Find…" />
            <input v-model="replaceText" class="input flex-1 h-7 py-1" placeholder="Replace with…" />
          </div>
          <div class="flex items-center gap-2">
            <label class="flex items-center gap-1 text-[10px] cursor-pointer" style="color:var(--text-faint)">
              <input type="checkbox" v-model="useRegex" class="accent-current" /> regex
            </label>
            <span class="text-[10px] flex-1" style="color:var(--text-faint)">
              {{ findText ? `${bulkPreviewCount} of ${filteredPairs.length} shown items will change` : 'Applies to the currently filtered list' }}
            </span>
            <button class="btn-primary px-2 py-1 text-[11px]" :disabled="!findText || bulkPreviewCount===0" @click="applyBulkRename">Apply</button>
          </div>
          <p v-if="bulkStatus" class="text-[10px] text-emerald-400">{{ bulkStatus }}</p>
        </div>
      </div>

      <!-- ══ Status ═════════════════════════════════════════════════════════ -->
      <div v-if="organizer.restoring || organizer.scanning" class="flex items-center gap-2 px-3 py-2 shrink-0">
        <div class="w-2 h-2 rounded-full bg-accent-500 animate-pulse shrink-0" />
        <span class="text-[11px] text-white/40">{{ organizer.restoring ? 'Restoring folder…' : 'Scanning…' }}</span>
      </div>

      <!-- ══ List ═══════════════════════════════════════════════════════════ -->
      <div v-else class="flex-1 overflow-y-auto">
        <p v-if="filteredPairs.length === 0" class="text-center text-white/25 py-6 text-[11px]">No items match.</p>

        <template v-for="(pair, i) in filteredPairs" :key="pair.key">
          <div v-if="isNewGroup(filteredPairs, i)" class="px-3 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider truncate" style="color:var(--text-faint)">
            {{ pair.dir || '(root)' }}
          </div>

          <div class="flex items-start gap-2 px-3 py-2 border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors">
            <span class="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" :class="statusDotClass(pair.status)" :title="statusLabel(pair.status)" />

            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <input
                  v-if="editingKey === pair.key"
                  :ref="focusAndSelect"
                  v-model="editDraft"
                  class="input flex-1 h-6 py-0.5 text-xs font-medium min-w-0"
                  @blur="commitEdit(pair)"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                  @keydown.escape="cancelEdit(); ($event.target as HTMLInputElement).blur()"
                />
                <button v-else class="text-xs font-medium truncate text-left hover:text-accent-400 transition-colors min-w-0" :title="`${pair.basename} — click to rename`" @click="startEdit(pair)">
                  {{ pair.basename }}
                </button>
                <span class="text-[9px] px-1.5 py-0.5 rounded-full shrink-0" :class="statusBadgeClass(pair.status)">{{ statusLabel(pair.status) }}</span>
                <span v-if="organizer.renamingKey === pair.key" class="w-2.5 h-2.5 rounded-full border border-white/20 border-t-white/60 animate-spin shrink-0" />
              </div>

              <div class="flex flex-wrap gap-1 mt-1">
                <span v-if="pair.video" class="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-white/40 truncate max-w-full" :title="pair.video.name">
                  🎬 {{ pair.video.name }}
                </span>

                <template v-for="s in pair.scripts" :key="s.relPath">
                  <input
                    v-if="editingScript === s"
                    :ref="focusAndSelect"
                    v-model="editScriptDraft"
                    class="input h-5 py-0 px-1.5 text-[10px] w-32"
                    @blur="commitEditScript(pair, s)"
                    @keydown.enter="($event.target as HTMLInputElement).blur()"
                    @keydown.escape="cancelEditScript(); ($event.target as HTMLInputElement).blur()"
                  />
                  <span v-else class="text-[9px] px-1.5 py-0.5 rounded bg-accent-900/20 text-accent-300 cursor-pointer hover:bg-accent-900/40 truncate max-w-full" :title="`${s.name} — click to rename`" @click="startEditScript(s)">
                    📜 {{ s.name }}
                  </span>
                </template>
              </div>
            </div>

            <button class="btn-ghost px-1 py-1 shrink-0" title="Preview video &amp; script" @click="toggleExpand(pair)">
              <svg class="w-3.5 h-3.5 transition-transform" :class="expandedKey === pair.key ? 'rotate-180' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
              </svg>
            </button>
          </div>

          <!-- ══ Preview ═════════════════════════════════════════════════════ -->
          <div v-if="expandedKey === pair.key" class="px-3 pb-3 pt-2 flex flex-col gap-2 bg-black/20 border-b border-white/[0.04]">
            <video
              v-if="pair.video"
              :src="videoUrls.get(pair.key)"
              controls
              preload="metadata"
              class="w-full max-h-52 rounded bg-black"
            />
            <p v-else class="text-[10px] italic" style="color:var(--text-faint)">No video to preview.</p>

            <div v-for="s in pair.scripts" :key="'preview-' + s.relPath" class="rounded bg-white/5 px-2 py-1.5">
              <p class="text-[10px] text-white/40 mb-1 truncate" :title="s.name">{{ s.name }}</p>

              <p v-if="scriptPreviews.get(s.relPath)?.loading" class="text-[10px] text-white/25">Loading…</p>
              <p v-else-if="scriptPreviews.get(s.relPath)?.error" class="text-[10px] text-red-400/70">{{ scriptPreviews.get(s.relPath)!.error }}</p>
              <template v-else-if="scriptPreviews.get(s.relPath)?.axes">
                <div v-for="axis in scriptPreviews.get(s.relPath)!.axes" :key="axis.channel" class="mb-1.5 last:mb-0">
                  <div class="flex items-center gap-1.5 mb-0.5">
                    <span class="text-[9px] font-mono font-bold text-accent-300 bg-accent-900/40 px-1 rounded shrink-0">{{ axis.channel }}</span>
                    <span class="text-[9px] text-white/30 truncate">{{ axis.label }} · {{ axis.actions.length }} pts · {{ formatMs(axis.duration) }}</span>
                  </div>
                  <svg v-if="axis.actions.length" viewBox="0 0 300 40" preserveAspectRatio="none" class="w-full h-8 text-accent-400">
                    <polyline :points="sparklinePoints(axis.actions)" fill="none" stroke="currentColor" stroke-width="1.5" />
                  </svg>
                </div>
              </template>
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chip {
  padding: 0.15rem 0.5rem;
  border-radius: 9999px;
  border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.4);
  font-size: 11px;
  transition: all 0.15s;
  white-space: nowrap;
  cursor: pointer;
}
.chip:hover { color: rgba(255,255,255,0.7); border-color: rgba(255,255,255,0.2); }
.chip-active { border-color: var(--accent, rgb(99,102,241)); color: white; font-weight: 600; background: var(--accent-dim, rgba(99,102,241,0.2)); }
.chip-active-warn { border-color: rgba(245,158,11,0.6); color: #fbbf24; font-weight: 600; background: rgba(245,158,11,0.15); }
.chip-active-danger { border-color: rgba(244,63,94,0.6); color: #fb7185; font-weight: 600; background: rgba(244,63,94,0.15); }
.chip-active-ok { border-color: rgba(16,185,129,0.6); color: #34d399; font-weight: 600; background: rgba(16,185,129,0.15); }
</style>
