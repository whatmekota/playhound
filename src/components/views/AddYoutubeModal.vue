<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiModal from '~/components/ui/UiModal.vue'

const emit = defineEmits<{
  add: [{ youtubeId: string, label: string }]
}>()

const open = defineModel<boolean>('open', { default: false })

const url = ref('')
const label = ref('')
const urlInput = ref<InstanceType<typeof UiInput> | null>(null)

const ID_PATTERNS = [
  /^([\w-]{11})$/,
  /[?&]v=([\w-]{11})/,
  /youtu\.be\/([\w-]{11})/,
  /youtube\.com\/(?:embed|shorts|live)\/([\w-]{11})/,
]

function extractId(input: string): string | null {
  const s = input.trim()
  for (const p of ID_PATTERNS) {
    const m = s.match(p)
    if (m)
      return m[1]
  }
  return null
}

const videoId = computed(() => extractId(url.value))
/** Only complain once there is something to complain about. */
const invalid = computed(() => url.value.trim().length > 0 && !videoId.value)

// The thumbnail doubles as a check that the id points at a real video:
// YouTube serves a 120px grey placeholder for ids it does not know.
const thumbState = ref<'loading' | 'ok' | 'missing'>('loading')
watch(videoId, () => (thumbState.value = 'loading'))

function onThumbLoad(e: Event) {
  thumbState.value = (e.target as HTMLImageElement).naturalWidth <= 120 ? 'missing' : 'ok'
}

watch(open, (v) => {
  if (v) {
    url.value = ''
    label.value = ''
    nextTick(() => urlInput.value?.focus())
  }
})

function submit() {
  const id = videoId.value
  if (!id)
    return
  emit('add', { youtubeId: id, label: label.value.trim() || `YouTube · ${id}` })
  open.value = false
}
</script>

<template>
  <UiModal
    v-model:open="open"
    title="Add a YouTube video"
    subtitle="Plays muted and looped, without YouTube's controls."
    icon="i-carbon-logo-youtube"
    width="460px"
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <UiInput
          ref="urlInput"
          v-model="url"
          label="Link or video ID"
          icon="i-carbon-link"
          placeholder="https://www.youtube.com/watch?v=…"
          size="md"
          mono
          clearable
          @enter="submit"
        />
        <Transition name="t-fade" mode="out-in">
          <p v-if="invalid" key="err" class="text-[11.5px] text-danger flex gap-1.5 items-center">
            <span class="i-carbon-warning-alt text-[13px]" />
            That doesn't look like a YouTube link — try a watch, youtu.be or shorts URL.
          </p>
          <p v-else-if="videoId" key="ok" class="text-[11.5px] text-fg-faint flex gap-1.5 items-center">
            <span class="i-carbon-checkmark text-[13px] text-ok" />
            Video <span class="text-fg-muted num">{{ videoId }}</span>
          </p>
          <p v-else key="hint" class="hint">
            Paste any watch, youtu.be, shorts or embed link.
          </p>
        </Transition>
      </div>

      <!-- Preview -->
      <div class="rounded-[var(--radius-md)] bg-surface-950 aspect-video ring-1 ring-edge relative overflow-hidden">
        <Transition name="t-fade">
          <img
            v-if="videoId"
            :key="videoId"
            :src="`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`"
            alt=""
            class="h-full w-full inset-0 absolute object-cover"
            :class="thumbState === 'ok' ? 'opacity-100' : 'opacity-0'"
            style="transition: opacity var(--dur) var(--ease-out)"
            @load="onThumbLoad"
            @error="thumbState = 'missing'"
          >
        </Transition>
        <div v-if="videoId && thumbState === 'loading'" class="skeleton inset-0 absolute" />
        <div
          v-if="!videoId || thumbState === 'missing'"
          class="text-fg-faint flex flex-col gap-2 items-center inset-0 justify-center absolute"
        >
          <span class="text-[28px]" :class="videoId ? 'i-carbon-image-search' : 'i-carbon-logo-youtube'" />
          <span class="text-[12px]">{{ videoId ? 'No preview for this ID — it may be private or removed' : 'Preview appears here' }}</span>
        </div>
        <div v-if="videoId && thumbState === 'ok'" class="center inset-0 absolute">
          <span class="rounded-full bg-black/55 center h-12 w-12 backdrop-blur-sm">
            <span class="i-carbon-play-filled-alt text-[20px] text-white" />
          </span>
        </div>
      </div>

      <UiInput
        v-model="label"
        label="Label (optional)"
        icon="i-carbon-text-align-center"
        placeholder="Rain on a window, fireplace…"
        size="md"
        @enter="submit"
      />
    </div>

    <template #footer>
      <UiButton variant="ghost" @click="open = false">
        Cancel
      </UiButton>
      <UiButton variant="primary" icon="i-carbon-add" :disabled="!videoId" @click="submit">
        Add video
      </UiButton>
    </template>
  </UiModal>
</template>
