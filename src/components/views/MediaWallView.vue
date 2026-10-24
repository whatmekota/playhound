<script setup lang="ts">
import { useMediaWallStore } from '~/stores/mediaWall'

const { items, addItem, removeItem, updateItem, bringToFront, clearAll } = useMediaWallStore()
const wallEl = ref<HTMLDivElement>()
const showYtModal = ref(false)
const isDragOver = ref(false)
const fileInput = ref<HTMLInputElement>()

function openFilePicker() {
  fileInput.value?.click()
}

function onFileInput(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files)
    return
  addFiles(Array.from(files))
  ;(e.target as HTMLInputElement).value = ''
}

function addFiles(files: File[], dropX = 80, dropY = 80) {
  files.forEach((file, i) => {
    const isImage = file.type.startsWith('image/')
    const isVideo = file.type.startsWith('video/')
    if (!isImage && !isVideo)
      return
    const src = URL.createObjectURL(file)
    const offset = i * 24
    addItem({
      type: isImage ? 'image' : 'video',
      src,
      label: file.name,
      x: dropX + offset,
      y: dropY + offset,
      width: 320,
      height: isImage ? 240 : 180,
      opacity: 1,
      playbackRate: 1,
      muted: true,
    })
  })
}

function onDrop(e: DragEvent) {
  isDragOver.value = false
  if (!e.dataTransfer || !wallEl.value)
    return
  const rect = wallEl.value.getBoundingClientRect()
  const x = Math.max(20, e.clientX - rect.left - 160)
  const y = Math.max(20, e.clientY - rect.top - 120)
  addFiles(Array.from(e.dataTransfer.files), x, y)
}

function addYoutube({ youtubeId, label }: { youtubeId: string, label: string }) {
  const offset = items.value.length * 20
  addItem({
    type: 'youtube',
    src: youtubeId,
    label,
    x: 80 + (offset % 320),
    y: 80 + (offset % 200),
    width: 426,
    height: 240,
    opacity: 1,
    playbackRate: 1,
    muted: true,
  })
}
</script>

<template>
  <div
    class="bg-surface-950 h-full w-full relative overflow-hidden"
    @dragover.prevent="isDragOver = true"
    @dragleave.self="isDragOver = false"
    @drop.prevent="onDrop"
  >
    <!-- Drop zone overlay -->
    <Transition name="fade">
      <div
        v-if="isDragOver"
        class="border-4 border-teal-400/60 border-dashed bg-teal-400/5 flex pointer-events-none items-center inset-0 justify-center absolute z-40"
      >
        <p class="text-xl text-teal-400 font-medium">
          Drop images or videos here
        </p>
      </div>
    </Transition>

    <!-- Empty state -->
    <Transition name="fade">
      <div
        v-if="items.length === 0"
        class="flex flex-col gap-3 pointer-events-none items-center inset-0 justify-center absolute"
      >
        <div class="i-carbon-image text-6xl text-fg-faint" />
        <p class="text-sm text-fg-faint">
          Drop images / videos here, or use the toolbar below
        </p>
      </div>
    </Transition>

    <!-- Wall canvas -->
    <div
      ref="wallEl"
      class="inset-0 absolute"
    >
      <MediaWallItem
        v-for="item in items"
        :key="item.id"
        :item="item"
        @update="updateItem"
        @remove="removeItem"
        @bring-to-front="bringToFront"
      />
    </div>

    <!-- Toolbar -->
    <div class="px-4 py-2 border border-edge/60 rounded-full bg-surface-900/90 flex gap-2 shadow-xl items-center bottom-4 left-1/2 absolute z-30 backdrop-blur -translate-x-1/2">
      <button
        class="text-xs text-fg font-medium px-3 py-1.5 rounded-full bg-surface-800 flex gap-1.5 transition-colors items-center hover:bg-surface-700"
        @click="openFilePicker"
      >
        <div class="i-carbon-upload text-sm" />
        Add Files
      </button>
      <button
        class="text-xs text-fg font-medium px-3 py-1.5 rounded-full bg-surface-800 flex gap-1.5 transition-colors items-center hover:bg-surface-700"
        @click="showYtModal = true"
      >
        <div class="i-carbon-logo-youtube text-sm text-red-400" />
        YouTube
      </button>
      <div class="bg-surface-700 h-4 w-px" />
      <button
        class="text-xs text-fg-muted font-medium px-3 py-1.5 rounded-full bg-surface-800 flex gap-1.5 transition-colors items-center hover:text-red-400 hover:bg-red-900/50 disabled:opacity-30"
        :disabled="items.length === 0"
        @click="clearAll()"
      >
        <div class="i-carbon-trash-can text-sm" />
        Clear
      </button>
    </div>

    <input
      ref="fileInput"
      type="file"
      accept="image/*,video/*"
      multiple
      class="hidden"
      @change="onFileInput"
    >

    <AddYoutubeModal
      :open="showYtModal"
      @close="showYtModal = false"
      @add="addYoutube"
    />
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
