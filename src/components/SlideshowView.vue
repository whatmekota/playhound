<script setup lang="ts">
import type { TransitionName } from '~/stores/slideshow'
import { useAudioStore } from '~/stores/audio'
import { useSlideshowStore } from '~/stores/slideshow'

const {
  items,
  settings,
  isPlaying,
  currentIndex,
  addItem,
  removeItem,
  moveItem,
  updateItem,
  overlays,
  addOverlay,
  removeOverlay,
  updateOverlay,
  ALL_TRANSITIONS,
} = useSlideshowStore()
const audioStore = useAudioStore()
const lfo = useLFO()
const session = useSessionEngine()

const showSettings = ref(false)
const showYtModal = ref(false)
const fileInput = ref<HTMLInputElement>()
const overlayFileInput = ref<HTMLInputElement>()
const slideshowRoot = ref<HTMLElement>()
const isFullscreen = ref(false)

const BLEND_MODES = ['normal', 'screen', 'overlay', 'multiply', 'soft-light', 'color-dodge', 'lighten', 'darken']

// Phase → auto-transition map
const PHASE_TRANSITIONS: Record<string, TransitionName> = {
  idle: 'fade',
  entry: 'slide',
  build: 'zoom',
  peak: 'rotate',
  descent: 'blur',
}

// --- Timer with variance ---
let timer: ReturnType<typeof setTimeout> | null = null

function getSlideDelay(): number {
  if (settings.value.beatSync) {
    const beats = settings.value.beatsPerSlide ?? 8
    return (beats / Math.max(0.25, audioStore.beatDelta.value)) * 1000
  }
  // eslint-disable-next-line ts/no-use-before-define -- hoisted; read after setup
  const base = (currentItem.value?.duration ?? settings.value.delay) * 1000
  return session.variantDelay(base, 0.2)
}

function scheduleNext() {
  clearScheduled()
  if (items.length === 0 || !isPlaying.value)
    return
  timer = setTimeout(() => {
    advance()
    if (isPlaying.value)
      scheduleNext()
  }, getSlideDelay())
}

function clearScheduled() {
  if (timer !== null) { clearTimeout(timer); timer = null }
}

// Current random transition (refreshed on each advance when randomTransition is on)
const randomPickedTransition = ref<TransitionName>('fade')

function pickRandom(): TransitionName {
  const pool = settings.value.transitionPool ?? []
  if (!pool.length)
    return 'fade'
  return pool[Math.floor(Math.random() * pool.length)]
}

function advance() {
  if (items.length === 0)
    return

  // Pick random transition before changing slide so it's ready
  if (settings.value.randomTransition) {
    randomPickedTransition.value = pickRandom()
  }

  if (settings.value.shuffle) {
    let next = currentIndex.value
    if (items.length > 1) {
      while (next === currentIndex.value)
        next = Math.floor(Math.random() * items.length)
    }
    currentIndex.value = next
  }
  else {
    const next = currentIndex.value + 1
    if (next >= items.length) {
      if (settings.value.loop) {
        currentIndex.value = 0
      }
      else {
        isPlaying.value = false
        clearScheduled()
        return
      }
    }
    else {
      currentIndex.value = next
    }
  }
  session.emit('slideChange', { index: currentIndex.value, total: items.length })
}

function prev() {
  if (items.length === 0)
    return
  if (currentIndex.value > 0)
    currentIndex.value--
  else if (settings.value.loop)
    currentIndex.value = items.length - 1
  if (isPlaying.value)
    scheduleNext()
}

function next() {
  advance()
  if (isPlaying.value)
    scheduleNext()
}

function togglePlay() {
  isPlaying.value = !isPlaying.value
}

watch(isPlaying, (p) => {
  if (p) { lfo.start(); scheduleNext() }
  else { clearScheduled(); lfo.stop() }
})

// Sync LFO speed to beat frequency; also re-schedule if beat-sync is active
watch(() => audioStore.beatDelta.value, (delta) => {
  lfo.syncToFreq(delta)
  if (settings.value.beatSync && isPlaying.value)
    scheduleNext()
})

