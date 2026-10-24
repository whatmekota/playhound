<script setup lang="ts">
import type { Edges, Rect } from '~/composables/wallGeometry'
import type { WallItem } from '~/stores/mediaWall'
import { computed, ref, watch } from 'vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import { MOVE_EDGES, resizeRect } from '~/composables/wallGeometry'

/**
 * One tile on the media wall.
 *
 * Holds a live rect while a gesture is in progress and only writes to the
 * store when it ends, so dragging a persisted (YouTube) tile does not hammer
 * localStorage on every pointermove.
 */
const props = defineProps<{
  item: WallItem
  selected: boolean
  /** Snap a rect mid-gesture; the wall knows the other tiles and its own size. */
  snap?: (id: string, r: Rect, edges: Edges) => Rect
}>()

const emit = defineEmits<{
  select: []
  front: []
  update: [changes: Partial<WallItem>]
  remove: []
  tune: []
  gesture: [active: boolean]
  /** Natural aspect ratio of the media once it has loaded. */
  natural: [aspect: number]
  contextmenu: [e: MouseEvent]
}>()

const live = ref<Rect | null>(null)
const gesture = ref<'move' | 'resize' | null>(null)
const hovered = ref(false)

const rect = computed<Rect>(() => live.value ?? { x: props.item.x, y: props.item.y, w: props.item.width, h: props.item.height })
const chrome = computed(() => hovered.value || props.selected || gesture.value !== null)
const roomy = computed(() => rect.value.w >= 200 && rect.value.h >= 120)

// ─── Gestures ───────────────────────────────────────────────────────────────
const HANDLES = [
  { id: 'nw', x: -1, y: -1, cursor: 'nwse-resize' },
  { id: 'n', x: 0, y: -1, cursor: 'ns-resize' },
  { id: 'ne', x: 1, y: -1, cursor: 'nesw-resize' },
  { id: 'e', x: 1, y: 0, cursor: 'ew-resize' },
  { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
  { id: 's', x: 0, y: 1, cursor: 'ns-resize' },
  { id: 'sw', x: -1, y: 1, cursor: 'nesw-resize' },
  { id: 'w', x: -1, y: 0, cursor: 'ew-resize' },
] as const

type Handle = typeof HANDLES[number]

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_SLOP = 3

function begin(e: PointerEvent, handle?: Handle) {
  if (e.button !== 0)
    return
  e.preventDefault()
  e.stopPropagation()
  emit('select')
  emit('front')
  ;(e.currentTarget as HTMLElement | null)?.closest<HTMLElement>('[data-tile]')?.focus({ preventScroll: true })

  const start = { ...rect.value }
  const sx = e.clientX
  const sy = e.clientY
  let engaged = !!handle

  if (handle) {
    gesture.value = 'resize'
    live.value = start
    emit('gesture', true)
  }

  const edges: Edges = handle
    ? { left: handle.x < 0, right: handle.x > 0, top: handle.y < 0, bottom: handle.y > 0 }
    : MOVE_EDGES

  function move(ev: PointerEvent) {
    const dx = ev.clientX - sx
    const dy = ev.clientY - sy
    if (!engaged) {
      if (Math.hypot(dx, dy) < DRAG_SLOP)
        return
      engaged = true
      gesture.value = 'move'
      emit('gesture', true)
    }

    let next: Rect
    if (handle)
      next = resizeRect(start, handle, dx, dy, ev.shiftKey)
    else
      next = { ...start, x: start.x + dx, y: start.y + dy }

    // Alt skips snapping; so does an aspect-locked resize, which snapping one
    // edge would bend out of shape.
    if (props.snap && !ev.altKey && !(handle && ev.shiftKey))
      next = props.snap(props.item.id, next, edges)
    live.value = next
  }

  function up() {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    if (engaged && live.value) {
      const r = live.value
      emit('update', { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) })
      emit('gesture', false)
    }
    gesture.value = null
    live.value = null
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

// ─── Media ──────────────────────────────────────────────────────────────────
const videoEl = ref<HTMLVideoElement | null>(null)

watch([videoEl, () => props.item.playbackRate], ([el, rate]) => {
  if (el)
    el.playbackRate = rate
})

function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth && img.naturalHeight)
    emit('natural', img.naturalWidth / img.naturalHeight)
}

