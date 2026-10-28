<script setup lang="ts">
import type { AnyViewId } from '~/lib/views'
import type { VideoEntry } from '~/stores/libraryStore'
import { computed, nextTick, ref, watch } from 'vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import { openFaceWindow } from '~/composables/useFaceScreen'
import { useSessionActions } from '~/composables/useSessionActions'
import { toast } from '~/composables/useToast'
import { formatTime } from '~/lib/time'
import { ALL_VIEWS } from '~/lib/views'
import { useBookmarkStore } from '~/stores/bookmarkStore'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useQueueStore } from '~/stores/queueStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useStatsStore } from '~/stores/statsStore'
import { THEMES, useThemeStore } from '~/stores/themeStore'
import { useUiStore } from '~/stores/uiStore'

/**
 * Ctrl+K: one box that reaches everything — views and panels, commands, and
 * every video in the library.
 *
 * Prefixes narrow the search: `>` commands, `/` views and panels, `#` videos.
 * With an empty box it shows what you used last, so the palette doubles as a
 * "do that again" key.
 */
const emit = defineEmits<{ openFile: [] }>()

const ui = useUiStore()
const session = useSessionActions()
const player = usePlayerStore()
const playback = usePlaybackStore()
const queue = useQueueStore()
const library = useLibraryStore()
const bookmarks = useBookmarkStore()
const stats = useStatsStore()
const theme = useThemeStore()

// ─── Items ───────────────────────────────────────────────────────────────────
type Kind = 'command' | 'view' | 'panel' | 'video'

interface Item {
  /** Stable, for the recent list. */
  id: string
  kind: Kind
  label: string
  hint?: string
  icon: string
  /** Extra words that should find this item without being shown. */
  keywords?: string
  kbd?: string[]
  /** Right-hand note, e.g. "Open" for a panel that is showing. */
  meta?: string
  /** Currently on (theme in use, shuffle on…). */
  on?: boolean
  entry?: VideoEntry
  run: (opts: { shift: boolean }) => void
}

const keys = (s?: string) => s ? s.split(' ') : undefined

function panic() {
  useSafetyStore().toggle()
}

async function openFolder() {
  try {
    if (await library.pickFolder())
      ui.openView('library')
  }
  catch (err) {
    console.error('Folder pick failed:', err)
  }
}

function starCurrent() {
  const entry = playback.currentEntry
  if (!entry)
    return
  library.toggleStar(entry)
  toast(entry.starred ? 'Starred' : 'Unstarred', { icon: entry.starred ? 'i-carbon-star-filled' : 'i-carbon-star', key: 'star' })
}

function addBookmark() {
  if (!player.videoPath)
    return
  const name = player.videoPath.split(/[\\/]/).pop() ?? player.videoPath
  bookmarks.add(name, player.currentTime)
  toast('Bookmark added', { icon: 'i-carbon-bookmark', key: 'bookmark' })
}

