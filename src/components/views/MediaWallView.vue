<script setup lang="ts">
import type { MenuItem } from '~/components/ui/menu'
import type { Edges, Guide, Rect } from '~/composables/wallGeometry'
import type { WallItem } from '~/stores/mediaWall'
import { useElementSize, useLocalStorage } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiContextMenu from '~/components/ui/UiContextMenu.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import UiSection from '~/components/ui/UiSection.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import AddYoutubeModal from '~/components/views/AddYoutubeModal.vue'
import MediaWallItem from '~/components/views/MediaWallItem.vue'
import { useIdleChrome } from '~/composables/useIdleChrome'
import { mediaKind, pickMediaFiles, useMediaDrop } from '~/composables/useMediaDrop'
import { toast } from '~/composables/useToast'
import { arrangeGrid, MIN_H, MIN_W, snapRect } from '~/composables/wallGeometry'
import { useMediaWallStore } from '~/stores/mediaWall'
import { usePlayerStore } from '~/stores/playerStore'
import { useUiStore } from '~/stores/uiStore'

defineOptions({ name: 'MediaWallView' })

const { items, addItem, removeItem, updateItem, clearAll } = useMediaWallStore()
const ui = useUiStore()
const player = usePlayerStore()

const wallEl = ref<HTMLElement | null>(null)
const { width: wallW, height: wallH } = useElementSize(wallEl)

const selectedId = ref<string | null>(null)
const selected = computed(() => items.value.find(i => i.id === selectedId.value) ?? null)
const ytOpen = ref(false)
const sheetOpen = ref(false)
const overToolbar = ref(false)
const menu = ref<{ x: number, y: number, items: MenuItem[] } | null>(null)

const snapping = useLocalStorage('ph-wall-snap', true)
const showGrid = useLocalStorage('ph-wall-grid', true)

/** Top of the stack first, the way a layers list reads. */
const layers = computed(() => [...items.value].sort((a, b) => b.zIndex - a.zIndex))

const chrome = useIdleChrome({
  enabled: () => items.value.length > 0,
  hold: () => overToolbar.value || sheetOpen.value || ytOpen.value || !!menu.value,
})

// ─── Adding ─────────────────────────────────────────────────────────────────
/** Tiles added this session take their media's shape once it has loaded. */
const fresh = new Set<string>()
/** Natural aspect per tile, as reported by the media. */
const aspects = reactive(new Map<string, number>())

function viewCentre() {
  return { x: (wallW.value || 800) / 2, y: (wallH.value || 600) / 2 }
}

function clampToWall(x: number, y: number, w: number, h: number) {
  const W = wallW.value || 800
  const H = wallH.value || 600
  return {
    x: Math.round(Math.max(8, Math.min(W - w - 8, x))),
    y: Math.round(Math.max(8, Math.min(H - h - 8, y))),
  }
}

/** Where the next tile goes when there is no drop point: a gentle cascade. */
function cascade(w: number, h: number, i = 0) {
  const c = viewCentre()
  const step = ((items.value.length + i) % 8) * 24
  return clampToWall(c.x - w / 2 - 84 + step, c.y - h / 2 - 84 + step, w, h)
}

function addFiles(files: File[], at?: { x: number, y: number }) {
  let last: WallItem | null = null
  files.forEach((file, i) => {
    const kind = mediaKind(file)
    if (!kind)
      return
    const w = 320
    const h = kind === 'image' ? 240 : 180
    const pos = at
      ? clampToWall(at.x - w / 2 + i * 24, at.y - h / 2 + i * 24, w, h)
      : cascade(w, h, i)
    last = addItem({
      type: kind,
      src: URL.createObjectURL(file),
      label: file.name,
      ...pos,
      width: w,
      height: h,
      opacity: 1,
      playbackRate: 1,
      muted: true,
    })
    fresh.add(last.id)
    bringToFront(last.id)
  })
  if (last)
    selectedId.value = (last as WallItem).id
}

function addFromDisk() {
  pickMediaFiles(files => addFiles(files))
}

function addYoutube({ youtubeId, label }: { youtubeId: string, label: string }) {
  const w = 426
  const h = 240
  const item = addItem({ type: 'youtube', src: youtubeId, label, ...cascade(w, h), width: w, height: h, opacity: 1, playbackRate: 1, muted: true })
  bringToFront(item.id)
  selectedId.value = item.id
}

const drop = useMediaDrop((files, e) => {
  const r = wallEl.value?.getBoundingClientRect()
  addFiles(files, r ? { x: e.clientX - r.left, y: e.clientY - r.top } : undefined)
})