function onVideoMeta(e: Event) {
  const v = e.target as HTMLVideoElement
  v.playbackRate = props.item.playbackRate
  if (v.videoWidth && v.videoHeight)
    emit('natural', v.videoWidth / v.videoHeight)
}

// The embed has no JS API wired up, so muting means reloading it with the
// other `mute` flag. It only happens on a click, which also satisfies the
// browser's autoplay-with-sound rule.
const youtubeUrl = computed(() => {
  if (props.item.type !== 'youtube')
    return ''
  const id = props.item.src
  return `https://www.youtube.com/embed/${id}?autoplay=1&mute=${props.item.muted ? 1 : 0}&loop=1&playlist=${id}&controls=0&modestbranding=1&playsinline=1&rel=0`
})

const hasSound = computed(() => props.item.type !== 'image')
const typeIcon = computed(() => props.item.type === 'youtube'
  ? 'i-carbon-logo-youtube'
  : props.item.type === 'video' ? 'i-carbon-video' : 'i-carbon-image')
</script>

<template>
  <div
    data-tile
    tabindex="0"
    role="group"
    :aria-label="item.label"
    class="wall-tile outline-none animate-scale-in absolute"
    :class="[gesture ? 'is-gesture' : '', gesture === 'move' ? 'cursor-grabbing' : 'cursor-grab']"
    :style="{
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
      zIndex: item.zIndex,
      touchAction: 'none',
    }"
    @pointerdown="begin($event)"
    @focus="emit('select')"
    @pointerenter="hovered = true"
    @pointerleave="hovered = false"
    @contextmenu.prevent.stop="emit('select'); emit('contextmenu', $event)"
  >
    <!-- Media -->
    <div
      class="rounded-[var(--radius-md)] bg-black h-full w-full relative overflow-hidden"
      :class="[
        selected ? 'ring-2 ring-accent' : hovered ? 'ring-1 ring-white/25' : 'ring-1 ring-black/40',
        gesture ? 'shadow-[var(--shadow-lg)]' : 'shadow-[var(--shadow-md)]',
      ]"
      style="transition: box-shadow var(--dur) var(--ease-out)"
    >
      <img
        v-if="item.type === 'image'"
        :src="item.src"
        :alt="item.label"
        class="h-full w-full block pointer-events-none object-cover"
        :style="{ opacity: item.opacity }"
        draggable="false"
        @load="onImageLoad"
      >
      <video
        v-else-if="item.type === 'video'"
        ref="videoEl"
        :src="item.src"
        :muted="item.muted"
        loop
        autoplay
        playsinline
        class="h-full w-full block pointer-events-none object-cover"
        :style="{ opacity: item.opacity }"
        @loadedmetadata="onVideoMeta"
      />
      <iframe
        v-else-if="item.type === 'youtube'"
        :src="youtubeUrl"
        :title="item.label"
        class="border-0 h-full w-full block pointer-events-none"
        :style="{ opacity: item.opacity }"
        allow="autoplay; encrypted-media"
        referrerpolicy="strict-origin-when-cross-origin"
      />

      <!-- Hover chrome. Drawn over media, so white-on-dark is correct here. -->
      <Transition name="t-fade">
        <div v-if="chrome && !gesture" class="pointer-events-none inset-0 absolute">
          <div class="tile-scrim-top inset-x-0 top-0 absolute" :class="roomy ? 'h-16' : 'h-11'" />
          <div class="p-1.5 flex gap-1 items-start inset-x-0 top-0 absolute">
            <div v-if="roomy" class="text-[11.5px] text-white/90 font-medium pl-1 pt-1 flex flex-1 gap-1.5 min-w-0 items-center">
              <span :class="typeIcon" class="text-[13px] text-white/70 shrink-0" />
              <span class="truncate drop-shadow">{{ item.label }}</span>
            </div>
            <div class="ml-auto p-0.5 rounded-[var(--radius-sm)] bg-black/45 flex gap-0.5 pointer-events-auto backdrop-blur-md" @pointerdown.stop>
              <UiIconButton
                variant="glass" size="xs" icon="i-carbon-settings-adjust" label="Adjust" tip="bottom"
                @click="emit('tune')"
              />
              <UiIconButton
                v-if="hasSound"
                variant="glass" size="xs" tip="bottom"
                :icon="item.muted ? 'i-carbon-volume-mute' : 'i-carbon-volume-up'"
                :label="item.muted ? 'Unmute' : 'Mute'"
                @click="emit('update', { muted: !item.muted })"
              />
              <UiIconButton
                variant="glass" size="xs" icon="i-carbon-close" label="Remove" kbd="Del" tip="bottom"
                @click="emit('remove')"
              />
            </div>
          </div>
          <div
            v-if="item.type === 'video' && item.playbackRate !== 1 && roomy"
            class="text-[10.5px] text-white/85 num px-1.5 py-0.5 rounded-[var(--radius-xs)] bg-black/50 bottom-2 left-2 absolute"
          >
            {{ item.playbackRate.toFixed(2).replace(/0$/, '') }}×
          </div>
        </div>
      </Transition>

      <!-- Size readout while resizing -->
      <Transition name="t-fade">
        <div
          v-if="gesture === 'resize'"
          class="text-[11px] text-white num px-2 py-0.5 rounded-full bg-black/60 pointer-events-none left-1/2 top-1/2 absolute -translate-x-1/2 -translate-y-1/2"
        >
          {{ Math.round(rect.w) }} × {{ Math.round(rect.h) }}
        </div>
      </Transition>
    </div>

    <!-- Resize handles: corners are visible dots, edges are invisible strips. -->
    <template v-for="h in HANDLES" :key="h.id">
      <div
        class="handle absolute"
        :class="[`handle-${h.id}`, h.x && h.y ? 'is-corner' : 'is-edge', chrome ? 'is-on' : '']"
        :style="{ cursor: h.cursor }"
        @pointerdown="begin($event, h)"
      />
    </template>
  </div>