const commands = computed<Item[]>(() => {
  const loaded = !!player.videoUrl
  const has = library.hasVideos
  const current = playback.currentEntry
  const list: (Item | false)[] = [
    loaded && {
      id: 'cmd:play',
      kind: 'command',
      label: player.isPlaying ? 'Pause' : 'Play',
      icon: player.isPlaying ? 'i-carbon-pause-filled' : 'i-carbon-play-filled-alt',
      keywords: 'play pause resume toggle',
      kbd: ['Space'],
      run: () => playback.togglePlay(),
    },
    { id: 'cmd:play-link', kind: 'command', label: 'Play a link…', hint: 'Pixeldrain, Gofile, MEGA, Iwara and more', icon: 'i-carbon-link', keywords: 'url stream pixeldrain gofile mega iwara rule34video pmvhaven pornhub twitter yt-dlp paste', run: () => { ui.playLinkOpen = true } },
    { id: 'cmd:face-window', kind: 'command', label: 'Open face window', hint: 'Kerfus on a second screen', icon: 'i-carbon-screen', keywords: 'kerfus face cat second monitor screen display', run: openFaceWindow },
    { id: 'cmd:next', kind: 'command', label: 'Next video', icon: 'i-carbon-skip-forward', keywords: 'skip forward', kbd: ['N'], run: () => void playback.next() },
    loaded && { id: 'cmd:prev', kind: 'command', label: 'Previous video', icon: 'i-carbon-skip-back', keywords: 'back restart', kbd: ['P'], run: () => void playback.prev() },
    has && { id: 'cmd:random', kind: 'command', label: 'Random scripted video', icon: 'i-carbon-shuffle', keywords: 'surprise any', kbd: ['R'], run: () => {
      ui.openView('player')
      void playback.random()
    } },
    { id: 'cmd:shuffle', kind: 'command', label: queue.shuffle ? 'Turn shuffle off' : 'Turn shuffle on', icon: 'i-carbon-shuffle', keywords: 'shuffle random order', kbd: ['Shift', 'S'], on: queue.shuffle, run: () => playback.toggleShuffle() },
    {
      id: 'cmd:repeat',
      kind: 'command',
      label: 'Cycle repeat',
      hint: { off: 'Now off', all: 'Now repeating all', one: 'Now repeating one' }[queue.repeatMode],
      icon: queue.repeatMode === 'one' ? 'i-carbon-repeat-one' : 'i-carbon-repeat',
      keywords: 'loop repeat one all',
      kbd: ['Shift', 'R'],
      on: queue.repeatMode !== 'off',
      run: () => playback.cycleRepeat(),
    },
    loaded && { id: 'cmd:mute', kind: 'command', label: player.isMuted ? 'Unmute' : 'Mute', icon: player.isMuted ? 'i-carbon-volume-up' : 'i-carbon-volume-mute', keywords: 'sound audio volume', kbd: ['M'], run: () => playback.toggleMute() },
    loaded && { id: 'cmd:fullscreen', kind: 'command', label: 'Toggle fullscreen', icon: 'i-carbon-fit-to-screen', keywords: 'full screen maximise maximize', kbd: ['F'], run: () => {
      ui.openView('player')
      playback.toggleFullscreen()
    } },
    !!current && { id: 'cmd:star', kind: 'command', label: current.starred ? 'Unstar current video' : 'Star current video', icon: current.starred ? 'i-carbon-star-filled' : 'i-carbon-star', keywords: 'favourite favorite like', kbd: ['S'], on: current.starred, run: starCurrent },
    loaded && { id: 'cmd:bookmark', kind: 'command', label: 'Add bookmark here', icon: 'i-carbon-bookmark-add', keywords: 'mark position', kbd: ['B'], run: addBookmark },
    queue.upcoming.length > 0 && { id: 'cmd:clear-next', kind: 'command', label: 'Clear up next', hint: `${queue.upcoming.length} queued`, icon: 'i-carbon-clean', keywords: 'queue empty', run: () => queue.clearUpcoming() },
    { id: 'cmd:open-folder', kind: 'command', label: has ? 'Switch folder…' : 'Open folder…', icon: 'i-carbon-folder-add', keywords: 'library directory open browse', run: () => void openFolder() },
    { id: 'cmd:open-file', kind: 'command', label: 'Open video file…', icon: 'i-carbon-document-video', keywords: 'file open single', run: () => emit('openFile') },
    library.needsReconnect && !!library.savedFolderName && { id: 'cmd:reconnect', kind: 'command', label: `Reconnect “${library.savedFolderName}”`, icon: 'i-carbon-connect', keywords: 'folder permission restore library', run: () => void library.reconnect() },
    library.isWatching && { id: 'cmd:rescan', kind: 'command', label: 'Rescan library folder', icon: 'i-carbon-renew', keywords: 'refresh reload scan', run: () => void library.rescan() },
    { id: 'cmd:edge', kind: 'command', label: 'Edge', hint: 'Back everything off, then build again', icon: 'i-carbon-hourglass', keywords: 'close hold stop slow cooldown', kbd: ['E'], run: () => session.edge('ui') },
    loaded && { id: 'cmd:next-peak', kind: 'command', label: 'Jump to the next peak', icon: 'i-carbon-skip-forward-outline', keywords: 'good part intense fast chapter', kbd: ['G'], run: () => session.nextPeak() },
    loaded && { id: 'cmd:finish', kind: 'command', label: 'Finish', hint: 'Jump to the most intense part', icon: 'i-carbon-flash', keywords: 'climax end peak best', kbd: ['Shift', 'G'], run: () => session.finish() },
    loaded && { id: 'cmd:came', kind: 'command', label: 'I came', hint: 'Mark it on this video', icon: 'i-carbon-rain-drop', keywords: 'came cum finished orgasm mark', kbd: ['C'], run: () => session.came() },
    { id: 'cmd:panic', kind: 'command', label: 'Panic', hint: 'Stop everything and cover the screen', icon: 'i-carbon-warning-hex', keywords: 'stop emergency hide boss', kbd: ['Esc'], run: panic },
    { id: 'cmd:settings', kind: 'command', label: 'Open settings', icon: 'i-carbon-settings', keywords: 'preferences options config', run: () => (ui.settingsOpen = true) },
    { id: 'cmd:shortcuts', kind: 'command', label: 'Keyboard shortcuts', icon: 'i-carbon-keyboard', keywords: 'hotkeys keys help cheat sheet', kbd: ['?'], run: () => (ui.shortcutsOpen = true) },
    { id: 'cmd:sidebar', kind: 'command', label: ui.navExpanded ? 'Collapse sidebar' : 'Expand sidebar', icon: 'i-carbon-side-panel-open', keywords: 'nav labels navigation', run: () => (ui.navExpanded = !ui.navExpanded) },
    ...THEMES.map<Item>(t => ({
      id: `cmd:theme-${t.id}`,
      kind: 'command',
      label: `Theme: ${t.label}`,
      icon: t.id === 'light' ? 'i-carbon-sun' : 'i-carbon-moon',
      keywords: 'theme appearance colour color switch',
      on: theme.current === t.id,
      meta: theme.current === t.id ? 'Current' : undefined,
      run: () => theme.apply(t.id),
    })),
  ]
  return list.filter((c): c is Item => !!c)
})

