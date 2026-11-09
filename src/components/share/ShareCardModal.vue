<script setup lang="ts">
import type { CardSource } from './cardSource'
import type { CardAssets, Pic } from './drawCard'
import type { CardPrefs, CardSize, CardStyle, HeatPalette } from '~/lib/shareCard'
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiModal from '~/components/ui/UiModal.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSelect from '~/components/ui/UiSelect.vue'
import UiSpinner from '~/components/ui/UiSpinner.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { toast } from '~/composables/useToast'
import { KEYS } from '~/lib/persist'
import { CARD_SCALE, CARD_SIZES, CARD_STYLES, cardFileName, normaliseCardPrefs, PALETTES } from '~/lib/shareCard'
import { useLibraryStore } from '~/stores/libraryStore'
import { useUiStore } from '~/stores/uiStore'
import { loadCardAssets } from './cardAssets'
import { copyPng, savePngAs, writePng } from './cardExport'
import { loadCardSource } from './cardSource'
import { drawCard } from './drawCard'

/**
 * "Share card…": a picture of a script for its forum post. Pick a look and a
 * size, fix the title and the creator, then copy it or save it. The preview
 * is the export, drawn at the same size.
 */
const ui = useUiStore()
const library = useLibraryStore()

const open = computed({
  get: () => !!ui.shareCard,
  set: (v) => {
    if (!v)
      ui.shareCard = null
  },
})

function readPrefs(): CardPrefs {
  try {
    return normaliseCardPrefs(JSON.parse(localStorage.getItem(KEYS.shareCard.key) ?? 'null'))
  }
  catch {
    return normaliseCardPrefs(null)
  }
}
const prefs = ref<CardPrefs>(readPrefs())
watch(prefs, (p) => {
  try {
    localStorage.setItem(KEYS.shareCard.key, JSON.stringify(p))
  }
  catch {}
}, { deep: true })

const source = shallowRef<CardSource | null>(null)
const assets = shallowRef<CardAssets | null>(null)
const loading = ref(false)
const failed = ref(false)
const title = ref('')
const creator = ref('')
/** The video frame behind the card: off for every new card, the user's call each time. */
const withFrame = ref(false)
const frame = shallowRef<Pic | null>(null)
const frameBusy = ref(false)
/** A folder to save next to the video, when the library can write there. */
const canSaveBeside = ref(false)
const busy = ref<'copy' | 'save' | 'saveAs' | null>(null)

const preview = ref<HTMLCanvasElement | null>(null)
const card = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(10, 10) : null

let seq = 0
watch(() => ui.shareCard, async (target) => {
  const mine = ++seq
  source.value = null
  frame.value = null
  withFrame.value = false
  failed.value = false
  canSaveBeside.value = false
  if (!target)
    return
  loading.value = true
  try {
    const [src, a] = await Promise.all([loadCardSource(target), loadCardAssets()])
    if (mine !== seq)
      return
    assets.value = a
    source.value = src
    failed.value = !src
    title.value = src?.title ?? ''
    creator.value = src?.creator ?? ''
    if (src?.video)
      canSaveBeside.value = !!await library.writableDirOf(src.video, false)
  }
  catch (err) {
    console.warn('Share card', err)
    failed.value = true
  }
  finally {
    if (mine === seq)
      loading.value = false
  }
}, { immediate: true })

watch(withFrame, async (on) => {
  if (!on || frame.value || !source.value)
    return
  frameBusy.value = true
  try {
    frame.value = await source.value.frame()
  }
  finally {
    frameBusy.value = false
  }
  if (!frame.value) {
    withFrame.value = false
    toast.error('Could not get a frame from this video')
  }
})

const hasChapters = computed(() => (source.value?.chapters.length ?? 0) > 1)
/** Shown off when there are none, without forgetting the choice for scripts that have them. */
const showChapters = computed({
  get: () => hasChapters.value && prefs.value.chapters,
  set: (v) => {
    prefs.value.chapters = v
  },
})
const size = computed(() => CARD_SIZES[prefs.value.size])

function render() {
  const src = source.value
  if (!card || !src || !assets.value)
    return
  drawCard(card, {
    title: title.value.trim() || src.title || 'Untitled',
    creator: creator.value,
    durationMs: src.durationMs,
    axes: src.axes,
    chapters: src.chapters,
  }, { ...assets.value, frame: withFrame.value ? frame.value : null }, prefs.value)
  const c = preview.value
  if (!c)
    return
  c.width = card.width
  c.height = card.height
  c.getContext('2d')?.drawImage(card, 0, 0)
}

let raf = 0
watch([source, assets, title, creator, prefs, withFrame, frame, preview], () => {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(render)
}, { deep: true })
onBeforeUnmount(() => cancelAnimationFrame(raf))

async function png(): Promise<Blob> {
  render()
  if (!card)
    throw new Error('No canvas')
  return card.convertToBlob({ type: 'image/png' })
}

const fileName = computed(() => cardFileName(source.value?.videoName || title.value))

async function copy() {
  busy.value = 'copy'
  try {
    await copyPng(png())
    toast.success('Card copied', { detail: 'Paste it into your post', icon: 'i-carbon-copy' })
  }
  catch {
    toast.error('Could not copy the image', { detail: 'Save it instead' })
  }
  finally {
    busy.value = null
  }
}

