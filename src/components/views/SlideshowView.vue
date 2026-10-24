<script setup lang="ts">
import type { AdvanceMode } from '~/composables/useSlideshowEngine'
import type { SlideshowOverlay, TransitionName } from '~/stores/slideshow'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiSection from '~/components/ui/UiSection.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSelect from '~/components/ui/UiSelect.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import AddYoutubeModal from '~/components/views/AddYoutubeModal.vue'
import { useIdleChrome } from '~/composables/useIdleChrome'
import { mediaKind, pickMediaFiles, useMediaDrop } from '~/composables/useMediaDrop'
import { useSlideshowEngine } from '~/composables/useSlideshowEngine'
import { toast } from '~/composables/useToast'
import { useAudioStore } from '~/stores/audio'
import { usePlayerStore } from '~/stores/playerStore'
import { useSlideshowStore } from '~/stores/slideshow'
import { useUiStore } from '~/stores/uiStore'

defineOptions({ name: 'SlideshowView' })

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
} = useSlideshowStore()
const audioStore = useAudioStore()
const ui = useUiStore()
const player = usePlayerStore()

const engine = useSlideshowEngine()
const { currentItem, mode, beatSlideSeconds, progress, pulseAvailable, activeTransition, transitionName } = engine
const { prev, next, goTo, togglePlay, toggleTransitionPool } = engine
const lfoValues = engine.lfo.values
const lfoConfig = engine.lfo.config
const lfoActive = engine.lfo.active

const root = ref<HTMLElement | null>(null)
const sheetOpen = ref(false)
const ytOpen = ref(false)
const overToolbar = ref(false)
/** Quick panel hanging under the toolbar. Drawn inside the view, not teleported, so it still works in fullscreen. */
const tray = ref<'transition' | 'timing' | null>(null)

const chrome = useIdleChrome({
  enabled: () => isPlaying.value && items.length > 0,
  hold: () => overToolbar.value || sheetOpen.value || ytOpen.value || tray.value !== null,
})

// ─── Options ────────────────────────────────────────────────────────────────
const TRANSITIONS: { value: TransitionName, label: string, icon: string }[] = [
  { value: 'fade', label: 'Fade', icon: 'i-carbon-fade' },
  { value: 'slide', label: 'Slide', icon: 'i-carbon-arrow-right' },
  { value: 'zoom', label: 'Zoom', icon: 'i-carbon-zoom-in' },
  { value: 'flip', label: 'Flip', icon: 'i-carbon-rotate-180' },
  { value: 'blur', label: 'Blur', icon: 'i-carbon-fog' },
  { value: 'wipe', label: 'Wipe', icon: 'i-carbon-split-screen' },
  { value: 'rotate', label: 'Rotate', icon: 'i-carbon-rotate' },
  { value: 'none', label: 'Cut', icon: 'i-carbon-subtract' },
]
const transitionMeta = computed(() => TRANSITIONS.find(t => t.value === activeTransition.value) ?? TRANSITIONS[0])

const MODES: { value: AdvanceMode, label: string, icon: string, title: string }[] = [
  { value: 'timer', label: 'Timer', icon: 'i-carbon-timer', title: 'Fixed delay, ±20% so it never feels mechanical' },
  { value: 'beat', label: 'Beats', icon: 'i-carbon-music', title: 'Every N beats of the binaural beat frequency' },
  { value: 'pulse', label: 'Pulse', icon: 'i-carbon-activity', title: 'Locked to the shared session pulse' },
]
const COUNTS = [1, 2, 4, 8, 16, 32].map(n => ({ value: n, label: String(n) }))

const BLEND_MODES = ['normal', 'screen', 'overlay', 'multiply', 'soft-light', 'color-dodge', 'lighten', 'darken']
  .map(b => ({ value: b, label: b.replace('-', ' ') }))
const OVERLAY_FITS: { value: SlideshowOverlay['fit'], label: string }[] = [
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
  { value: 'fill', label: 'Stretch' },
]

const timingLabel = computed(() => {
  if (mode.value === 'pulse')
    return `${settings.value.pulsesPerSlide} pulse${settings.value.pulsesPerSlide === 1 ? '' : 's'}`
  if (mode.value === 'beat')
    return `${settings.value.beatsPerSlide} beat${settings.value.beatsPerSlide === 1 ? '' : 's'}`
  return `${settings.value.delay}s`
})
const timingIcon = computed(() => MODES.find(m => m.value === mode.value)?.icon ?? 'i-carbon-timer')