// Auto-transition: update the picked transition when phase changes
watch(() => audioStore.phase.value, (ph) => {
  if (settings.value.autoTransition) {
    settings.value.transition = PHASE_TRANSITIONS[ph] ?? 'fade'
  }
})

onMounted(() => {
  document.addEventListener('fullscreenchange', () => {
    isFullscreen.value = !!document.fullscreenElement
  })
  randomPickedTransition.value = pickRandom()
})

onUnmounted(() => {
  clearScheduled()
  lfo.stop()
})

// --- Fullscreen ---

async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    await slideshowRoot.value?.requestFullscreen()
  }
  else {
    await document.exitFullscreen()
  }
}

// --- File handling ---
function openFilePicker() { fileInput.value?.click() }
function openOverlayFilePicker() { overlayFileInput.value?.click() }

function onFileInput(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files)
    return
  for (const file of Array.from(files)) {
    const isImage = file.type.startsWith('image/')
    const isVideo = file.type.startsWith('video/')
    if (!isImage && !isVideo)
      continue
    addItem({ type: isImage ? 'image' : 'video', src: URL.createObjectURL(file), label: file.name })
  }
  ;(e.target as HTMLInputElement).value = ''
}

function onOverlayFileInput(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files)
    return
  for (const file of Array.from(files)) {
    const isImage = file.type.startsWith('image/')
    const isVideo = file.type.startsWith('video/')
    if (!isImage && !isVideo)
      continue
    addOverlay({
      type: isImage ? 'image' : 'video',
      src: URL.createObjectURL(file),
      label: file.name,
      opacity: 0.5,
      blendMode: 'screen',
      enabled: true,
      fit: 'cover',
    })
  }
  ;(e.target as HTMLInputElement).value = ''
}

function addYoutube({ youtubeId, label }: { youtubeId: string, label: string }) {
  addItem({ type: 'youtube', src: youtubeId, label })
}

function randomizeVideoStart(e: Event) {
  const video = e.target as HTMLVideoElement
  if (video.duration && Number.isFinite(video.duration))
    video.currentTime = Math.random() * video.duration
}

// --- Drag-to-reorder ---
const dragStartIdx = ref<number | null>(null)
const dragOverIdx = ref<number | null>(null)

function onDragStart(e: DragEvent, i: number) {
  dragStartIdx.value = i
  if (e.dataTransfer)
    e.dataTransfer.effectAllowed = 'move'
}
function onDragOver(e: DragEvent, i: number) {
  e.preventDefault()
  dragOverIdx.value = i
}
function onDragLeave() { dragOverIdx.value = null }
function onDrop(e: DragEvent, i: number) {
  e.preventDefault()
  if (dragStartIdx.value !== null && dragStartIdx.value !== i) {
    const from = dragStartIdx.value
    moveItem(from, i)
    if (currentIndex.value === from)
      currentIndex.value = i
  }
  dragStartIdx.value = null
  dragOverIdx.value = null
}
function onDragEnd() { dragStartIdx.value = null; dragOverIdx.value = null }

// --- Transition pool toggle ---
function toggleTransitionPool(t: TransitionName) {
  const pool = settings.value.transitionPool ?? []
  const idx = pool.indexOf(t)
  if (idx >= 0) {
    if (pool.length > 1)
      pool.splice(idx, 1)
  }
  else {
    pool.push(t)
  }
}

// --- Computed ---
const currentItem = computed(() => items[currentIndex.value])

