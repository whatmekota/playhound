<script setup lang="ts">
import type { WallItem } from '~/stores/mediaWall'

const props = defineProps<{ item: WallItem }>()
const emit = defineEmits<{
  update: [id: string, changes: Partial<WallItem>]
  remove: [id: string]
  bringToFront: [id: string]
}>()

const isHovered = ref(false)
const isDragging = ref(false)
const isResizing = ref(false)

const localX = ref(props.item.x)
const localY = ref(props.item.y)
const localW = ref(props.item.width)
const localH = ref(props.item.height)
const localOpacity = ref(props.item.opacity)
const localRate = ref(props.item.playbackRate)

watch(() => [props.item.x, props.item.y, props.item.width, props.item.height] as const, ([x, y, w, h]) => {
  if (!isDragging.value && !isResizing.value) {
    localX.value = x
    localY.value = y
    localW.value = w
    localH.value = h
  }
})
watch(() => props.item.opacity, (v) => {
  localOpacity.value = v
})
watch(() => props.item.playbackRate, (v) => {
  localRate.value = v
})

// Dragging
let dsx = 0
let dsy = 0
let dix = 0
let diy = 0

function startDrag(e: PointerEvent) {
  e.preventDefault()
  isDragging.value = true
  dsx = e.clientX
  dsy = e.clientY
  dix = localX.value
  diy = localY.value
  emit('bringToFront', props.item.id)
  const move = (ev: PointerEvent) => {
    localX.value = dix + (ev.clientX - dsx)
    localY.value = diy + (ev.clientY - dsy)
  }
  const up = () => {
    isDragging.value = false
    emit('update', props.item.id, { x: localX.value, y: localY.value })
    window.removeEventListener('pointermove', move)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up, { once: true })
}

// Resizing
let rsx = 0
let rsy = 0
let rsw = 0
let rsh = 0

function startResize(e: PointerEvent) {
  e.preventDefault()
  e.stopPropagation()
  isResizing.value = true
  rsx = e.clientX
  rsy = e.clientY
  rsw = localW.value
  rsh = localH.value
  const move = (ev: PointerEvent) => {
    localW.value = Math.max(80, rsw + (ev.clientX - rsx))
    localH.value = Math.max(60, rsh + (ev.clientY - rsy))
  }
  const up = () => {
    isResizing.value = false
    emit('update', props.item.id, { width: localW.value, height: localH.value })
    window.removeEventListener('pointermove', move)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up, { once: true })
}

// Video playback rate sync
const videoEl = ref<HTMLVideoElement | null>(null)

watch(videoEl, (el) => {
  if (el)
    el.playbackRate = localRate.value
})
watch(localRate, (r) => {
  if (videoEl.value)
    videoEl.value.playbackRate = r
})

function setOpacity(v: number) {
  localOpacity.value = v
  emit('update', props.item.id, { opacity: v })
}
function setRate(v: number) {
  localRate.value = v
  if (videoEl.value)
    videoEl.value.playbackRate = v
  emit('update', props.item.id, { playbackRate: v })
}

