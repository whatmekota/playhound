<script setup lang="ts">
import type { FrameGrabber } from './cardFrames'
import type { CardSource } from './cardSource'
import type { CardAssets, Pic, Shot } from './drawCard'
import type { CardPicture, CardPrefs, CardSize, CardStyle, HeatPalette } from '~/lib/shareCard'
import { computed, onBeforeUnmount, ref, shallowReactive, shallowRef, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiModal from '~/components/ui/UiModal.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSelect from '~/components/ui/UiSelect.vue'
import UiSpinner from '~/components/ui/UiSpinner.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { toast } from '~/composables/useToast'
import { pickDirectory } from '~/lib/browserApi'
import { KEYS } from '~/lib/persist'
import { isAndroidApp, isTouchOnly } from '~/lib/platform'
import { getStrip } from '~/lib/previews'
import { CARD_PICTURES, CARD_SCALE, CARD_SIZES, CARD_STYLES, cardFileName, defaultMoments, heatScale, normaliseCardPrefs, PALETTES, speedRange } from '~/lib/shareCard'
import { useLibraryStore } from '~/stores/libraryStore'
import { useUiStore } from '~/stores/uiStore'
import { loadCardAssets } from './cardAssets'
import { copyPng, savePngAs, writePng } from './cardExport'
import { openGrabber } from './cardFrames'
import { loadCardSource } from './cardSource'
import CardTimeline from './CardTimeline.vue'
import { drawCard } from './drawCard'

/**
 * "Share card…": a picture of a script for its forum post. Pick a look and a
 * size, the moments of the video it shows, fix the title and the creator,
 * then copy it or save it. The preview is the export, drawn at the same size.
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

function readPrefs(): CardPrefs & { v: number } {
  try {
    return normaliseCardPrefs(JSON.parse(localStorage.getItem(KEYS.shareCard.key) ?? 'null'))
  }
  catch {
    return normaliseCardPrefs(null)
  }
}
const prefs = ref(readPrefs())
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
/** A folder to save next to the video, when the library can write there. */
const canSaveBeside = ref(false)
const busy = ref<'copy' | 'save' | 'saveAs' | 'share' | null>(null)

// ─── Frames ──────────────────────────────────────────────────────────────────

/**
 * Where the frames come from: a hidden video of our own ('ready'), only the
 * picture in the player ('player'), or nothing ('none').
 */
const frameState = ref<'idle' | 'opening' | 'ready' | 'player' | 'none'>('idle')
const grabber = shallowRef<FrameGrabber | null>(null)
/** The card's moments in seconds: the first is also the background. */
const moments = ref<number[]>([])
const activeMoment = ref(0)
/**
 * The full-size frame for each moment, by its place in `moments`, and the
 * time it is from: kept until a moved moment's new frame is in, so the card
 * never shows a gap while one loads.
 */
const pics = shallowReactive(new Map<number, { pic: Pic, sec: number }>())
/** The player's own picture, when that is all there is. */
const playerPic = shallowRef<Pic | null>(null)
/** Small frames for the timeline row, when the library has no previews. */
const thumbs = ref<[number, string][]>([])
const durationSec = computed(() => grabber.value?.duration || (source.value?.durationMs ?? 0) / 1000)

function dropFrames() {
  grabber.value?.dispose()
  grabber.value = null
  pics.clear()
  playerPic.value = null
  thumbs.value = []
  moments.value = []
  activeMoment.value = 0
  frameState.value = 'idle'
}

const preview = ref<HTMLCanvasElement | null>(null)
const card = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(10, 10) : null

let seq = 0
watch(() => ui.shareCard, async (target) => {
  const mine = ++seq
  source.value = null
  dropFrames()
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
    if (src)
      void openFrames(src, mine)
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
onBeforeUnmount(dropFrames)

async function openFrames(src: CardSource, mine: number) {
  frameState.value = 'opening'
  const media = await src.media().catch(() => null)
  const g = media ? await openGrabber(media) : null
  if (mine !== seq) {
    g?.dispose()
    return
  }
  if (g) {
    grabber.value = g
    moments.value = defaultMoments(g.duration, src.startSec)
    frameState.value = 'ready'
    void wantPics()
    void grabThumbs(g, src, mine)
    return
  }
  // No frames of our own: the picture in the player, if it shows this.
  playerPic.value = src.playerFrame ? await src.playerFrame().catch(() => null) : null
  if (mine !== seq)
    return
  moments.value = [src.startSec ?? 0]
  frameState.value = playerPic.value ? 'player' : 'none'
}

/** The timeline's row of frames, when the library has no scrub previews for it. */
async function grabThumbs(g: FrameGrabber, src: CardSource, mine: number) {
  if (src.preview && getStrip(src.preview))
    return
  const n = 12
  for (let i = 0; i < n; i++) {
    // The card's own frames go first.
    for (let wait = 0; missing() >= 0 && wait < 100; wait++)
      await new Promise(r => setTimeout(r, 150))
    if (mine !== seq)
      return
    const t = ((i + 0.5) / n) * g.duration
    const pic = await g.grab(t, 192)
    if (mine !== seq || !pic)
      return
    thumbs.value = [...thumbs.value, [t, (pic.img as HTMLCanvasElement).toDataURL('image/jpeg', 0.7)]]
  }
}

const strip = computed(() => (source.value?.preview ? getStrip(source.value.preview) : null))

/** The moments the card shows now. */
function needed(): number[] {
  const n = prefs.value.picture === 'four' ? 4 : 1
  return moments.value.slice(0, prefs.value.frame || prefs.value.picture !== 'none' ? n : 0)
}

/** The first moment whose frame is not in (or is from where it was before it moved); -1 for none. */
function missing() {
  return needed().findIndex((t, i) => pics.get(i)?.sec !== t)
}

let fetching = false
/** Grab every moment the card shows that is not in yet, and let go of the rest. */
async function wantPics() {
  const g = grabber.value
  if (!g || fetching)
    return
  fetching = true
  try {
    for (;;) {
      const n = needed().length
      for (const i of [...pics.keys()]) {
        if (i >= n)
          pics.delete(i)
      }
      const i = missing()
      if (i < 0 || grabber.value !== g)
        break
      const sec = moments.value[i]
      const pic = await g.grab(sec, 1600, 'card')
      if (!pic || grabber.value !== g)
        break
      pics.set(i, { pic, sec })
    }
  }
  finally {
    fetching = false
  }
}
watch(() => [prefs.value.picture, prefs.value.frame], () => void wantPics())

/** A live frame for the timeline's preview. */
async function peek(sec: number): Promise<string | null> {
  const pic = await grabber.value?.grab(sec, 352, 'peek')
  return pic ? (pic.img as HTMLCanvasElement).toDataURL('image/jpeg', 0.75) : null
}

/** A pin let go: its frame for the card. */
function onCommit() {
  void wantPics()
}

const background = computed<Pic | null>(() => {
  if (!prefs.value.frame)
    return null
  if (frameState.value === 'player')
    return playerPic.value
  return pics.get(0)?.pic ?? null
})

const shots = computed<Shot[]>(() => {
  if (prefs.value.picture === 'none')
    return []
  if (frameState.value === 'player')
    return playerPic.value ? [{ pic: playerPic.value, atMs: (moments.value[0] ?? 0) * 1000 }] : []
  const out: Shot[] = []
  needed().forEach((_, i) => {
    const p = pics.get(i)
    if (p)
      out.push({ pic: p.pic, atMs: p.sec * 1000 })
  })
  return out
})

const framesOk = computed(() => frameState.value === 'ready' || frameState.value === 'player')
const pictureOptions = computed(() => CARD_PICTURES
  .filter(p => p.id !== 'four' || frameState.value !== 'player')
  .map(p => ({ value: p.id as CardPicture, label: p.label })))
/** What the card asks for, put back when frames turn out not to be there. */
const picture = computed({
  get: () => (frameState.value === 'player' && prefs.value.picture === 'four' ? 'one' : prefs.value.picture),
  set: (v: CardPicture) => (prefs.value.picture = v),
})
const timelineHint = computed(() => {
  if (frameState.value === 'opening')
    return 'Opening the video…'
  if (frameState.value === 'player')
    return 'Picking moments is not available for this video: the card uses the picture in the player.'
  if (frameState.value === 'none')
    return 'Pictures are not available for this video.'
  const verb = isTouchOnly ? 'Tap' : 'Click'
  if (prefs.value.picture === 'four')
    return `${verb} or drag to place each picture. Picture 1 is also the background.`
  return `${verb} or drag to pick the moment the card shows.`
})

// ─── Drawing ─────────────────────────────────────────────────────────────────

const hasChapters = computed(() => (source.value?.chapters.length ?? 0) > 1)
/** Shown off when there are none, without forgetting the choice for scripts that have them. */
const showChapters = computed({
  get: () => hasChapters.value && prefs.value.chapters,
  set: (v) => {
    prefs.value.chapters = v
  },
})
const size = computed(() => CARD_SIZES[prefs.value.size])
const mainActions = computed(() => source.value?.axes[0]?.actions ?? [])
const scale = computed(() => heatScale(prefs.value.palette, prefs.value.fit ? speedRange(mainActions.value) : null))

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
  }, { ...assets.value, frame: background.value, shots: shots.value }, { ...prefs.value, picture: picture.value })
  const c = preview.value
  if (!c)
    return
  c.width = card.width
  c.height = card.height
  c.getContext('2d')?.drawImage(card, 0, 0)
}