function onNatural(item: WallItem, aspect: number) {
  aspects.set(item.id, aspect)
  if (!fresh.has(item.id))
    return
  fresh.delete(item.id)
  matchShape(item)
}

/** Reshape a tile to its media's aspect, keeping roughly the same area. */
function matchShape(item: WallItem) {
  const aspect = aspects.get(item.id)
  if (!aspect)
    return
  const area = item.width * item.height
  let w = Math.sqrt(area * aspect)
  let h = w / aspect
  if (w < MIN_W) {
    w = MIN_W
    h = w / aspect
  }
  if (h < MIN_H) {
    h = MIN_H
    w = h * aspect
  }
  const cx = item.x + item.width / 2
  const cy = item.y + item.height / 2
  updateItem(item.id, { width: Math.round(w), height: Math.round(h), ...clampToWall(cx - w / 2, cy - h / 2, w, h) })
}

// ─── Stacking ───────────────────────────────────────────────────────────────
// Stacking is worked out from the tiles themselves rather than the store's
// counter, which restarts at 1 on reload while saved YouTube tiles keep their
// old, higher z.
function bringToFront(id: string) {
  const item = items.value.find(i => i.id === id)
  if (!item)
    return
  const top = Math.max(0, ...items.value.filter(i => i.id !== id).map(i => i.zIndex))
  if (item.zIndex <= top)
    updateItem(id, { zIndex: top + 1 })
}

function sendToBack(id: string) {
  const rest = items.value.filter(i => i.id !== id).sort((a, b) => a.zIndex - b.zIndex)
  updateItem(id, { zIndex: 1 })
  rest.forEach((it, i) => updateItem(it.id, { zIndex: i + 2 }))
}

// ─── Removing (with undo) ───────────────────────────────────────────────────
// Object URLs are never revoked, so an undone tile comes back playing.
function restore(snapshot: WallItem[]) {
  for (const s of snapshot) {
    const { id: _id, zIndex, ...rest } = s
    const n = addItem(rest)
    updateItem(n.id, { zIndex })
  }
}

function remove(id: string) {
  const item = items.value.find(i => i.id === id)
  if (!item)
    return
  const snapshot = { ...item }
  removeItem(id)
  if (selectedId.value === id)
    selectedId.value = null
  toast('Removed from the wall', {
    detail: snapshot.label,
    icon: 'i-carbon-trash-can',
    key: 'wall-remove',
    action: { label: 'Undo', run: () => restore([snapshot]) },
  })
}

function clearWall() {
  if (!items.value.length)
    return
  const snapshot = items.value.map(i => ({ ...i }))
  clearAll()
  selectedId.value = null
  toast(`Cleared ${snapshot.length} tile${snapshot.length === 1 ? '' : 's'}`, {
    icon: 'i-carbon-clean',
    key: 'wall-remove',
    duration: 6000,
    action: { label: 'Undo', run: () => restore(snapshot) },
  })
}

// ─── Layout ─────────────────────────────────────────────────────────────────
const guides = ref<Guide[]>([])

function snap(id: string, r: Rect, edges: Edges): Rect {
  if (!snapping.value) {
    guides.value = []
    return r
  }
  const others = items.value
    .filter(i => i.id !== id)
    .map(i => ({ x: i.x, y: i.y, w: i.width, h: i.height }))
  const res = snapRect(r, edges, others, { w: wallW.value, h: wallH.value })
  guides.value = res.guides
  return res.rect
}

function onGesture(active: boolean) {
  if (!active)
    guides.value = []
}

function arrange() {
  // Reading order follows stacking order, bottom first.
  const ordered = [...items.value].sort((a, b) => a.zIndex - b.zIndex)
  const rects = arrangeGrid(ordered.map(i => i.width / i.height), { w: wallW.value, h: wallH.value })
  ordered.forEach((it, i) => {
    const r = rects[i]
    updateItem(it.id, { x: r.x, y: r.y, width: r.w, height: r.h })
  })
}