const views = computed<Item[]>(() => ALL_VIEWS.map((v) => {
  const open = v.kind === 'view'
    ? ui.view === v.id
    : v.kind === 'inspector'
      ? ui.inspector === v.id || ui.pinned === v.id
      : ui.isFloatingOpen(v.id as 'emulator')
  return {
    id: `view:${v.id}`,
    kind: v.kind === 'view' ? 'view' : 'panel',
    label: v.label,
    hint: v.hint,
    icon: v.icon,
    kbd: keys(v.kbd),
    on: open,
    meta: v.kind === 'view' ? (open ? 'Showing' : undefined) : open ? 'Open' : v.kind === 'floating' ? 'Window' : 'Panel',
    run: () => {
      // Activating an open panel would close it; from the palette you want it shown.
      if (v.kind === 'inspector' && open)
        return
      ui.activate(v.id as AnyViewId)
    },
  }
}))

function videoItem(entry: VideoEntry): Item {
  const bits = [
    entry.hasScript ? (entry.scriptCount > 1 ? `${entry.scriptCount} axes` : 'Scripted') : 'No script',
    entry.duration ? formatTime(entry.duration) : '',
  ].filter(Boolean)
  return {
    id: `video:${entry.name}`,
    kind: 'video',
    label: entry.basename,
    hint: bits.join(' · '),
    icon: 'i-carbon-video',
    on: playback.currentEntry?.name === entry.name,
    meta: playback.currentEntry?.name === entry.name ? 'Playing' : undefined,
    entry,
    run: ({ shift }) => {
      if (shift) {
        playback.playNextInQueue(entry)
        return
      }
      ui.openView('player')
      void playback.play(entry)
    },
  }
}

// ─── Matching ────────────────────────────────────────────────────────────────
interface Hit { item: Item, score: number, hits: number[] }

const BOUNDARY = /[\s\-_.()[\]/:]/

/**
 * Substring first (scored by position and word start), then an in-order
 * subsequence with bonuses for runs and word starts — close enough to the
 * fuzzy finders people are used to, and cheap enough for a few thousand
 * file names per keystroke.
 */
function fuzzy(q: string, text: string, loose = true): { score: number, hits: number[] } | null {
  const t = text.toLowerCase()
  const at = t.indexOf(q)
  if (at >= 0) {
    const wordStart = at === 0 || BOUNDARY.test(t[at - 1])
    return {
      score: 100 + (wordStart ? 30 : 0) + (at === 0 ? 20 : 0) - at * 0.4 - (t.length - q.length) * 0.05,
      hits: Array.from({ length: q.length }, (_, i) => at + i),
    }
  }
  if (!loose)
    return null
  let from = 0
  let prev = -2
  let score = 0
  const hits: number[] = []
  for (const ch of q) {
    if (ch === ' ')
      continue
    const found = t.indexOf(ch, from)
    if (found < 0)
      return null
    const wordStart = found === 0 || BOUNDARY.test(t[found - 1])
    score += found === prev + 1 ? 6 : wordStart ? 5 : 1
    score -= Math.min(found - from, 12) * 0.25
    hits.push(found)
    prev = found
    from = found + 1
  }
  return { score, hits }
}