let raf = 0
watch([source, assets, title, creator, prefs, background, shots, picture, preview], () => {
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

/** The Android app: the share sheet, which posts, sends or saves it wherever the user likes. */
async function share() {
  busy.value = 'share'
  try {
    const { shareFile } = await import('~/lib/android/app')
    await shareFile(await png(), fileName.value, 'Share card')
  }
  catch (err) {
    toast.error('Could not share the card', { detail: (err as Error)?.message })
  }
  finally {
    busy.value = null
  }
}

/**
 * The Android app: into the video's folder when the library can write
 * there, else a folder picked now (Android has no save dialog).
 */
async function saveToFolder() {
  if (canSaveBeside.value)
    return saveBeside()
  busy.value = 'save'
  try {
    const dir = await pickDirectory()
    if (!dir)
      return
    if (await (dir as any).queryPermission({ mode: 'readwrite' }) !== 'granted') {
      toast.error('Android gave read-only access to that folder')
      return
    }
    await writePng(dir, fileName.value, await png())
    toast.success('Card saved', { detail: `${fileName.value} · in ${dir.name}`, icon: 'i-carbon-image' })
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

      <div v-if="source" class="flex flex-col gap-1.5">
        <div class="flex gap-3 items-end justify-between">
          <span class="label">Pictures</span>
          <UiSegmented v-model="picture" :options="pictureOptions" size="xs" :class="{ 'opacity-45 pointer-events-none': !framesOk }" />
        </div>
        <CardTimeline
          v-if="frameState === 'ready' && durationSec > 0"
          v-model:moments="moments"
          v-model:active="activeMoment"
          :duration-sec="durationSec"
          :actions="mainActions"
          :scale="scale"
          :count="picture === 'four' ? 4 : 1"
          :strip="strip"
          :thumbs="thumbs"
          :peek="peek"
          @commit="onCommit"
        />
        <span class="hint flex gap-1.5 items-center">
          <UiSpinner v-if="frameState === 'opening'" :size="12" />{{ timelineHint }}
        </span>
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
          v-model="prefs.fit"
          size="sm"
          label="Fit colours to this script"
          hint="Stretch the colours over its own speeds, so even an all-fast script shows its shape"
        />
        <UiSwitch
          v-model="showChapters"
          size="sm"
          :disabled="!hasChapters"
          label="Chapters"
          :hint="hasChapters ? 'The names the script gives its parts' : 'This script names no chapters'"
        />
        <UiSwitch
          v-model="prefs.frame"
          size="sm"
          :disabled="!framesOk"
          label="Video frame behind it"
          :hint="framesOk ? 'A still from the video, faded back. Remembered for the next card.' : 'Not available for this video'"
        />
      </div>
    </div>

    <template #footer>
      <span class="hint num mr-auto">{{ size.w * CARD_SCALE }} × {{ size.h * CARD_SCALE }} PNG</span>
      <template v-if="isAndroidApp">
        <UiButton :disabled="!source" icon="i-carbon-folder" :loading="busy === 'save'" @click="saveToFolder">
          {{ canSaveBeside ? 'Save next to the video' : 'Save to folder' }}
        </UiButton>
        <UiButton variant="primary" icon="i-carbon-share" :disabled="!source" :loading="busy === 'share'" @click="share">
          Share…
        </UiButton>
      </template>
      <template v-else>
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