const ytUrl = computed(() => {
  if (!currentItem.value || currentItem.value.type !== 'youtube')
    return ''
  const id = currentItem.value.src
  return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}&controls=0&modestbranding=1&playsinline=1`
})

const transitionName = computed(() => {
  let t: TransitionName
  if (settings.value.randomTransition) {
    t = randomPickedTransition.value
  }
  else if (settings.value.autoTransition && audioStore.phase.value !== 'idle') {
    t = PHASE_TRANSITIONS[audioStore.phase.value] ?? settings.value.transition
  }
  else {
    t = settings.value.transition
  }
  return t === 'none' ? '' : t
})

const brightnessOverlayOpacity = computed(() =>
  audioStore.noiseEnabled.value ? audioStore.noiseVolume.value * 0.25 : 0,
)

const lfoStyle = computed(() => {
  if (!isPlaying.value)
    return {}
  return {
    transform: `scale(${lfo.values.zoom}) translate(${lfo.values.panX}px, ${lfo.values.panY}px)`,
    opacity: lfo.values.opacity,
    transition: 'none',
  }
})

const activeOverlays = computed(() => overlays.filter(o => o.enabled))

function overlayMediaStyle(overlay: typeof overlays[0]) {
  const lfoOpacity = (isPlaying.value && lfo.active.value && settings.value.lfoOverlays)
    ? lfo.values.opacity
    : 1
  return {
    opacity: overlay.opacity * lfoOpacity,
    mixBlendMode: overlay.blendMode as any,
    objectFit: overlay.fit,
  }
}
</script>

<template>
  <div ref="slideshowRoot" class="bg-zinc-950 flex flex-col h-full w-full relative overflow-hidden">
    <!-- Background vignette -->
    <div class="pointer-events-none inset-0 absolute z-0" style="background: radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.65) 100%)" />

    <!-- Slide display area -->
    <div class="flex-1 relative overflow-hidden">
      <Transition :name="transitionName">
        <div
          v-if="currentItem"
          :key="currentItem.id"
          class="flex items-center inset-0 justify-center absolute"
        >
          <img
            v-if="currentItem.type === 'image'"
            :src="currentItem.src"
            :alt="currentItem.label"
            :style="lfoStyle"
            :class="currentItem.fit === 'cover' ? 'object-cover' : 'object-contain'"
            class="will-change-transform h-full w-full"
            draggable="false"
          >
          <video
            v-else-if="currentItem.type === 'video'"
            :key="`${currentItem.id}-v`"
            :src="currentItem.src"
            :style="lfoStyle"
            :class="currentItem.fit === 'cover' ? 'object-cover' : 'object-contain'"
            autoplay
            loop
            muted
            playsinline
            class="will-change-transform h-full w-full"
            @loadedmetadata="randomizeVideoStart"
          />
          <iframe
            v-else-if="currentItem.type === 'youtube'"
            :src="ytUrl"
            class="h-full w-full"
            allow="autoplay; encrypted-media"
            frameborder="0"
            referrerpolicy="strict-origin-when-cross-origin"
          />
        </div>
      </Transition>

      <!-- Audio-reactive brightness overlay -->
      <div
        class="bg-black pointer-events-none transition-opacity duration-500 inset-0 absolute z-10"
        :style="{ opacity: brightnessOverlayOpacity }"
      />

      <!-- Static overlays -->
      <div
        v-for="overlay in activeOverlays"
        :key="overlay.id"
        class="pointer-events-none inset-0 absolute z-[15]"
      >
        <img
          v-if="overlay.type === 'image'"
          :src="overlay.src"
          class="h-full w-full"
          :style="overlayMediaStyle(overlay)"
          draggable="false"
        >
        <video
          v-else-if="overlay.type === 'video'"
          :src="overlay.src"
          autoplay
          loop
          muted
          playsinline
          class="h-full w-full"
          :style="overlayMediaStyle(overlay)"
          @loadedmetadata="randomizeVideoStart"
        />
      </div>

      <!-- Empty state -->
      <div
        v-if="items.length === 0"
        class="flex flex-col gap-4 items-center inset-0 justify-center absolute z-20"
      >
        <div class="i-carbon-play-outline text-6xl text-zinc-700" />
        <p class="text-sm text-zinc-500">
          Add images, videos, or YouTube links to start a slideshow
        </p>
        <div class="mt-1 flex gap-2">
          <button
            class="text-sm text-zinc-300 px-4 py-2 rounded-lg bg-zinc-800 flex gap-2 transition-colors items-center hover:bg-zinc-700"
            @click="openFilePicker"
          >
            <div class="i-carbon-upload" /> Add Files
          </button>
          <button
            class="text-sm text-zinc-300 px-4 py-2 rounded-lg bg-zinc-800 flex gap-2 transition-colors items-center hover:bg-zinc-700"
            @click="showYtModal = true"
          >
            <div class="i-carbon-logo-youtube text-red-400" /> YouTube
          </button>
        </div>
      </div>

      <!-- Slide label -->
      <div
        v-if="currentItem"
        class="text-xs text-white/50 px-2 py-1 rounded-lg bg-black/30 bottom-4 left-4 absolute z-20 backdrop-blur-sm"
      >
        {{ currentIndex + 1 }} / {{ items.length }} — {{ currentItem.label }}
      </div>

      <!-- LFO active indicator -->
      <div
        v-if="lfo.active.value && isPlaying"
        class="text-[10px] text-teal-500/60 px-2 py-1 rounded bottom-4 right-4 absolute z-20"
      >
        ◇ LFO
      </div>

      <!-- Top-right controls: fullscreen + settings -->
      <div class="flex gap-1.5 right-3 top-3 absolute z-30">
        <button
          class="text-zinc-400 rounded-full bg-black/40 flex h-8 w-8 transition-colors items-center justify-center backdrop-blur hover:text-zinc-200"
          :title="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'"
          @click="toggleFullscreen"
        >
          <div :class="isFullscreen ? 'i-carbon-minimize' : 'i-carbon-maximize'" />
        </button>
        <button
          class="text-zinc-400 rounded-full bg-black/40 flex h-8 w-8 transition-colors items-center justify-center backdrop-blur hover:text-zinc-200"
          @click="showSettings = !showSettings"
        >
          <div class="i-carbon-settings" />
        </button>
      </div>

      <!-- Settings panel -->
      <Transition name="slide-settings">
        <div
          v-if="showSettings"
          class="p-4 border-l border-zinc-800 bg-zinc-900/95 h-full w-72 right-0 top-0 absolute z-30 overflow-y-auto backdrop-blur"
        >
          <div class="mb-4 flex items-center justify-between">
            <h3 class="text-sm text-zinc-200 font-semibold">
              Settings
            </h3>
            <button class="text-zinc-500 hover:text-zinc-300" @click="showSettings = false">
              <div class="i-carbon-close" />
            </button>
          </div>

          <div class="space-y-4">
            <!-- Delay + Beat Sync -->
            <div>
              <div class="mb-1 flex items-center justify-between">
                <label class="text-xs text-zinc-400">
                  Slide Delay
                  <span class="text-zinc-600">(±20% variance)</span>
                </label>
                <label class="flex gap-1.5 cursor-pointer items-center">
                  <input v-model="settings.beatSync" type="checkbox" class="accent-teal-500">
                  <span class="text-[10px] text-zinc-400">Beat sync</span>
                </label>
              </div>

              <div v-if="!settings.beatSync" class="space-y-1">
                <input
                  type="range" min="0.2" max="60" step="0.2"
                  :value="settings.delay"
                  class="ss-slider w-full"
                  @input="settings.delay = +($event.target as HTMLInputElement).value"
                >
                <div class="flex gap-1 items-center">
                  <input
                    min="0.2" max="60" step="0.2"
                    type="number"
                    :value="settings.delay"
                    class="flex-1"
                    @input="settings.delay = +($event.target as HTMLInputElement).value"
                  >
                  <span class="text-xs text-zinc-500">s</span>
                </div>
              </div>

              <div v-else class="space-y-1">
                <p class="text-[10px] text-zinc-500">
                  Advances every N beats · current: {{ ((settings.beatsPerSlide ?? 8) / Math.max(0.25, audioStore.beatDelta.value)).toFixed(1) }}s
                </p>
                <div class="flex flex-wrap gap-1">
                  <button
                    v-for="n in [1, 2, 4, 8, 16, 32]"
                    :key="n"
                    class="text-xs px-2 py-0.5 rounded transition-colors"
                    :class="(settings.beatsPerSlide ?? 8) === n ? 'bg-teal-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'"
                    @click="settings.beatsPerSlide = n"
                  >
                    {{ n }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Transition -->
            <div>
              <div class="mb-2 flex items-center justify-between">
                <label class="text-xs text-zinc-400">Transition</label>
                <label class="flex gap-1.5 cursor-pointer items-center">
                  <input v-model="settings.randomTransition" type="checkbox" class="accent-teal-500">
                  <span class="text-[10px] text-zinc-400">Random</span>
                </label>
              </div>

              <!-- Fixed single transition -->
              <div v-if="!settings.randomTransition">
                <div class="mb-2 gap-1 grid grid-cols-2">
                  <button
                    v-for="t in ALL_TRANSITIONS"
                    :key="t"
                    class="text-xs py-1.5 rounded-lg capitalize transition-colors"
                    :class="settings.transition === t ? 'bg-teal-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'"
                    @click="settings.transition = t"
                  >
                    {{ t }}
                  </button>
                </div>
                <label class="flex gap-2 cursor-pointer items-center">
                  <input v-model="settings.autoTransition" type="checkbox" class="accent-teal-500">
                  <span class="text-xs text-zinc-400">Auto by session phase</span>
                </label>
              </div>

              <!-- Random pool selector -->
              <div v-else>
                <p class="text-[10px] text-zinc-500 mb-1.5">
                  Pool — toggle to include/exclude:
                </p>
                <div class="gap-1 grid grid-cols-2">
                  <button
                    v-for="t in ALL_TRANSITIONS"
                    :key="t"
                    class="text-xs py-1.5 rounded-lg capitalize transition-colors"
                    :class="(settings.transitionPool ?? []).includes(t) ? 'bg-teal-600 text-white' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'"
                    @click="toggleTransitionPool(t)"
                  >
                    {{ t }}
                  </button>
                </div>
                <p v-if="transitionName" class="text-[10px] text-zinc-600 mt-1">
                  Next: {{ transitionName }}
                </p>
              </div>
            </div>

            <!-- Loop / Shuffle -->
            <label class="flex gap-2 cursor-pointer items-center">
              <input v-model="settings.loop" type="checkbox" class="accent-teal-500">
              <span class="text-xs text-zinc-300">Loop</span>
            </label>
            <label class="flex gap-2 cursor-pointer items-center">
              <input v-model="settings.shuffle" type="checkbox" class="accent-teal-500">
              <span class="text-xs text-zinc-300">Shuffle</span>
            </label>

            <!-- LFO controls -->
            <div class="pt-2 border-t border-zinc-800">
              <div class="mb-2 flex items-center justify-between">
                <p class="text-xs text-zinc-400">
                  LFO Animation
                </p>
                <span v-if="lfo.active.value && isPlaying" class="text-[10px] text-teal-500/70">● active</span>
              </div>
              <div class="mb-3 space-y-1.5">
                <label class="flex gap-2 cursor-pointer items-center">
                  <input v-model="lfo.config.zoomEnabled" type="checkbox" class="accent-teal-500">
                  <span class="text-xs text-zinc-400">Zoom</span>
                </label>
                <label class="flex gap-2 cursor-pointer items-center">
                  <input v-model="lfo.config.opacityEnabled" type="checkbox" class="accent-teal-500">
                  <span class="text-xs text-zinc-400">Opacity</span>
                </label>
                <label class="flex gap-2 cursor-pointer items-center">
                  <input v-model="lfo.config.panEnabled" type="checkbox" class="accent-teal-500">
                  <span class="text-xs text-zinc-400">Pan</span>
                </label>
                <label class="flex gap-2 cursor-pointer items-center">
                  <input v-model="settings.lfoOverlays" type="checkbox" class="accent-teal-500">
                  <span class="text-xs text-zinc-400">Apply to overlays</span>
                </label>
              </div>
              <div>
                <label class="text-[10px] text-zinc-500 mb-1 block">
                  Depth — {{ lfo.config.depthMultiplier.toFixed(1) }}×
                </label>
                <input
                  type="range" min="0" max="3" step="0.1"
                  :value="lfo.config.depthMultiplier"
                  class="ss-slider w-full"
                  @input="lfo.config.depthMultiplier = +($event.target as HTMLInputElement).value"
                >
              </div>
              <p class="text-[10px] text-zinc-600 mt-1.5">
                Speed syncs to beat frequency. Depth scales with session intensity.
              </p>
            </div>

            <!-- Overlays -->
            <div class="pt-2 border-t border-zinc-800">
              <div class="mb-2 flex items-center justify-between">
                <p class="text-xs text-zinc-400">
                  Overlays ({{ overlays.length }})
                </p>
                <button
                  class="text-[10px] text-teal-400 px-2 py-0.5 rounded bg-teal-900/30 flex gap-1 transition-colors items-center hover:bg-teal-900/50"
                  @click="openOverlayFilePicker"
                >
                  <div class="i-carbon-add text-[10px]" /> Add
                </button>
              </div>
              <p v-if="overlays.length === 0" class="text-[10px] text-zinc-600 py-2 text-center">
                Layer images, GIFs or videos over slides
              </p>
              <div class="space-y-2">
                <div
                  v-for="overlay in overlays"
                  :key="overlay.id"
                  class="p-2 rounded-lg bg-zinc-800/60 space-y-2"
                >
                  <div class="flex gap-2 items-center">
                    <input
                      type="checkbox"
                      :checked="overlay.enabled"
                      class="accent-teal-500 flex-shrink-0"
                      @change="updateOverlay(overlay.id, { enabled: ($event.target as HTMLInputElement).checked })"
                    >
                    <div
                      class="text-[10px] flex-shrink-0"
                      :class="overlay.type === 'video' ? 'i-carbon-video text-blue-400' : 'i-carbon-image text-teal-400'"
                    />
                    <span class="text-xs text-zinc-300 flex-1 truncate">{{ overlay.label }}</span>
                    <button
                      class="text-zinc-600 ml-auto flex-shrink-0 transition-colors hover:text-red-400"
                      @click="removeOverlay(overlay.id)"
                    >
                      <div class="i-carbon-trash-can text-xs" />
                    </button>
                  </div>
                  <div class="flex gap-2 items-center">
                    <span class="text-[10px] text-zinc-500 text-right flex-shrink-0 w-7">{{ Math.round(overlay.opacity * 100) }}%</span>
                    <input
                      type="range" min="0" max="1" step="0.01"
                      :value="overlay.opacity"
                      class="ss-slider flex-1"
                      @input="updateOverlay(overlay.id, { opacity: +($event.target as HTMLInputElement).value })"
                    >
                    <select
                      :value="overlay.blendMode"
                      class="text-[10px] text-zinc-300 px-1 py-0.5 outline-none rounded border-none bg-zinc-700 flex-shrink-0"
                      @change="updateOverlay(overlay.id, { blendMode: ($event.target as HTMLSelectElement).value })"
                    >
                      <option v-for="bm in BLEND_MODES" :key="bm" :value="bm">
                        {{ bm }}
                      </option>
                    </select>
                  </div>
                  <div class="flex gap-1">
                    <button
                      v-for="f in ['cover', 'contain', 'fill'] as const"
                      :key="f"
                      class="text-[10px] px-1.5 py-0.5 rounded capitalize transition-colors"
                      :class="overlay.fit === f ? 'bg-teal-600/50 text-teal-300' : 'bg-zinc-700/40 text-zinc-500 hover:text-zinc-300'"
                      @click="updateOverlay(overlay.id, { fit: f })"
                    >
                      {{ f }}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Slides list -->
            <div class="pt-3 border-t border-zinc-800">
              <p class="text-xs text-zinc-500 mb-2">
                Slides ({{ items.length }})
              </p>
              <div class="max-h-64 overflow-y-auto space-y-0.5">
                <div
                  v-for="(item, i) in items"
                  :key="item.id"
                  draggable="true"
                  class="p-1.5 border-t-2 rounded-lg flex gap-1.5 cursor-pointer transition-colors items-center"
                  :class="[
                    i === currentIndex ? 'bg-zinc-700' : 'hover:bg-zinc-800',
                    dragOverIdx === i && dragStartIdx !== i ? 'border-teal-500' : 'border-transparent',
                    dragStartIdx === i ? 'opacity-40' : '',
                  ]"
                  @click="currentIndex = i"
                  @dragstart="e => onDragStart(e, i)"
                  @dragover="e => onDragOver(e, i)"
                  @dragleave="onDragLeave"
                  @drop="e => onDrop(e, i)"
                  @dragend="onDragEnd"
                >
                  <div class="i-carbon-drag-horizontal text-zinc-600 flex-shrink-0 cursor-grab" />
                  <span class="text-[10px] text-zinc-500 flex-shrink-0 w-3">{{ i + 1 }}</span>
                  <div
                    class="text-[10px] flex-shrink-0"
                    :class="item.type === 'youtube' ? 'i-carbon-logo-youtube text-red-400' : item.type === 'video' ? 'i-carbon-video text-blue-400' : 'i-carbon-image text-teal-400'"
                  />
                  <span class="text-xs text-zinc-300 flex-1 truncate">{{ item.label }}</span>
                  <!-- Per-slide fit toggle -->
                  <button
                    class="text-[9px] px-1 py-0.5 rounded flex-shrink-0 transition-colors"
                    :class="item.fit === 'cover' ? 'text-teal-400' : 'text-zinc-600 hover:text-zinc-400'"
                    :title="item.fit === 'cover' ? 'Cover (crop to fill)' : 'Contain (fit inside)'"
                    @click.stop="updateItem(item.id, { fit: item.fit === 'cover' ? undefined : 'cover' })"
                  >
                    {{ item.fit === 'cover' ? '▣' : '▢' }}
                  </button>
                  <!-- Per-slide duration override -->
                  <input
                    type="number"
                    min="0.5" max="3600" step="0.5"
                    :value="item.duration ?? ''"
                    :placeholder="`${settings.delay}`"
                    class="text-[10px] text-zinc-500 py-0.5 text-center outline-none border border-zinc-700 rounded bg-transparent flex-shrink-0 w-8 focus:border-teal-600"
                    title="Duration override (s), empty = global delay"
                    @click.stop
                    @change="updateItem(item.id, { duration: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : undefined })"
                  >
                  <button
                    class="text-zinc-600 flex-shrink-0 transition-colors hover:text-red-400"
                    @click.stop="removeItem(item.id)"
                  >
                    <div class="i-carbon-trash-can text-xs" />
                  </button>
                </div>
              </div>
              <div class="mt-2 flex gap-1">
                <button
                  class="text-xs text-zinc-400 py-1 rounded-lg bg-zinc-800 flex flex-1 gap-1 transition-colors items-center justify-center hover:bg-zinc-700"
                  @click="openFilePicker"
                >
                  <div class="i-carbon-upload text-xs" /> Files
                </button>
                <button
                  class="text-xs text-zinc-400 py-1 rounded-lg bg-zinc-800 flex flex-1 gap-1 transition-colors items-center justify-center hover:bg-zinc-700"
                  @click="showYtModal = true"
                >
                  <div class="i-carbon-logo-youtube text-xs text-red-400" /> YouTube
                </button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <!-- Playback controls -->
    <div class="py-3 border-t border-zinc-800 bg-zinc-900 flex flex-shrink-0 gap-4 items-center justify-center z-20">
      <button
        class="text-zinc-300 rounded-full bg-zinc-800 flex h-9 w-9 transition-colors items-center justify-center hover:bg-zinc-700 disabled:opacity-40"
        :disabled="items.length === 0"
        @click="prev"
      >
        <div class="i-carbon-skip-back-filled text-sm" />
      </button>
      <button
        class="rounded-full flex h-11 w-11 transition-all items-center justify-center disabled:opacity-40 active:scale-95"
        :class="isPlaying ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-teal-600 hover:bg-teal-500 text-white'"
        :disabled="items.length === 0"
        @click="togglePlay"
      >
        <div :class="isPlaying ? 'i-carbon-pause-filled' : 'i-carbon-play-filled'" class="text-base" />
      </button>
      <button
        class="text-zinc-300 rounded-full bg-zinc-800 flex h-9 w-9 transition-colors items-center justify-center hover:bg-zinc-700 disabled:opacity-40"
        :disabled="items.length === 0"
        @click="next"
      >
        <div class="i-carbon-skip-forward-filled text-sm" />
      </button>
    </div>

    <!-- File pickers -->
    <input ref="fileInput" type="file" accept="image/*,video/*" multiple class="hidden" @change="onFileInput">
    <input ref="overlayFileInput" type="file" accept="image/*,video/*" multiple class="hidden" @change="onOverlayFileInput">

    <AddYoutubeModal
      :open="showYtModal"
      @close="showYtModal = false"
      @add="addYoutube"
    />
  </div>
</template>

<style scoped>
/* ── Transitions ── */

/* True crossfade: entering slide at full opacity underneath, leaving fades out on top */
.fade-leave-active {
  z-index: 1;
  transition: opacity 0.6s ease;
}
.fade-leave-to {
  opacity: 0;
}

.slide-enter-active,
.slide-leave-active {
  transition: transform 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.slide-enter-from {
  transform: translateX(100%);
}
.slide-leave-to {
  transform: translateX(-100%);
}

.zoom-enter-active,
.zoom-leave-active {
  transition:
    opacity 0.5s ease,
    transform 0.5s ease;
}
.zoom-enter-from {
  opacity: 0;
  transform: scale(1.08);
}
.zoom-leave-to {
  opacity: 0;
  transform: scale(0.94);
}

.flip-enter-active,
.flip-leave-active {
  transition:
    transform 0.55s ease,
    opacity 0.55s ease;
}
.flip-enter-from {
  transform: perspective(900px) rotateY(90deg);
  opacity: 0;
}
.flip-leave-to {
  transform: perspective(900px) rotateY(-90deg);
  opacity: 0;
}

.blur-enter-active,
.blur-leave-active {
  transition:
    opacity 0.55s ease,
    filter 0.55s ease;
}
.blur-enter-from,
.blur-leave-to {
  opacity: 0;
  filter: blur(24px);
}

.wipe-enter-active,
.wipe-leave-active {
  transition: clip-path 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.wipe-enter-from {
  clip-path: inset(0 100% 0 0);
}
.wipe-leave-to {
  clip-path: inset(0 0 0 100%);
}

.rotate-enter-active,
.rotate-leave-active {
  transition:
    opacity 0.5s ease,
    transform 0.5s ease;
}
.rotate-enter-from {
  opacity: 0;
  transform: rotate(-6deg) scale(0.88);
}
.rotate-leave-to {
  opacity: 0;
  transform: rotate(6deg) scale(0.88);
}

/* ── Settings panel ── */
.slide-settings-enter-active,
.slide-settings-leave-active {
  transition: transform 0.25s ease;
}
.slide-settings-enter-from,
.slide-settings-leave-to {
  transform: translateX(100%);
}

/* ── Shared slider ── */
.ss-slider {
  -webkit-appearance: none;
  appearance: none;
  background: #3f3f46;
  border-radius: 4px;
  height: 4px;
  outline: none;
  width: 100%;
}
.ss-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  background: #2dd4bf;
  border-radius: 50%;
  cursor: pointer;
}
.ss-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  background: #2dd4bf;
  border-radius: 50%;
  cursor: pointer;
  border: none;
}
</style>