function match(q: string, item: Item): Hit | null {
  const onLabel = fuzzy(q, item.label)
  if (onLabel)
    return { item, ...onLabel }
  const extra = [item.keywords, item.kind === 'video' ? '' : item.hint].filter(Boolean).join(' ')
  const onExtra = extra ? fuzzy(q, extra) : null
  return onExtra ? { item, score: onExtra.score * 0.6, hits: [] } : null
}

// ─── Recent ──────────────────────────────────────────────────────────────────
const RECENT_KEY = 'ph:ui.palette.recent'
const RECENT_MAX = 6
const recentIds = ref<string[]>(loadRecent())

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
  }
  catch { return [] }
}

function remember(id: string) {
  recentIds.value = [id, ...recentIds.value.filter(x => x !== id)].slice(0, RECENT_MAX)
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds.value)) }
  catch {}
}

// ─── Results ─────────────────────────────────────────────────────────────────
const query = ref('')
const VIDEO_CAP = 30

const scope = computed<'all' | 'command' | 'view' | 'video'>(() => {
  const c = query.value.trimStart()[0]
  return c === '>' ? 'command' : c === '/' ? 'view' : c === '#' ? 'video' : 'all'
})
const needle = computed(() => {
  const q = query.value.trimStart()
  return (scope.value === 'all' ? q : q.slice(1)).trim().toLowerCase()
})

interface Group { id: string, title: string, rows: Hit[] }

const byName = computed(() => new Map(library.videos.map(v => [v.name, v])))

function recentlyPlayed(n: number): Item[] {
  const out: Item[] = []
  for (const s of stats.allStats()) {
    if (out.length >= n)
      break
    const e = byName.value.get(s.videoName)
    if (e)
      out.push(videoItem(e))
  }
  return out
}

const plain = (items: Item[]): Hit[] => items.map(item => ({ item, score: 0, hits: [] }))

const groups = computed<Group[]>(() => {
  if (!ui.paletteOpen)
    return []
  const q = needle.value
  const s = scope.value
  const cmd = commands.value
  const vw = views.value

  if (!q) {
    if (s === 'command')
      return [{ id: 'commands', title: 'Commands', rows: plain(cmd) }]
    if (s === 'view') {
      return [
        { id: 'views', title: 'Views', rows: plain(vw.filter(v => v.kind === 'view')) },
        { id: 'panels', title: 'Panels', rows: plain(vw.filter(v => v.kind === 'panel')) },
      ]
    }
    if (s === 'video') {
      const recent = recentlyPlayed(8)
      const seen = new Set(recent.map(r => r.id))
      const rest = library.videos.slice(0, VIDEO_CAP).map(videoItem).filter(v => !seen.has(v.id))
      return [
        { id: 'played', title: 'Recently played', rows: plain(recent) },
        { id: 'videos', title: 'Library', rows: plain(rest.slice(0, VIDEO_CAP - recent.length)) },
      ].filter(g => g.rows.length)
    }
    const all = new Map([...cmd, ...vw].map(i => [i.id, i]))
    const recent = recentIds.value
      .map(id => all.get(id) ?? (id.startsWith('video:') ? (e => e && videoItem(e))(byName.value.get(id.slice(6))) : undefined))
      .filter((i): i is Item => !!i)
    return [
      { id: 'recent', title: 'Recent', rows: plain(recent) },
      { id: 'played', title: 'Jump back in', rows: plain(recentlyPlayed(3)) },
      { id: 'views', title: 'Go to', rows: plain(vw.filter(v => v.kind === 'view')) },
      { id: 'commands', title: 'Commands', rows: plain(cmd.filter(c => !c.id.startsWith('cmd:theme-'))) },
      { id: 'panels', title: 'Panels', rows: plain(vw.filter(v => v.kind === 'panel')) },
    ].filter(g => g.rows.length)
  }

  const rank = (items: Item[], cap = Infinity) => items
    .map(i => match(q, i))
    .filter((h): h is Hit => !!h)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)

  const out: Group[] = []
  if (s === 'all' || s === 'command')
    out.push({ id: 'commands', title: 'Commands', rows: rank(cmd, 12) })
  if (s === 'all' || s === 'view') {
    out.push({ id: 'views', title: 'Views', rows: rank(vw.filter(v => v.kind === 'view')) })
    out.push({ id: 'panels', title: 'Panels', rows: rank(vw.filter(v => v.kind === 'panel')) })
  }
  if ((s === 'all' || s === 'video') && library.hasVideos) {
    const found: { entry: VideoEntry, score: number, hits: number[] }[] = []
    for (const entry of library.videos) {
      // One or two letters scattered across a long file name match nearly
      // everything, so short queries only count as a substring.
      const m = fuzzy(q, entry.basename, q.length > 2)
      if (m)
        found.push({ entry, score: m.score + (entry.starred ? 4 : 0), hits: m.hits })
    }
    found.sort((a, b) => b.score - a.score)
    // Only the rows that show pay for building an item.
    const rows: Hit[] = found.slice(0, VIDEO_CAP).map(f => ({ item: videoItem(f.entry), score: f.score, hits: f.hits }))
    out.push({ id: 'videos', title: found.length > VIDEO_CAP ? `Videos · top ${VIDEO_CAP} of ${found.length.toLocaleString()}` : 'Videos', rows })
  }
  // The group with the best match goes first, so Enter does the obvious thing.
  return out
    .filter(g => g.rows.length)
    .sort((a, b) => b.rows[0].score - a.rows[0].score)
})