</template>

<style scoped>
.wall-tile:not(.is-gesture) {
  transition:
    left var(--dur-slow) var(--ease-out),
    top var(--dur-slow) var(--ease-out),
    width var(--dur-slow) var(--ease-out),
    height var(--dur-slow) var(--ease-out);
}

.tile-scrim-top {
  background: linear-gradient(to bottom, rgb(0 0 0 / 0.6), transparent);
}

.handle {
  z-index: 2;
}
.handle.is-corner {
  width: 12px;
  height: 12px;
  border-radius: 4px;
  background: white;
  box-shadow:
    0 0 0 1px rgb(0 0 0 / 0.35),
    0 2px 6px rgb(0 0 0 / 0.4);
  opacity: 0;
  transform: scale(0.6);
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur) var(--ease-spring);
  pointer-events: none;
}
.handle.is-corner.is-on {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}
.handle.is-edge {
  pointer-events: none;
}
.handle.is-edge.is-on {
  pointer-events: auto;
}
.handle-nw {
  left: -6px;
  top: -6px;
}
.handle-ne {
  right: -6px;
  top: -6px;
}
.handle-se {
  right: -6px;
  bottom: -6px;
}
.handle-sw {
  left: -6px;
  bottom: -6px;
}
.handle-n,
.handle-s {
  left: 10px;
  right: 10px;
  height: 8px;
}
.handle-n {
  top: -4px;
}
.handle-s {
  bottom: -4px;
}
.handle-e,
.handle-w {
  top: 10px;
  bottom: 10px;
  width: 8px;
}
.handle-e {
  right: -4px;
}
.handle-w {
  left: -4px;
}
</style>