// ─── Context menu ───────────────────────────────────────────────────────────
function openMenu(item: WallItem, e: MouseEvent) {
  const isTop = item.zIndex >= Math.max(...items.value.map(i => i.zIndex))
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: 'Adjust…', icon: 'i-carbon-settings-adjust', run: () => tune(item.id) },
      ...(item.type !== 'image'
        ? [{ label: item.muted ? 'Unmute' : 'Mute', icon: item.muted ? 'i-carbon-volume-up' : 'i-carbon-volume-mute', run: () => updateItem(item.id, { muted: !item.muted }) }]
        : []),
      { label: 'Match media shape', icon: 'i-carbon-fit-to-screen', disabled: !aspects.has(item.id), run: () => matchShape(item) },
      { separator: true },
      { label: 'Bring to front', icon: 'i-carbon-bring-to-front', disabled: isTop, run: () => bringToFront(item.id) },
      { label: 'Send to back', icon: 'i-carbon-send-to-back', run: () => sendToBack(item.id) },
      { separator: true },
      { label: 'Remove', icon: 'i-carbon-trash-can', kbd: 'Del', danger: true, run: () => remove(item.id) },
    ],
  }
}

function tune(id: string) {
  selectedId.value = id
  sheetOpen.value = true
}

// ─── Keyboard ───────────────────────────────────────────────────────────────
// Captured at the document so the wall gets first say: arrows nudge the
// selected tile instead of seeking the (mini) player, and Escape deselects
// before the shell treats it as panic.
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    return
  if (e.ctrlKey || e.metaKey || e.altKey)
    return
  if (ytOpen.value || menu.value || ui.paletteOpen || ui.settingsOpen || ui.shortcutsOpen || document.querySelector('[data-ui-popover]'))
    return

  const sel = selected.value
  let handled = true
  if (sel && (e.key === 'Delete' || e.key === 'Backspace')) {
    remove(sel.id)
  }
  else if (sel && e.key.startsWith('Arrow')) {
    const d = e.shiftKey ? 10 : 1
    const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0
    const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0
    updateItem(sel.id, { x: sel.x + dx, y: sel.y + dy })
  }
  else if (e.key === 'Escape' && (sel || sheetOpen.value)) {
    if (sheetOpen.value)
      sheetOpen.value = false
    else
      selectedId.value = null
  }
  else {
    handled = false
  }
  if (handled) {
    e.preventDefault()
    e.stopPropagation()
  }
}

onMounted(() => document.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))

// ─── Sheet helpers ──────────────────────────────────────────────────────────
function typeIcon(t: WallItem['type']) {
  return t === 'youtube' ? 'i-carbon-logo-youtube' : t === 'video' ? 'i-carbon-video' : 'i-carbon-image'
}
</script>