const flat = computed(() => groups.value.flatMap(g => g.rows))
const active = ref(0)
// Reset on a new search only: the lists also change while playing (play/pause
// label, queue size), and the highlight should not jump when they do.
watch([needle, scope], () => (active.value = 0))
watch(() => flat.value.length, n => (active.value = Math.min(active.value, Math.max(0, n - 1))))

const activeItem = computed(() => flat.value[active.value]?.item)

/** Index of a row in the flat list, for the template. */
const offsets = computed(() => {
  const o: number[] = []
  let n = 0
  for (const g of groups.value) {
    o.push(n)
    n += g.rows.length
  }
  return o
})

function segments(label: string, hits: number[]) {
  if (!hits.length)
    return [{ text: label, hit: false }]
  const set = new Set(hits)
  const out: { text: string, hit: boolean }[] = []
  for (let i = 0; i < label.length; i++) {
    const hit = set.has(i)
    const last = out.at(-1)
    if (last && last.hit === hit)
      last.text += label[i]
    else
      out.push({ text: label[i], hit })
  }
  return out
}

// ─── Open / close / run ──────────────────────────────────────────────────────
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null

watch(() => ui.paletteOpen, (open) => {
  if (open) {
    returnFocus = document.activeElement as HTMLElement | null
    query.value = ''
    active.value = 0
    void nextTick(() => inputEl.value?.focus())
  }
  else if (returnFocus?.isConnected) {
    returnFocus.focus({ preventScroll: true })
    returnFocus = null
  }
})

function close() {
  ui.paletteOpen = false
}

/** Clicks inside the card must not take focus from the input, or the keys stop working. */
function keepFocus(e: MouseEvent) {
  if (e.target !== inputEl.value)
    e.preventDefault()
}

function run(i = active.value, shift = false) {
  const row = flat.value[i]
  if (!row)
    return
  remember(row.item.id)
  // Close first: what the item opens (settings, a picker) should land on a
  // clear screen, and panic must not see the palette as open.
  close()
  row.item.run({ shift })
}

function move(d: number) {
  const n = flat.value.length
  if (!n)
    return
  active.value = (active.value + d + n) % n
}

function clampMove(d: number) {
  const n = flat.value.length
  if (n)
    active.value = Math.max(0, Math.min(n - 1, active.value + d))
}