const pulseWaiting = computed(() => isPlaying.value && mode.value === 'pulse' && !pulseAvailable.value)

// ─── Adding ─────────────────────────────────────────────────────────────────
function addFiles(files: File[]) {
  const wasEmpty = items.length === 0
  let n = 0
  for (const file of files) {
    const kind = mediaKind(file)
    if (!kind)
      continue
    addItem({ type: kind, src: URL.createObjectURL(file), label: file.name })
    n++
  }
  if (!n)
    return
  if (wasEmpty)
    currentIndex.value = 0
  toast.success(`Added ${n} slide${n === 1 ? '' : 's'}`, { icon: 'i-carbon-image', key: 'ss-add' })
}

const drop = useMediaDrop(files => addFiles(files))

function addFromDisk() {
  pickMediaFiles(addFiles)
}

async function openYoutube() {
  // The dialog is teleported to <body>, which fullscreen would hide.
  if (document.fullscreenElement)
    await document.exitFullscreen().catch(() => {})
  tray.value = null
  ytOpen.value = true
}

function addYoutube({ youtubeId, label }: { youtubeId: string, label: string }) {
  addItem({ type: 'youtube', src: youtubeId, label })
}

function addOverlaysFromDisk() {
  pickMediaFiles((files) => {
    for (const file of files) {
      const kind = mediaKind(file)
      if (!kind)
        continue
      addOverlay({ type: kind, src: URL.createObjectURL(file), label: file.name, opacity: 0.5, blendMode: 'screen', enabled: true, fit: 'cover' })
    }
  })
}

function randomizeVideoStart(e: Event) {
  const video = e.target as HTMLVideoElement
  if (video.duration && Number.isFinite(video.duration))
    video.currentTime = Math.random() * video.duration
}

// ─── Slide list ─────────────────────────────────────────────────────────────
function removeSlide(id: string) {
  const idx = items.findIndex(i => i.id === id)
  if (idx < 0)
    return
  // Keep showing the same slide when one before it goes.
  if (idx < currentIndex.value)
    currentIndex.value--
  removeItem(id)
}

const dragFrom = ref<number | null>(null)
const dragOver = ref<number | null>(null)

function onRowDragStart(e: DragEvent, i: number) {
  dragFrom.value = i
  if (e.dataTransfer)
    e.dataTransfer.effectAllowed = 'move'
}
function onRowDragOver(e: DragEvent, i: number) {
  if (dragFrom.value === null)
    return
  e.preventDefault()
  dragOver.value = i
}
function onRowDrop(e: DragEvent, i: number) {
  if (dragFrom.value === null)
    return
  e.preventDefault()
  const from = dragFrom.value
  if (from !== i) {
    const currentId = currentItem.value?.id
    moveItem(from, i)
    const idx = items.findIndex(it => it.id === currentId)
    if (idx >= 0)
      currentIndex.value = idx
  }
  dragFrom.value = null
  dragOver.value = null
}
function onRowDragEnd() {
  dragFrom.value = null
  dragOver.value = null
}

function setDuration(id: string, e: Event) {
  const v = (e.target as HTMLInputElement).value
  updateItem(id, { duration: v ? Math.max(0.5, +v) : undefined })
}

function ytThumb(id: string) {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
}

