<script setup lang="ts">
import type { VideoEntry } from '~/stores/libraryStore'
import { useLocalStorage } from '@vueuse/core'
import { computed } from 'vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { thumbDb } from '~/lib/idb'
import { usePlaybackStore } from '~/stores/playbackStore'
import { useQueueStore } from '~/stores/queueStore'

const queue = useQueueStore()
const director = useAutoDirector()
const playback = usePlaybackStore()

const open = useLocalStorage('ph-upnext-open', true)

/**
 * What plays next.
 *
 * The director chooses by script shape rather than queue order, so when it is
 * on it decides the first item and the queue supplies the rest as context.
 */
const items = computed<{ entry: VideoEntry, fromDirector: boolean }[]>(() => {
  const upcoming = queue.peekUpcoming(5)
  if (!director.enabled.value)
    return upcoming.map(entry => ({ entry, fromDirector: false }))

  const pick = director.pickNext()
  if (!pick)
    return upcoming.map(entry => ({ entry, fromDirector: false }))

  return [
    { entry: pick, fromDirector: true },
    ...upcoming.filter(e => e.name !== pick.name).slice(0, 4).map(entry => ({ entry, fromDirector: false })),
  ]
})

/** Thumbnails are cached by the library; pull them in lazily for the strip. */
async function thumb(entry: VideoEntry) {
  if (entry.thumbnailUrl)
    return
  try {
    const cached = await thumbDb.get(entry.name)
    if (cached)
      entry.thumbnailUrl = cached
  }
  catch {
    // no thumbnail yet — the placeholder is fine
  }
}

function play(entry: VideoEntry, fromDirector: boolean) {
  if (fromDirector)
    void playback.play(entry)
  else
    void playback.jumpTo(entry)
}
</script>

<template>
  <div v-if="items.length" class="border-t border-edge bg-surface-900 shrink-0">
    <button
      class="px-4 py-1 text-left flex gap-2 w-full transition-colors items-center hover:bg-fg/5"
      :aria-expanded="open"
      @click="open = !open"
    >
      <div
        class="i-carbon-chevron-right text-[10px] text-fg-faint transition-transform"
        :class="open ? 'rotate-90' : ''"
      />
      <span class="label">Up next</span>
      <span v-if="!open" class="text-[11px] text-fg-faint truncate">
        {{ items[0].entry.basename }}
      </span>
      <span v-if="director.enabled.value" class="text-[10px] text-teal-400 ml-auto shrink-0">
        directed
      </span>
    </button>

    <div v-if="open" class="px-4 pb-2 flex gap-2 overflow-x-auto">
      <button
        v-for="(it, i) in items"
        :key="it.entry.name"
        class="group text-left border rounded-lg shrink-0 w-32 transition-colors overflow-hidden"
        :class="i === 0
          ? 'border-accent-500/40 bg-accent-500/5 hover:bg-accent-500/10'
          : 'border-edge bg-surface-800 hover:bg-surface-700'"
        :title="it.entry.basename"
        @mouseenter="thumb(it.entry)"
        @click="play(it.entry, it.fromDirector)"
      >
        <div class="bg-surface-950 aspect-video relative overflow-hidden">
          <img
            v-if="it.entry.thumbnailUrl"
            :src="it.entry.thumbnailUrl"
            class="h-full w-full object-cover"
            alt=""
          >
          <div v-else class="grid h-full w-full place-items-center">
            <div class="i-carbon-video text-fg-faint" />
          </div>

          <span
            v-if="it.fromDirector"
            class="text-[9px] text-white font-medium px-1 py-0.5 rounded bg-teal-500/80 left-1 top-1 absolute"
          >match</span>
          <span
            v-if="it.entry.scriptCount > 1"
            class="text-[9px] text-white font-mono px-1 rounded bg-black/60 bottom-1 right-1 absolute"
          >{{ it.entry.scriptCount }}&#10022;</span>
        </div>

        <p class="text-[10px] text-fg-muted px-1.5 py-1 truncate group-hover:text-fg">
          {{ it.entry.basename }}
        </p>
      </button>
    </div>
  </div>
</template>