<template>
  <div
    class="bg-surface-950 h-full w-full relative overflow-hidden isolate"
    v-on="drop.handlers"
    @pointermove="chrome.poke"
  >
    <!-- Dot grid: just enough texture to read the canvas as a surface. -->
    <Transition name="t-fade">
      <div v-if="showGrid" class="wall-grid pointer-events-none inset-0 absolute" />
    </Transition>

    <!-- Canvas -->
    <div ref="wallEl" class="inset-0 absolute isolate" @pointerdown.self="selectedId = null">
      <MediaWallItem
        v-for="item in items"
        :key="item.id"
        :item="item"
        :selected="item.id === selectedId"
        :snap="snap"
        @select="selectedId = item.id"
        @front="bringToFront(item.id)"
        @update="changes => updateItem(item.id, changes)"
        @remove="remove(item.id)"
        @tune="tune(item.id)"
        @gesture="onGesture"
        @natural="aspect => onNatural(item, aspect)"
        @contextmenu="e => openMenu(item, e)"
      />

      <!-- Snap guides -->
      <div
        v-for="(g, i) in guides"
        :key="i"
        class="bg-accent opacity-70 pointer-events-none absolute z-[100000]"
        :class="g.axis === 'x' ? 'top-0 bottom-0 w-px' : 'left-0 right-0 h-px'"
        :style="g.axis === 'x' ? { left: `${g.pos}px` } : { top: `${g.pos}px` }"
      />
    </div>

    <!-- Empty state: the whole view is the drop zone. -->
    <Transition name="t-fade">
      <div v-if="!items.length" class="p-6 center inset-0 absolute">
        <div
          class="border-2 rounded-[var(--radius-xl)] border-dashed flex flex-col h-full max-h-[520px] max-w-[760px] w-full transition-colors duration-200 items-center justify-center"
          :class="drop.over.value ? 'border-accent/70 bg-accent-soft' : 'border-edge-strong bg-surface-900/40'"
        >
          <UiEmpty
            size="lg"
            icon="i-carbon-image-copy"
            title="Build a media wall"
            description="Drop images and videos anywhere here and arrange them freely. YouTube links loop silently alongside."
          >
            <UiButton variant="primary" size="md" icon="i-carbon-add" @click="addFromDisk">
              Add images or videos
            </UiButton>
            <UiButton size="md" icon="i-carbon-logo-youtube" @click="ytOpen = true">
              Add YouTube
            </UiButton>
          </UiEmpty>
          <p class="hint mt-2 flex flex-wrap gap-x-3 gap-y-1 items-center justify-center">
            <span>Drag to move</span>
            <span>Corners resize</span>
            <span class="flex gap-1 items-center"><UiKbd>Shift</UiKbd> keeps shape</span>
            <span class="flex gap-1 items-center"><UiKbd>Alt</UiKbd> skips snapping</span>
          </p>
        </div>
      </div>
    </Transition>

    <!-- Toolbar -->
    <Transition name="t-fade">
      <div
        v-if="items.length"
        class="toolbar p-1 rounded-full glass flex gap-0.5 ring-1 ring-edge-strong shadow-[var(--shadow-lg)] items-center left-1/2 top-3 absolute z-20"
        :class="chrome.visible.value ? '' : 'is-hidden'"
        @pointerenter="overToolbar = true"
        @pointerleave="overToolbar = false"
      >
        <UiButton variant="ghost" icon="i-carbon-add" class="!rounded-full" @click="addFromDisk">
          Add media
        </UiButton>
        <UiButton variant="ghost" icon="i-carbon-logo-youtube" class="!rounded-full" @click="ytOpen = true">
          YouTube
        </UiButton>
        <span class="mx-1 divider-x" />
        <UiIconButton icon="i-carbon-grid" label="Arrange in a grid" tip="bottom" class="!rounded-full" @click="arrange" />
        <UiIconButton
          icon="i-carbon-center-to-fit"
          :label="snapping ? 'Snapping on' : 'Snapping off'"
          :active="snapping"
          tip="bottom"
          class="!rounded-full"
          @click="snapping = !snapping"
        />
        <span class="mx-1 divider-x" />
        <span class="text-[12px] text-fg-muted num px-2">{{ items.length }}</span>
        <UiIconButton
          icon="i-carbon-settings-adjust"
          label="Tiles and settings"
          :active="sheetOpen"
          tip="bottom"
          class="!rounded-full"
          @click="sheetOpen = !sheetOpen"
        />
        <UiIconButton icon="i-carbon-trash-can" label="Clear the wall" tip="bottom" class="!rounded-full hover:!text-danger" @click="clearWall" />
      </div>
    </Transition>

    <!-- Settings sheet -->
    <Transition name="t-slide-right">
      <aside
        v-if="sheetOpen"
        class="border border-edge rounded-[var(--radius-lg)] bg-surface-900/92 flex flex-col w-[300px] shadow-[var(--shadow-lg)] bottom-3 right-3 top-3 absolute z-30 overflow-hidden backdrop-blur-xl"
        @pointerdown.stop
      >
        <header class="pl-4 pr-2 border-b border-edge flex shrink-0 gap-2 h-11 items-center">
          <span class="i-carbon-grid text-[15px] text-fg-muted" />
          <span class="text-[13px] text-fg font-medium flex-1">Wall</span>
          <UiIconButton icon="i-carbon-close" label="Close" kbd="Esc" tip="left" @click="sheetOpen = false" />
        </header>

        <div class="p-2.5 scroll-y flex flex-1 flex-col gap-2.5" :class="player.videoUrl ? 'pb-[230px]' : ''">
          <!-- Selected tile -->
          <UiSection title="Selected" icon="i-carbon-select-01">
            <Transition name="t-fade" mode="out-in">
              <div v-if="selected" :key="selected.id" class="flex flex-col gap-3">
                <div class="flex gap-2 min-w-0 items-center">
                  <span :class="typeIcon(selected.type)" class="text-[14px] text-fg-muted shrink-0" />
                  <span class="text-[12.5px] text-fg truncate">{{ selected.label }}</span>
                </div>
                <UiSlider
                  :model-value="selected.opacity"
                  label="Opacity"
                  :min="0.05" :max="1" :step="0.05" :reset="1"
                  :format="v => `${Math.round(v * 100)}%`"
                  @update:model-value="v => updateItem(selected!.id, { opacity: v })"
                />
                <UiSlider
                  v-if="selected.type === 'video'"
                  :model-value="selected.playbackRate"
                  label="Speed"
                  :min="0.1" :max="3" :step="0.05" :reset="1"
                  :format="v => `${v.toFixed(2)}×`"
                  @update:model-value="v => updateItem(selected!.id, { playbackRate: v })"
                />
                <UiSwitch
                  v-if="selected.type !== 'image'"
                  :model-value="!selected.muted"
                  label="Sound"
                  :hint="selected.type === 'youtube' ? 'Reloads the embed' : undefined"
                  @update:model-value="v => updateItem(selected!.id, { muted: !v })"
                />
                <div class="flex flex-wrap gap-1.5">
                  <UiButton size="xs" icon="i-carbon-bring-to-front" @click="bringToFront(selected.id)">
                    Front
                  </UiButton>
                  <UiButton size="xs" icon="i-carbon-send-to-back" @click="sendToBack(selected.id)">
                    Back
                  </UiButton>
                  <UiButton size="xs" icon="i-carbon-fit-to-screen" :disabled="!aspects.has(selected.id)" @click="matchShape(selected)">
                    Match shape
                  </UiButton>
                  <UiButton size="xs" variant="danger" icon="i-carbon-trash-can" class="ml-auto" @click="remove(selected.id)">
                    Remove
                  </UiButton>
                </div>
              </div>
              <p v-else class="hint py-1">
                Click a tile to adjust its opacity, speed and sound.
              </p>
            </Transition>
          </UiSection>

          <!-- Layers -->
          <UiSection title="Tiles" icon="i-carbon-layers" :summary="`${items.length}`">
            <TransitionGroup tag="ul" name="t-list" class="flex flex-col gap-0.5 relative">
              <li
                v-for="item in layers"
                :key="item.id"
                class="group px-2 rounded-[var(--radius-sm)] flex gap-2 h-8 cursor-pointer transition-colors items-center"
                :class="item.id === selectedId ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-fg/6 hover:text-fg'"
                @click="selectedId = item.id"
              >
                <span :class="typeIcon(item.type)" class="text-[13px] shrink-0" />
                <span class="text-[12.5px] flex-1 truncate">{{ item.label }}</span>
                <span v-if="item.type !== 'image' && !item.muted" class="i-carbon-volume-up text-[12px] text-accent-300 shrink-0" />
                <UiIconButton
                  icon="i-carbon-close"
                  label="Remove"
                  size="xs"
                  tip="left"
                  class="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  @click.stop="remove(item.id)"
                />
              </li>
            </TransitionGroup>
          </UiSection>

          <!-- Canvas -->
          <UiSection title="Canvas" icon="i-carbon-grid">
            <UiSwitch v-model="snapping" label="Snap to edges" hint="Tiles line up with each other and the wall. Hold Alt to skip." />
            <UiSwitch v-model="showGrid" label="Dot grid" />
            <div class="flex gap-1.5">
              <UiButton size="sm" icon="i-carbon-grid" class="flex-1" @click="arrange">
                Arrange
              </UiButton>
              <UiButton size="sm" variant="danger" icon="i-carbon-clean" class="flex-1" @click="clearWall">
                Clear wall
              </UiButton>
            </div>
          </UiSection>
        </div>
      </aside>
    </Transition>

    <!-- Drop overlay (the empty state is its own drop zone). -->
    <Transition name="t-fade">
      <div v-if="drop.over.value && items.length" class="p-4 pointer-events-none inset-0 absolute z-40">
        <div class="border-2 border-accent/60 rounded-[var(--radius-xl)] border-dashed bg-accent-soft flex flex-col gap-2 h-full w-full animate-scale-in items-center justify-center backdrop-blur-[2px]">
          <span class="i-carbon-drop-photo text-[30px] text-accent-300" />
          <p class="text-[15px] text-fg font-semibold">
            Drop to add to the wall
          </p>
          <p class="text-[12.5px] text-fg-muted">
            Tiles land where you let go
          </p>
        </div>
      </div>
    </Transition>

    <AddYoutubeModal v-model:open="ytOpen" @add="addYoutube" />
    <UiContextMenu v-model="menu" />
  </div>
</template>

<style scoped>
.wall-grid {
  background-image: radial-gradient(circle, var(--border-strong) 1px, transparent 1.2px);
  background-size: 24px 24px;
  background-position: 12px 12px;
}

.toolbar {
  transform: translateX(-50%);
  transition:
    opacity var(--dur-slow) var(--ease-out),
    transform var(--dur-slow) var(--ease-out);
}
.toolbar.is-hidden {
  opacity: 0;
  transform: translate(-50%, -8px);
  pointer-events: none;
}
</style>
