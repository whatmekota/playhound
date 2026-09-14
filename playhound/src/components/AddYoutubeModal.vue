<script setup lang="ts">
defineProps<{ open: boolean }>()

const emit = defineEmits<{
  close: []
  add: [{ youtubeId: string, label: string }]
}>()

const url = ref('')
const label = ref('')
const error = ref('')

function extractId(input: string): string | null {
  const s = input.trim()
  const patterns = [
    /^([\w-]{11})$/,
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
  ]
  for (const p of patterns) {
    const m = s.match(p)
    if (m)
      return m[1]
  }
  return null
}

function submit() {
  error.value = ''
  const id = extractId(url.value)
  if (!id) {
    error.value = 'Could not find a valid YouTube video ID in that URL.'
    return
  }
  emit('add', { youtubeId: id, label: label.value.trim() || `Video ${id.slice(0, 6)}` })
  url.value = ''
  label.value = ''
  emit('close')
}

function close() {
  url.value = ''
  label.value = ''
  error.value = ''
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="open"
        class="bg-black/70 flex items-center inset-0 justify-center fixed z-50 backdrop-blur-sm"
        @click.self="close"
      >
        <div class="mx-4 p-6 border border-zinc-700 rounded-2xl bg-zinc-900 max-w-md w-full shadow-2xl">
          <h3 class="text-base text-zinc-100 font-semibold mb-4">
            Add YouTube Video
          </h3>
          <div class="space-y-3">
            <div>
              <label class="text-xs text-zinc-400 mb-1 block">URL or Video ID</label>
              <input
                v-model="url"
                type="text"
                placeholder="https://www.youtube.com/watch?v=..."
                class="text-sm text-zinc-100 px-3 py-2 border border-zinc-700 rounded-lg bg-zinc-800 w-full transition-colors focus:outline-none focus:border-teal-500 placeholder-zinc-500"
                autofocus
                @keydown.enter="submit"
                @keydown.esc="close"
              >
            </div>
            <div>
              <label class="text-xs text-zinc-400 mb-1 block">Label (optional)</label>
              <input
                v-model="label"
                type="text"
                placeholder="Rain sounds, Fireplace..."
                class="text-sm text-zinc-100 px-3 py-2 border border-zinc-700 rounded-lg bg-zinc-800 w-full transition-colors focus:outline-none focus:border-teal-500 placeholder-zinc-500"
                @keydown.enter="submit"
                @keydown.esc="close"
              >
            </div>
            <p v-if="error" class="text-xs text-red-400">
              {{ error }}
            </p>
          </div>
          <div class="mt-5 flex gap-2">
            <button
              class="text-sm text-white font-medium py-2 rounded-lg bg-teal-600 flex-1 transition-colors hover:bg-teal-500"
              @click="submit"
            >
              Add Video
            </button>
            <button
              class="text-sm text-zinc-300 px-4 py-2 rounded-lg bg-zinc-800 transition-colors hover:bg-zinc-700"
              @click="close"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