async function saveBeside() {
  const video = source.value?.video
  if (!video)
    return
  busy.value = 'save'
  try {
    const dir = await library.writableDirOf(video, true)
    if (!dir) {
      toast.error('No permission to save in that folder')
      return
    }
    await writePng(dir, fileName.value, await png())
    toast.success('Card saved next to the video', { detail: fileName.value, icon: 'i-carbon-image' })
  }
  catch {
    toast.error('Could not save the card')
  }
  finally {
    busy.value = null
  }
}

async function saveAs() {
  busy.value = 'saveAs'
  try {
    const video = source.value?.video
    const dir = video ? await library.writableDirOf(video, false) : null
    const saved = await savePngAs(await png(), fileName.value, dir)
    if (saved && saved !== 'download')
      toast.success('Card saved', { detail: saved, icon: 'i-carbon-image' })
  }
  catch {
    toast.error('Could not save the card')
  }
  finally {
    busy.value = null
  }
}

const styleOptions = CARD_STYLES.map(s => ({ value: s.id as CardStyle, label: s.label }))
const sizeOptions = (Object.keys(CARD_SIZES) as CardSize[]).map(id => ({ value: id, label: CARD_SIZES[id].label }))
const paletteOptions = PALETTES.map(p => ({ value: p.id as HeatPalette, label: p.label }))
const styleNote = computed(() => CARD_STYLES.find(s => s.id === prefs.value.style)?.note ?? '')
</script>

<template>
  <UiModal
    v-model:open="open"
    title="Share card"
    subtitle="A picture of the script to post with it"
    icon="i-carbon-image"
    width="880px"
  >
    <div class="flex flex-col gap-4">
      <div class="share-stage rounded-[var(--radius-lg)] center min-h-[200px] relative overflow-hidden">
        <canvas
          v-show="source"
          ref="preview"
          class="share-preview"
          :style="{ aspectRatio: `${size.w} / ${size.h}` }"
          role="img"
          :aria-label="`${title} share card`"
        />
        <div v-if="loading" class="text-fg-muted flex gap-2 items-center">
          <UiSpinner /> <span class="text-[12.5px]">Reading the script…</span>
        </div>
        <p v-else-if="failed" class="text-[12.5px] text-fg-muted">
          There is no script to make a card from.
        </p>
      </div>

      <div class="gap-x-6 gap-y-3 grid grid-cols-1 md:grid-cols-2">
        <div class="flex flex-col gap-3 min-w-0">
          <div class="flex flex-col gap-1.5">
            <span class="label">Look</span>
            <UiSegmented v-model="prefs.style" :options="styleOptions" block />
            <span class="hint">{{ styleNote }}</span>
          </div>
          <div class="flex gap-3 items-end">
            <div class="flex flex-1 flex-col gap-1.5">
              <span class="label">Size</span>
              <UiSegmented v-model="prefs.size" :options="sizeOptions" block />
            </div>
            <UiSelect v-model="prefs.palette" label="Heatmap colours" :options="paletteOptions" />
          </div>
        </div>
        <div class="flex flex-col gap-3 min-w-0">
          <label class="flex flex-col gap-1.5">
            <span class="label">Title</span>
            <UiInput v-model="title" :placeholder="source?.title || 'Title'" />
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="label">Creator</span>
            <UiInput v-model="creator" placeholder="Your name, or leave it out" />
          </label>
        </div>
        <UiSwitch
          v-model="showChapters"
          size="sm"
          :disabled="!hasChapters"
          label="Chapters"
          :hint="hasChapters ? 'The names the script gives its parts' : 'This script names no chapters'"
        />
        <UiSwitch
          v-model="withFrame"
          size="sm"
          :disabled="!source || frameBusy"
          label="Video frame behind it"
          hint="A still from the video, faded back. Off for every new card."
        />
      </div>
    </div>

    <template #footer>
      <span class="hint num mr-auto">{{ size.w * CARD_SCALE }} × {{ size.h * CARD_SCALE }} PNG</span>
      <UiButton variant="ghost" :disabled="!source" :loading="busy === 'saveAs'" @click="saveAs">
        Save as…
      </UiButton>
      <UiButton v-if="canSaveBeside" :disabled="!source" icon="i-carbon-save" :loading="busy === 'save'" @click="saveBeside">
        Save next to the video
      </UiButton>
      <UiButton variant="primary" icon="i-carbon-copy" :disabled="!source" :loading="busy === 'copy'" @click="copy">
        Copy image
      </UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
/* A checkerboard, faint, so the card's rounded corners read as cut out. */
.share-stage {
  padding: 18px;
  background-color: var(--bg-900);
  background-image:
    linear-gradient(45deg, var(--bg-800) 25%, transparent 25%, transparent 75%, var(--bg-800) 75%),
    linear-gradient(45deg, var(--bg-800) 25%, transparent 25%, transparent 75%, var(--bg-800) 75%);
  background-size: 16px 16px;
  background-position:
    0 0,
    8px 8px;
}
.share-preview {
  display: block;
  max-width: 100%;
  max-height: min(42vh, 400px);
  width: auto;
  height: auto;
  filter: drop-shadow(0 10px 24px hsl(var(--shadow-color) / 0.35));
}
</style>