// ─── Stage styling ──────────────────────────────────────────────────────────
const ytUrl = computed(() => {
  if (!currentItem.value || currentItem.value.type !== 'youtube')
    return ''
  const id = currentItem.value.src
  return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}&controls=0&modestbranding=1&playsinline=1&rel=0`
})

// The noise bed darkens the picture a little, so louder noise reads as dimmer light.
const brightnessOverlayOpacity = computed(() =>
  audioStore.noiseEnabled.value ? audioStore.noiseVolume.value * 0.25 : 0,
)

const lfoStyle = computed(() => {
  if (!isPlaying.value)
    return {}
  return {
    transform: `scale(${lfoValues.zoom}) translate(${lfoValues.panX}px, ${lfoValues.panY}px)`,
    opacity: lfoValues.opacity,
    transition: 'none',
  }
})

const activeOverlays = computed(() => overlays.filter(o => o.enabled))

function overlayMediaStyle(overlay: SlideshowOverlay) {
  const lfoOpacity = (isPlaying.value && lfoActive.value && settings.value.lfoOverlays) ? lfoValues.opacity : 1
  return {
    opacity: overlay.opacity * lfoOpacity,
    mixBlendMode: overlay.blendMode as any,
    objectFit: overlay.fit,
  }
}

// ─── Fullscreen ─────────────────────────────────────────────────────────────
const isFullscreen = ref(false)

function onFullscreenChange() {
  isFullscreen.value = document.fullscreenElement === root.value
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement)
      await document.exitFullscreen()
    else
      await root.value?.requestFullscreen()
  }
  catch {
    toast.warn('Fullscreen was refused by the browser')
  }
}

// ─── Keyboard ───────────────────────────────────────────────────────────────
// Captured at the document so the slideshow owns Space, arrows and F while it
// is on stage, instead of the (mini) video player underneath.
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    return
  if (e.ctrlKey || e.metaKey || e.altKey)
    return
  if (ytOpen.value || ui.paletteOpen || ui.settingsOpen || ui.shortcutsOpen || document.querySelector('[data-ui-popover]'))
    return

  let handled = true
  switch (e.code) {
    case 'Space':
      togglePlay()
      break
    case 'ArrowLeft':
      prev()
      break
    case 'ArrowRight':
      next()
      break
    case 'KeyF':
      void toggleFullscreen()
      break
    case 'Escape':
      // Close our own layers before the shell reads Escape as panic. In
      // fullscreen the browser takes Escape itself.
      if (tray.value)
        tray.value = null
      else if (sheetOpen.value)
        sheetOpen.value = false
      else
        handled = false
      break
    default:
      handled = false
  }
  if (handled) {
    e.preventDefault()
    e.stopPropagation()
    chrome.poke()
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('fullscreenchange', onFullscreenChange)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  if (document.fullscreenElement === root.value)
    void document.exitFullscreen().catch(() => {})
})

function toggleTray(t: 'transition' | 'timing') {
  tray.value = tray.value === t ? null : t
}
</script>

<template>
  <div
    ref="root"
    class="bg-black h-full w-full relative overflow-hidden isolate"
    :class="chrome.visible.value ? '' : 'cursor-none'"
    v-on="drop.handlers"
    @pointermove="chrome.poke"
    @pointerdown="chrome.poke"
  >
    <!-- Slides -->
    <div class="inset-0 absolute overflow-hidden" @pointerdown="tray = null" @dblclick="toggleFullscreen">
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
            :title="currentItem.label"
            class="border-0 h-full w-full pointer-events-none"
            allow="autoplay; encrypted-media"
            referrerpolicy="strict-origin-when-cross-origin"
          />
        </div>
      </Transition>
    </div>

    <!-- Audio-reactive brightness -->
    <div
      class="bg-black pointer-events-none transition-opacity duration-500 inset-0 absolute z-10"
      :style="{ opacity: brightnessOverlayOpacity }"
    />

    <!-- Overlays -->
    <div v-for="overlay in activeOverlays" :key="overlay.id" class="pointer-events-none inset-0 absolute z-[11]">
      <img
        v-if="overlay.type === 'image'"
        :src="overlay.src"
        class="h-full w-full"
        :style="overlayMediaStyle(overlay)"
        draggable="false"
      >
      <video
        v-else
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

    <!-- Vignette -->
    <div v-if="currentItem" class="vignette pointer-events-none inset-0 absolute z-[12]" />

    <!-- Progress through the current slide -->
    <div
      v-if="items.length"
      class="h-0.5 pointer-events-none transition-opacity duration-500 inset-x-0 top-0 absolute z-20"
      :class="isPlaying && chrome.visible.value ? 'opacity-100' : 'opacity-40'"
    >
      <div class="bg-accent h-full w-full origin-left" :style="{ transform: `scaleX(${progress})` }" />
    </div>

    <!-- Empty state: the whole view is the drop zone. -->
    <Transition name="t-fade">
      <div v-if="!items.length" class="p-6 bg-surface-950 center inset-0 absolute z-20">
        <div
          class="border-2 rounded-[var(--radius-xl)] border-dashed flex flex-col h-full max-h-[520px] max-w-[760px] w-full transition-colors duration-200 items-center justify-center"
          :class="drop.over.value ? 'border-accent/70 bg-accent-soft' : 'border-edge-strong bg-surface-900/40'"
        >
          <UiEmpty
            size="lg"
            icon="i-carbon-image"
            title="Start a slideshow"
            description="Drop images and videos here. Slides can advance on a timer, every few binaural beats, or locked to the session pulse."
          >
            <UiButton variant="primary" size="md" icon="i-carbon-add" @click="addFromDisk">
              Add images or videos
            </UiButton>
            <UiButton size="md" icon="i-carbon-logo-youtube" @click="openYoutube">
              Add YouTube
            </UiButton>
          </UiEmpty>
        </div>
      </div>
    </Transition>

    <!-- Toolbar, with its quick-settings tray underneath -->
    <div
      v-if="items.length"
      class="chrome flex flex-col gap-2 items-center left-1/2 top-3 absolute z-30"
      :class="chrome.visible.value ? '' : 'is-hidden'"
      @pointerenter="overToolbar = true"
      @pointerleave="overToolbar = false"
      @pointerdown.stop
    >
      <div class="p-1 rounded-full glass flex gap-0.5 ring-1 ring-edge-strong shadow-[var(--shadow-lg)] items-center">
        <UiIconButton icon="i-carbon-skip-back-filled" label="Previous slide" kbd="←" tip="bottom" class="!rounded-full" @click="prev" />
        <button
          v-tip="{ text: isPlaying ? 'Pause' : 'Play', kbd: 'Space', placement: 'bottom' }"
          type="button"
          :aria-label="isPlaying ? 'Pause' : 'Play'"
          class="focusable rounded-full center shrink-0 h-8 w-8 pressable"
          :class="isPlaying ? 'bg-fg/10 text-fg hover:bg-fg/16' : 'bg-accent text-accent-contrast hover:brightness-110'"
          @click="togglePlay"
        >
          <span :class="isPlaying ? 'i-carbon-pause-filled' : 'i-carbon-play-filled-alt'" class="text-[15px]" />
        </button>
        <UiIconButton icon="i-carbon-skip-forward-filled" label="Next slide" kbd="→" tip="bottom" class="!rounded-full" @click="next" />

        <span class="text-[12px] text-fg-muted num px-2 text-center min-w-[52px]">
          {{ currentIndex + 1 }}<span class="text-fg-faint"> / {{ items.length }}</span>
        </span>

        <span class="mx-0.5 divider-x" />

        <UiButton
          variant="ghost"
          :icon="settings.randomTransition ? 'i-carbon-shuffle' : transitionMeta.icon"
          icon-right="i-carbon-chevron-down"
          :active="tray === 'transition'"
          class="!rounded-full"
          @click="toggleTray('transition')"
        >
          <span class="hidden lg:inline">{{ settings.randomTransition ? 'Random' : transitionMeta.label }}</span>
        </UiButton>
        <UiButton
          variant="ghost"
          :icon="timingIcon"
          icon-right="i-carbon-chevron-down"
          :active="tray === 'timing'"
          class="!rounded-full"
          @click="toggleTray('timing')"
        >
          <span class="num">{{ timingLabel }}</span>
        </UiButton>

        <span class="mx-0.5 divider-x" />

        <UiIconButton icon="i-carbon-shuffle" label="Shuffle" :active="settings.shuffle" tip="bottom" class="!rounded-full" @click="settings.shuffle = !settings.shuffle" />
        <UiIconButton icon="i-carbon-repeat" label="Loop" :active="settings.loop" tip="bottom" class="!rounded-full" @click="settings.loop = !settings.loop" />

        <span class="mx-0.5 divider-x" />

        <UiIconButton icon="i-carbon-add" label="Add images or videos" tip="bottom" class="!rounded-full" @click="addFromDisk" />
        <UiIconButton icon="i-carbon-logo-youtube" label="Add YouTube" tip="bottom" class="!rounded-full" @click="openYoutube" />
        <UiIconButton
          icon="i-carbon-settings-adjust"
          label="Slideshow settings"
          :active="sheetOpen"
          tip="bottom"
          class="!rounded-full"
          @click="sheetOpen = !sheetOpen; tray = null"
        />
        <UiIconButton
          :icon="isFullscreen ? 'i-carbon-minimize' : 'i-carbon-maximize'"
          :label="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'"
          kbd="F"
          tip="bottom"
          class="!rounded-full"
          @click="toggleFullscreen"
        />
      </div>

      <!-- Quick tray -->
      <Transition name="t-pop" mode="out-in">
        <div
          v-if="tray === 'transition'"
          key="transition"
          class="p-2 rounded-[var(--radius-lg)] glass w-[300px] ring-1 ring-edge-strong shadow-[var(--shadow-lg)]"
          style="transform-origin: top center"
        >
          <div class="mb-1.5 px-1 flex items-center justify-between">
            <span class="eyebrow">Transition</span>
            <div class="text-[11.5px] text-fg-muted flex gap-2 items-center">
              Random
              <UiSwitch v-model="settings.randomTransition" size="sm" />
            </div>
          </div>
          <div class="gap-1 grid grid-cols-4">
            <button
              v-for="t in TRANSITIONS"
              :key="t.value"
              type="button"
              class="text-[11px] py-2 focusable rounded-[var(--radius-sm)] flex flex-col gap-1 pressable items-center"
              :class="(settings.randomTransition ? settings.transitionPool.includes(t.value) : settings.transition === t.value)
                ? 'bg-accent-soft text-accent-300'
                : 'text-fg-muted hover:bg-fg/8 hover:text-fg'"
              @click="settings.randomTransition ? toggleTransitionPool(t.value) : (settings.transition = t.value)"
            >
              <span :class="t.icon" class="text-[16px]" />
              {{ t.label }}
            </button>
          </div>
          <p class="hint mt-1.5 px-1">
            {{ settings.randomTransition ? `Pick the pool to draw from · next: ${transitionMeta.label.toLowerCase()}` : settings.autoTransition ? 'Following the session phase — turn that off in settings to pick one' : 'Used for every slide change' }}
          </p>
        </div>

        <div
          v-else-if="tray === 'timing'"
          key="timing"
          class="p-3 rounded-[var(--radius-lg)] glass flex flex-col gap-2.5 w-[300px] ring-1 ring-edge-strong shadow-[var(--shadow-lg)]"
          style="transform-origin: top center"
        >
          <span class="eyebrow">Advance</span>
          <UiSegmented v-model="mode" :options="MODES" block />
          <UiSlider
            v-if="mode === 'timer'"
            v-model="settings.delay"
            label="Seconds per slide"
            :min="0.2" :max="60" :step="0.2" :reset="5" unit="s"
            hint="±20% each time so it never feels mechanical"
          />
          <template v-else-if="mode === 'beat'">
            <UiSegmented v-model="settings.beatsPerSlide" :options="COUNTS" size="xs" block />
            <span class="hint">Beats per slide · {{ beatSlideSeconds.toFixed(1) }}s at {{ audioStore.beatDelta.value.toFixed(1) }} Hz</span>
          </template>
          <template v-else>
            <UiSegmented v-model="settings.pulsesPerSlide" :options="COUNTS" size="xs" block />
            <span class="hint">Pulses per slide · lands on the beat the audio and device share</span>
          </template>
        </div>
      </Transition>

      <!-- Pulse sync has nothing to follow until the session audio runs. -->
      <Transition name="t-fade">
        <div
          v-if="pulseWaiting && !tray"
          class="text-[12px] text-fg-muted py-1.5 pl-3 pr-1.5 rounded-full glass flex gap-2 ring-1 ring-edge-strong items-center"
        >
          <span class="i-carbon-activity text-warn" />
          Waiting for the session pulse
          <UiButton size="xs" variant="subtle" class="!rounded-full" @click="ui.openInspector('binaural')">
            Open audio
          </UiButton>
        </div>
      </Transition>
    </div>

    <!-- Caption (bottom-left; the mini player owns the other corner) -->
    <Transition name="t-fade">
      <div
        v-if="currentItem && chrome.visible.value"
        class="text-[12px] text-fg-muted py-1.5 pl-2.5 pr-3 rounded-full glass flex gap-2 max-w-[min(420px,45%)] ring-1 ring-edge items-center bottom-4 left-4 absolute z-30"
      >
        <span
          :class="currentItem.type === 'youtube' ? 'i-carbon-logo-youtube' : currentItem.type === 'video' ? 'i-carbon-video' : 'i-carbon-image'"
          class="text-[13px] text-fg-faint shrink-0"
        />
        <span class="text-fg truncate">{{ currentItem.label }}</span>
        <span v-if="lfoActive && isPlaying" v-tip="'Motion LFO is animating the slide'" class="text-[10.5px] text-accent-300 tracking-wide font-medium flex shrink-0 gap-1 items-center">
          <span class="rounded-full bg-accent-300 h-1.5 w-1.5 animate-pulse-dot" />LFO
        </span>
      </div>
    </Transition>

    <!-- Settings sheet -->
    <Transition name="t-slide-right">
      <aside
        v-if="sheetOpen"
        class="border border-edge rounded-[var(--radius-lg)] bg-surface-900/92 flex flex-col w-[320px] shadow-[var(--shadow-lg)] bottom-3 right-3 top-3 absolute z-40 overflow-hidden backdrop-blur-xl"
        @pointerdown.stop
        @dblclick.stop
      >
        <header class="pl-4 pr-2 border-b border-edge flex shrink-0 gap-2 h-11 items-center">
          <span class="i-carbon-image text-[15px] text-fg-muted" />
          <span class="text-[13px] text-fg font-medium flex-1">Slideshow</span>
          <UiIconButton icon="i-carbon-close" label="Close" kbd="Esc" tip="left" @click="sheetOpen = false" />
        </header>

        <div class="p-2.5 scroll-y flex flex-1 flex-col gap-2.5" :class="player.videoUrl && !isFullscreen ? 'pb-[230px]' : ''">
          <!-- Slides -->
          <UiSection title="Slides" icon="i-carbon-list" :summary="`${items.length}`" collapsible>
            <template #actions>
              <UiIconButton icon="i-carbon-add" label="Add images or videos" size="xs" @click="addFromDisk" />
              <UiIconButton icon="i-carbon-logo-youtube" label="Add YouTube" size="xs" @click="openYoutube" />
            </template>
            <ul class="scroll-y flex flex-col gap-0.5 max-h-[300px] -mx-1">
              <li
                v-for="(item, i) in items"
                :key="item.id"
                draggable="true"
                class="group px-1 border-t-2 rounded-[var(--radius-sm)] flex gap-2 h-10 cursor-pointer transition-colors items-center"
                :class="[
                  i === currentIndex ? 'bg-accent-soft' : 'hover:bg-fg/6',
                  dragOver === i && dragFrom !== i ? 'border-accent' : 'border-transparent',
                  dragFrom === i ? 'opacity-40' : '',
                ]"
                @click="goTo(i)"
                @dragstart="onRowDragStart($event, i)"
                @dragover="onRowDragOver($event, i)"
                @dragleave="dragOver = null"
                @drop="onRowDrop($event, i)"
                @dragend="onRowDragEnd"
              >
                <span class="i-carbon-draggable text-[13px] text-fg-faint shrink-0 cursor-grab" />
                <div class="rounded-[var(--radius-xs)] bg-surface-950 shrink-0 h-7 w-11 ring-1 ring-edge relative overflow-hidden">
                  <img v-if="item.type === 'image'" :src="item.src" alt="" class="h-full w-full object-cover" draggable="false">
                  <img v-else-if="item.type === 'youtube'" :src="ytThumb(item.src)" alt="" class="h-full w-full object-cover" draggable="false">
                  <video v-else :src="`${item.src}#t=1`" preload="metadata" muted class="h-full w-full object-cover" />
                  <span v-if="i === currentIndex && isPlaying" class="bg-black/40 center inset-0 absolute">
                    <span class="i-carbon-play-filled-alt text-[11px] text-white" />
                  </span>
                </div>
                <span class="text-[12px] flex-1 min-w-0 truncate" :class="i === currentIndex ? 'text-fg' : 'text-fg-muted'">{{ item.label }}</span>
                <UiIconButton
                  icon="i-carbon-fit-to-screen"
                  :label="item.fit === 'cover' ? 'Cover: crop to fill' : 'Contain: fit inside'"
                  :active="item.fit === 'cover'"
                  size="xs"
                  tip="left"
                  class="shrink-0"
                  @click.stop="updateItem(item.id, { fit: item.fit === 'cover' ? undefined : 'cover' })"
                />
                <input
                  v-tip="{ text: 'Seconds on screen (blank uses the global delay)', placement: 'left' }"
                  type="number"
                  min="0.5" max="3600" step="0.5"
                  :value="item.duration ?? ''"
                  :placeholder="`${settings.delay}`"
                  class="text-[11px] text-fg num px-1 text-center outline-none border border-edge-strong rounded-[var(--radius-xs)] bg-surface-950/60 shrink-0 h-6 w-10 transition-colors placeholder:text-fg-faint focus:border-accent/70"
                  @click.stop
                  @change="setDuration(item.id, $event)"
                >
                <UiIconButton
                  icon="i-carbon-close"
                  label="Remove slide"
                  size="xs"
                  tip="left"
                  class="opacity-0 shrink-0 focus-visible:opacity-100 group-hover:opacity-100"
                  @click.stop="removeSlide(item.id)"
                />
              </li>
            </ul>
          </UiSection>

          <!-- Timing -->
          <UiSection title="Timing" icon="i-carbon-timer" :summary="timingLabel" collapsible>
            <UiSegmented v-model="mode" :options="MODES" block />
            <template v-if="mode === 'timer'">
              <UiSlider
                v-model="settings.delay"
                label="Seconds per slide"
                :min="0.2" :max="60" :step="0.2" :reset="5" unit="s"
                hint="Varies ±20% each time. Per-slide times in the list override it."
              />
            </template>
            <template v-else-if="mode === 'beat'">
              <span class="label">Beats per slide</span>
              <UiSegmented v-model="settings.beatsPerSlide" :options="COUNTS" size="xs" block />
              <span class="hint">{{ beatSlideSeconds.toFixed(1) }}s per slide at the current {{ audioStore.beatDelta.value.toFixed(1) }} Hz beat — it re-times as the beat drifts.</span>
            </template>
            <template v-else>
              <span class="label">Pulses per slide</span>
              <UiSegmented v-model="settings.pulsesPerSlide" :options="COUNTS" size="xs" block />
              <span class="hint">Advances on the shared session pulse, so slides land on the same beat as the audio and the device.</span>
              <span v-if="!pulseAvailable" class="text-[11.5px] text-warn flex gap-1.5 items-center">
                <span class="i-carbon-warning-alt" /> No pulse yet — start the session audio.
              </span>
            </template>
          </UiSection>

          <!-- Transition -->
          <UiSection title="Transition" icon="i-carbon-fade" :summary="settings.randomTransition ? 'Random' : transitionMeta.label" collapsible>
            <UiSwitch v-model="settings.randomTransition" label="Random" hint="Draw a different one from the pool each slide" />
            <div class="gap-1 grid grid-cols-4">
              <button
                v-for="t in TRANSITIONS"
                :key="t.value"
                type="button"
                class="text-[11px] py-2 focusable rounded-[var(--radius-sm)] flex flex-col gap-1 ring-1 pressable items-center relative"
                :class="(settings.randomTransition ? settings.transitionPool.includes(t.value) : settings.transition === t.value)
                  ? 'bg-accent-soft text-accent-300 ring-accent/40'
                  : 'text-fg-muted ring-edge hover:bg-fg/6 hover:text-fg'"
                @click="settings.randomTransition ? toggleTransitionPool(t.value) : (settings.transition = t.value)"
              >
                <span :class="t.icon" class="text-[16px]" />
                {{ t.label }}
                <span
                  v-if="settings.randomTransition && settings.transitionPool.includes(t.value)"
                  class="i-carbon-checkmark text-[10px] right-1 top-1 absolute"
                />
              </button>
            </div>
            <span v-if="settings.randomTransition" class="hint">Next: {{ transitionMeta.label.toLowerCase() }}</span>
            <UiSwitch
              v-model="settings.autoTransition"
              :disabled="settings.randomTransition"
              label="Follow the session phase"
              hint="Fade at rest, slide on entry, zoom while building, rotate at peak, blur on the way down"
            />
          </UiSection>

          <!-- Playback -->
          <UiSection title="Playback" icon="i-carbon-repeat" collapsible>
            <UiSwitch v-model="settings.loop" label="Loop" hint="Start over after the last slide" />
            <UiSwitch v-model="settings.shuffle" label="Shuffle" hint="Jump to a random slide each time" />
          </UiSection>

          <!-- Motion -->
          <UiSection title="Motion" icon="i-carbon-wave-direction" :live="lfoActive && isPlaying" collapsible>
            <div class="gap-x-4 gap-y-2.5 grid grid-cols-2">
              <UiSwitch v-model="lfoConfig.zoomEnabled" size="sm" label="Zoom" />
              <UiSwitch v-model="lfoConfig.panEnabled" size="sm" label="Pan" />
              <UiSwitch v-model="lfoConfig.opacityEnabled" size="sm" label="Breathe" />
              <UiSwitch v-model="settings.lfoOverlays" size="sm" label="Overlays too" />
            </div>
            <UiSlider
              v-model="lfoConfig.depthMultiplier"
              label="Depth"
              :min="0" :max="3" :step="0.1" :reset="1"
              :format="v => `${v.toFixed(1)}×`"
              hint="Speed follows the beat frequency while playing."
            />
          </UiSection>

          <!-- Overlays -->
          <UiSection title="Overlays" icon="i-carbon-layers" :summary="overlays.length ? `${activeOverlays.length} / ${overlays.length}` : undefined" collapsible>
            <template #actions>
              <UiIconButton icon="i-carbon-add" label="Add overlay" size="xs" @click="addOverlaysFromDisk" />
            </template>
            <p v-if="!overlays.length" class="hint">
              Layer images, GIFs or video over every slide, blended like a lighting gel.
            </p>
            <TransitionGroup tag="div" name="t-list" class="flex flex-col gap-2 relative">
              <div v-for="overlay in overlays" :key="overlay.id" class="p-2.5 well flex flex-col gap-2.5">
                <div class="flex gap-2 min-w-0 items-center">
                  <UiSwitch
                    :model-value="overlay.enabled"
                    size="sm"
                    @update:model-value="v => updateOverlay(overlay.id, { enabled: v })"
                  />
                  <span :class="overlay.type === 'video' ? 'i-carbon-video' : 'i-carbon-image'" class="text-[13px] text-fg-faint shrink-0" />
                  <span class="text-[12px] flex-1 truncate" :class="overlay.enabled ? 'text-fg' : 'text-fg-faint'">{{ overlay.label }}</span>
                  <UiIconButton icon="i-carbon-trash-can" label="Remove overlay" size="xs" tip="left" @click="removeOverlay(overlay.id)" />
                </div>
                <UiSlider
                  :model-value="overlay.opacity"
                  label="Opacity"
                  :min="0" :max="1" :step="0.01" :reset="0.5"
                  :format="v => `${Math.round(v * 100)}%`"
                  :disabled="!overlay.enabled"
                  @update:model-value="v => updateOverlay(overlay.id, { opacity: v })"
                />
                <div class="flex gap-2 items-end">
                  <UiSelect
                    :model-value="overlay.blendMode"
                    :options="BLEND_MODES"
                    label="Blend"
                    class="flex-1 capitalize"
                    @update:model-value="v => updateOverlay(overlay.id, { blendMode: v })"
                  />
                  <UiSegmented
                    :model-value="overlay.fit"
                    :options="OVERLAY_FITS"
                    size="xs"
                    @update:model-value="v => updateOverlay(overlay.id, { fit: v })"
                  />
                </div>
              </div>
            </TransitionGroup>
          </UiSection>
        </div>
      </aside>
    </Transition>

    <!-- Drop overlay (the empty state is its own drop zone) -->
    <Transition name="t-fade">
      <div v-if="drop.over.value && items.length" class="p-4 pointer-events-none inset-0 absolute z-50">
        <div class="border-2 border-accent/60 rounded-[var(--radius-xl)] border-dashed bg-black/45 flex flex-col gap-2 h-full w-full animate-scale-in items-center justify-center backdrop-blur-sm">
          <span class="i-carbon-drop-photo text-[30px] text-accent-300" />
          <p class="text-[15px] text-white font-semibold">
            Drop to add slides
          </p>
          <p class="text-[12.5px] text-white/70">
            They join the end of the show
          </p>
        </div>
      </div>
    </Transition>

    <AddYoutubeModal v-model:open="ytOpen" @add="addYoutube" />
  </div>
</template>

<style scoped>
.vignette {
  background: radial-gradient(ellipse at center, transparent 60%, rgb(0 0 0 / 0.45) 100%);
}

.chrome {
  transform: translateX(-50%);
  transition:
    opacity var(--dur-slow) var(--ease-out),
    transform var(--dur-slow) var(--ease-out);
}
.chrome.is-hidden {
  opacity: 0;
  transform: translate(-50%, -8px);
  pointer-events: none;
}

/* ── Slide transitions ── */

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
</style>