const youtubeUrl = computed(() => {
  if (props.item.type !== 'youtube')
    return ''
  const id = props.item.src
  return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}&controls=0&modestbranding=1&playsinline=1`
})
</script>

<template>
  <div
    class="select-none absolute"
    :style="{
      left: `${localX}px`,
      top: `${localY}px`,
      width: `${localW}px`,
      height: `${localH}px`,
      zIndex: item.zIndex,
      cursor: isDragging ? 'grabbing' : 'grab',
    }"
    @pointerdown="startDrag"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <!-- Grab handle -->
    <div
      class="absolute top-1.5 left-1.5 w-7 h-7 rounded-md z-20 flex items-center justify-center transition-opacity"
      :class="isDragging ? 'opacity-100 cursor-grabbing' : 'cursor-grab opacity-30 hover:opacity-90'"
      style="background: rgba(0,0,0,0.55); touch-action: none"
      @pointerdown.stop="startDrag"
    >
      <div class="i-carbon-move text-white text-sm" />
    </div>

    <!-- Media content -->
    <img
      v-if="item.type === 'image'"
      :src="item.src"
      :alt="item.label"
      class="rounded-xl h-full w-full block pointer-events-none object-cover"
      :style="{ opacity: localOpacity }"
      draggable="false"
    >
    <video
      v-else-if="item.type === 'video'"
      ref="videoEl"
      :src="item.src"
      :muted="item.muted"
      loop
      autoplay
      playsinline
      class="rounded-xl h-full w-full block pointer-events-none object-cover"
      :style="{ opacity: localOpacity }"
    />
    <iframe
      v-else-if="item.type === 'youtube'"
      :src="youtubeUrl"
      class="rounded-xl h-full w-full block pointer-events-none"
      :style="{ opacity: localOpacity }"
      allow="autoplay; encrypted-media"
      frameborder="0"
      referrerpolicy="strict-origin-when-cross-origin"
    />

    <!-- Hover controls -->
    <Transition name="ctrl">
      <div
        v-if="isHovered"
        class="item-ctrl p-2 rounded-xl flex flex-col inset-0 justify-between absolute"
        style="background: linear-gradient(to bottom, rgba(0,0,0,0.65) 0%, transparent 35%, transparent 65%, rgba(0,0,0,0.75) 100%)"
      >
        <div class="flex gap-1 items-start justify-between">
          <span class="text-xs text-white/90 font-medium max-w-[80%] truncate drop-shadow">{{ item.label }}</span>
          <button
            class="text-xs text-white leading-none rounded-full bg-red-600/90 flex flex-shrink-0 h-5 w-5 items-center justify-center hover:bg-red-500"
            @click.stop="emit('remove', item.id)"
          >
            ×
          </button>
        </div>
        <div class="space-y-1.5">
          <div class="flex gap-2 items-center">
            <span class="text-[10px] text-white/60 flex-shrink-0 w-11">Opacity</span>
            <input
              type="range" min="0.05" max="1" step="0.05"
              :value="localOpacity"
              class="isl flex-1"
              @input="setOpacity(+($event.target as HTMLInputElement).value)"
              @pointerdown.stop
            >
            <span class="text-[10px] text-white/50 text-right w-8">{{ Math.round(localOpacity * 100) }}%</span>
          </div>
          <div v-if="item.type === 'video'" class="flex gap-2 items-center">
            <span class="text-[10px] text-white/60 flex-shrink-0 w-11">Speed</span>
            <input
              type="range" min="0.1" max="3" step="0.1"
              :value="localRate"
              class="isl flex-1"
              @input="setRate(+($event.target as HTMLInputElement).value)"
              @pointerdown.stop
            >
            <span class="text-[10px] text-white/50 text-right w-8">{{ localRate.toFixed(1) }}×</span>
          </div>
        </div>
      </div>
    </Transition>

    <!-- Resize handle -->
    <div
      class="resize-hdl rounded-br-xl h-5 w-5 cursor-se-resize transition-opacity bottom-0 right-0 absolute"
      :class="isHovered ? 'opacity-70' : 'opacity-0'"
      style="background: linear-gradient(135deg, transparent 40%, rgba(255,255,255,0.5) 40%)"
      @pointerdown="startResize"
    />
  </div>
</template>

<style scoped>
.ctrl-enter-active,
.ctrl-leave-active {
  transition: opacity 0.15s ease;
}
.ctrl-enter-from,
.ctrl-leave-to {
  opacity: 0;
}

.isl {
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  height: 3px;
  outline: none;
}
.isl::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  background: #2dd4bf;
  border-radius: 50%;
  cursor: pointer;
}
.isl::-moz-range-thumb {
  width: 12px;
  height: 12px;
  background: #2dd4bf;
  border-radius: 50%;
  cursor: pointer;
  border: none;
}
</style>