watch(active, i => nextTick(() => {
  listEl.value?.querySelector(`[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' })
}))

function onKey(e: KeyboardEvent) {
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); move(1); break
    case 'ArrowUp': e.preventDefault(); move(-1); break
    case 'PageDown': e.preventDefault(); clampMove(8); break
    case 'PageUp': e.preventDefault(); clampMove(-8); break
    case 'Tab': e.preventDefault(); move(e.shiftKey ? -1 : 1); break
    case 'Enter':
      e.preventDefault()
      run(active.value, e.shiftKey)
      break
    case 'Escape':
      e.preventDefault()
      e.stopPropagation()
      close()
      break
  }
}

/** Hover follows the pointer only when it actually moves, not when the list scrolls under it. */
function hover(i: number) {
  active.value = i
}

const KIND_LABEL: Record<Kind, string> = { command: 'Command', view: 'View', panel: 'Panel', video: 'Video' }

const SCOPES = [
  { prefix: '>', label: 'Commands' },
  { prefix: '/', label: 'Views & panels' },
  { prefix: '#', label: 'Videos' },
]

function setScope(prefix: string) {
  query.value = `${prefix}${needle.value}`
  inputEl.value?.focus()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="palette">
      <div
        v-if="ui.paletteOpen"
        class="palette-backdrop px-4 pt-[12vh] bg-black/45 flex items-start inset-0 justify-center fixed z-[950] backdrop-blur-[3px]"
        @pointerdown.self="close"
      >
        <div
          class="palette-card rounded-[var(--radius-xl)] bg-surface-850 flex flex-col max-h-[min(68vh,620px)] w-[min(640px,100%)] shadow-[var(--shadow-pop)] overflow-hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          @mousedown="keepFocus"
        >
          <!-- Search -->
          <div class="px-4 border-b border-edge flex shrink-0 gap-3 h-14 items-center">
            <span class="i-carbon-search text-[18px] text-fg-faint shrink-0" />
            <input
              ref="inputEl"
              v-model="query"
              type="text"
              class="text-[15px] text-fg outline-none bg-transparent flex-1 h-full min-w-0 placeholder:text-fg-faint"
              placeholder="Search videos, views and commands…"
              spellcheck="false"
              autocomplete="off"
              role="combobox"
              aria-expanded="true"
              aria-controls="ph-palette-list"
              :aria-activedescendant="flat.length ? `ph-palette-${active}` : undefined"
              @keydown="onKey"
            >
            <span v-if="scope !== 'all'" class="text-[11px] text-accent-300 font-medium px-2 rounded-full bg-accent-soft inline-flex shrink-0 h-5 animate-scale-in items-center">
              {{ SCOPES.find(s => s.prefix === query.trimStart()[0])?.label }}
            </span>
            <UiKbd class="shrink-0">
              Esc
            </UiKbd>
          </div>

          <!-- Results -->
          <div id="ph-palette-list" ref="listEl" class="p-2 scroll-y flex-1" role="listbox">
            <template v-for="(g, gi) in groups" :key="g.id">
              <div class="eyebrow px-2.5 pb-1.5 pt-2.5" :class="gi === 0 ? '!pt-1' : ''">
                {{ g.title }}
              </div>
              <div
                v-for="(row, ri) in g.rows"
                :id="`ph-palette-${offsets[gi] + ri}`"
                :key="row.item.id"
                :data-idx="offsets[gi] + ri"
                role="option"
                :aria-selected="active === offsets[gi] + ri"
                class="px-2.5 rounded-[var(--radius-md)] flex gap-3 cursor-pointer transition-colors duration-100 items-center relative"
                :class="[
                  row.item.kind === 'video' ? 'h-12' : 'h-10',
                  active === offsets[gi] + ri ? 'bg-fg/7' : '',
                ]"
                @mousemove="hover(offsets[gi] + ri)"
                @click="run(offsets[gi] + ri)"
              >
                <span
                  v-if="active === offsets[gi] + ri"
                  class="rounded-full bg-accent w-[3px] animate-fade-in bottom-2 left-0 top-2 absolute"
                />
                <!-- Icon, or a thumbnail for videos -->
                <span
                  v-if="row.item.kind === 'video' && row.item.entry?.thumbnailUrl"
                  class="rounded-[var(--radius-xs)] bg-surface-800 shrink-0 h-[34px] w-[60px] ring-1 ring-edge overflow-hidden"
                >
                  <img :src="row.item.entry.thumbnailUrl" alt="" class="h-full w-full object-cover" loading="lazy">
                </span>
                <span
                  v-else
                  class="rounded-[var(--radius-sm)] center shrink-0 transition-colors"
                  :class="[
                    row.item.kind === 'video' ? 'h-[34px] w-[60px] bg-surface-800 ring-1 ring-edge' : 'h-7 w-7',
                    active === offsets[gi] + ri && row.item.kind !== 'video' ? 'bg-accent-soft text-accent-300' : row.item.on ? 'text-accent-300 bg-fg/5' : 'text-fg-muted bg-fg/5',
                  ]"
                >
                  <span :class="row.item.icon" class="text-[15px]" />
                </span>

                <span class="flex flex-1 flex-col min-w-0">
                  <span class="text-[13.5px] text-fg truncate">
                    <template v-for="(seg, si) in segments(row.item.label, row.hits)" :key="si">
                      <mark v-if="seg.hit" class="text-accent-300 font-semibold bg-transparent">{{ seg.text }}</mark>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                  <span v-if="row.item.hint && (row.item.kind === 'video' || active === offsets[gi] + ri)" class="text-[11.5px] text-fg-faint truncate">
                    {{ row.item.hint }}
                  </span>
                </span>

                <span v-if="row.item.entry?.starred" class="i-carbon-star-filled text-[12px] text-warn shrink-0" />
                <span v-if="row.item.meta" class="text-[11px] shrink-0" :class="row.item.on ? 'text-accent-300' : 'text-fg-faint'">
                  {{ row.item.meta }}
                </span>
                <span v-if="row.item.kbd" class="flex shrink-0 gap-1">
                  <UiKbd v-for="k in row.item.kbd" :key="k">{{ k }}</UiKbd>
                </span>
              </div>
            </template>

            <!-- Nothing found -->
            <div v-if="!flat.length" class="px-6 py-10 text-center flex flex-col gap-2 items-center">
              <span class="i-carbon-search text-[22px] text-fg-faint" />
              <p class="text-[13.5px] text-fg m-0">
                Nothing matches “{{ needle }}”
              </p>
              <p class="hint m-0">
                {{ scope === 'video' && !library.hasVideos ? 'Open a folder to search your videos.' : 'Try fewer letters, or another scope below.' }}
              </p>
            </div>
          </div>

          <!-- Footer -->
          <div class="text-[11.5px] text-fg-faint px-3 border-t border-edge bg-surface-900/50 flex shrink-0 gap-4 h-10 items-center">
            <span class="flex gap-1.5 items-center"><UiKbd>↑</UiKbd><UiKbd>↓</UiKbd> Move</span>
            <span class="flex gap-1.5 items-center"><UiKbd>↵</UiKbd> {{ activeItem ? (activeItem.kind === 'video' ? 'Play' : activeItem.kind === 'command' ? 'Run' : 'Open') : 'Select' }}</span>
            <span v-if="activeItem?.kind === 'video'" class="flex gap-1.5 animate-fade-in items-center"><UiKbd>Shift</UiKbd><UiKbd>↵</UiKbd> Play next</span>
            <span class="ml-auto flex gap-1 items-center">
              <button
                v-for="s in SCOPES"
                :key="s.prefix"
                v-tip="`Type ${s.prefix} to search ${s.label.toLowerCase()} only`"
                type="button"
                class="px-1.5 focusable rounded-[var(--radius-xs)] h-6 transition-colors hover:text-fg hover:bg-fg/6"
                :class="scope !== 'all' && query.trimStart()[0] === s.prefix ? 'text-accent-300' : ''"
                @click="setScope(s.prefix)"
              >
                <span class="font-mono mr-1">{{ s.prefix }}</span>{{ s.label }}
              </button>
            </span>
            <span class="sr-only">{{ activeItem ? KIND_LABEL[activeItem.kind] : '' }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.palette-enter-active {
  transition: opacity var(--dur) var(--ease-out);
}
.palette-leave-active {
  transition: opacity 120ms ease-in;
  pointer-events: none;
}
.palette-enter-active .palette-card {
  transition:
    transform var(--dur-slow) var(--ease-out),
    opacity var(--dur) var(--ease-out);
}
.palette-leave-active .palette-card {
  transition:
    transform 120ms ease-in,
    opacity 120ms ease-in;
}
.palette-enter-from,
.palette-leave-to {
  opacity: 0;
}
.palette-enter-from .palette-card {
  transform: translateY(-10px) scale(0.97);
}
.palette-leave-to .palette-card {
  transform: scale(0.98);
}
</style>
