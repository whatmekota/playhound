<script setup lang="ts">
import type { ResolvedStream } from '~/lib/streamHosts'
import { computed, nextTick, ref, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiModal from '~/components/ui/UiModal.vue'
import { installYtdlp, playSource, resolveStream, StreamError, ytdlp } from '~/composables/useStreams'
import { toast } from '~/composables/useToast'
import { detectStreamHost } from '~/lib/streamHosts'
import { useUiStore } from '~/stores/uiStore'

/**
 * "Play a link…": paste a link from a post, a chat or a bookmark and play it.
 * The same resolving as the EroScripts view, through the local proxy.
 */
const ui = useUiStore()

const url = ref('')
const input = ref<InstanceType<typeof UiInput> | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
const needsYtdlp = ref(false)
const result = ref<ResolvedStream | null>(null)
const item = ref(0)
const source = ref(0)

const host = computed(() => detectStreamHost(url.value.trim()))
const current = computed(() => result.value?.items[item.value] ?? null)

watch(() => ui.playLinkOpen, (open) => {
  if (open) {
    url.value = ''
    result.value = null
    error.value = null
    needsYtdlp.value = false
    void nextTick(() => input.value?.focus())
  }
})
watch(url, () => {
  result.value = null
  error.value = null
  needsYtdlp.value = false
})

async function resolve() {
  const link = url.value.trim()
  if (!link || busy.value)
    return
  busy.value = true
  error.value = null
  needsYtdlp.value = false
  try {
    result.value = await resolveStream(link)
    item.value = 0
    source.value = 0
    // One video, one quality: nothing to choose, so just play it.
    if (result.value.items.length === 1 && result.value.items[0].sources.length === 1)
      await play()
  }
  catch (e: any) {
    error.value = e?.message ?? 'Could not resolve that link'
    needsYtdlp.value = e instanceof StreamError && e.code === 'needs-ytdlp'
  }
  finally {
    busy.value = false
  }
}

async function getYtdlp() {
  try {
    await installYtdlp()
    toast.success('yt-dlp is ready', { detail: ytdlp.value?.version ?? undefined, icon: 'i-carbon-checkmark' })
    await resolve()
  }
  catch (e: any) {
    toast.error('Could not get yt-dlp', { detail: e?.message })
  }
}

async function play() {
  const it = current.value
  const src = it?.sources[source.value]
  if (!it || !src)
    return
  await playSource(it.title.replace(/\.[a-z0-9]{2,4}$/i, ''), src)
  ui.playLinkOpen = false
  ui.openView('player')
}

const fmtSize = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${(b / (1 << 20)).toFixed(0)} MB`)
</script>

<template>
  <UiModal
    v-model:open="ui.playLinkOpen"
    title="Play a link"
    icon="i-carbon-link"
    width="460px"
    subtitle="Pixeldrain, Gofile, MEGA, Iwara, Rule34Video, PMVHaven, and many more through yt-dlp"
  >
    <div class="flex flex-col gap-3">
      <UiInput ref="input" v-model="url" size="md" placeholder="https://…" clearable @enter="result ? play() : resolve()" />
      <p v-if="host && !result && !error" class="hint">
        {{ host.label }}{{ host.ytdlp ? ' · through yt-dlp' : '' }}
      </p>
      <p v-if="error" class="text-[12px]" :class="needsYtdlp ? 'text-fg-muted' : 'text-danger'">
        {{ needsYtdlp ? 'This site streams through yt-dlp, a free open-source downloader. playhound can fetch the official release (about 20 MB) and keep it up to date.' : error }}
      </p>

      <template v-if="result">
        <div v-if="result.items.length > 1" class="flex flex-col gap-0.5 max-h-56 overflow-y-auto">
          <button
            v-for="(it, i) in result.items"
            :key="i"
            type="button"
            class="text-[12px] px-2 text-left focusable rounded-[var(--radius-sm)] flex gap-2 h-7 transition-colors items-center"
            :class="item === i ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-fg/5 hover:text-fg'"
            @click="item = i; source = 0"
          >
            <span class="i-carbon-video shrink-0" />
            <span v-tip="it.title" class="flex-1 truncate">{{ it.title }}</span>
            <span v-if="it.size" class="num shrink-0">{{ fmtSize(it.size) }}</span>
          </button>
        </div>
        <p v-else class="text-[12.5px] text-fg font-medium truncate">
          {{ current?.title }}
        </p>
        <div v-if="(current?.sources.length ?? 0) > 1" class="flex flex-wrap gap-1">
          <button
            v-for="(src, i) in current!.sources"
            :key="i"
            type="button"
            class="text-[11px] font-mono px-1.5 focusable rounded-[var(--radius-xs)] h-5 transition-colors"
            :class="source === i ? 'bg-accent-soft text-fg' : 'bg-fg/6 text-fg-muted hover:text-fg hover:bg-fg/10'"
            @click="source = i"
          >
            {{ src.label }}
          </button>
        </div>
      </template>
    </div>

    <template #footer>
      <UiButton variant="ghost" @click="ui.playLinkOpen = false">
        Cancel
      </UiButton>
      <UiButton v-if="needsYtdlp" variant="primary" icon="i-carbon-download" :loading="!!ytdlp?.installing" @click="getYtdlp">
        Get yt-dlp
      </UiButton>
      <UiButton v-else-if="result" variant="primary" icon="i-carbon-play-filled-alt" @click="play">
        Play
      </UiButton>
      <UiButton v-else variant="primary" icon="i-carbon-flash" :loading="busy" :disabled="!url.trim()" @click="resolve">
        Open
      </UiButton>
    </template>
  </UiModal>
</template>
