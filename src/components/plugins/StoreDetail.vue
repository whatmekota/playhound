<script setup lang="ts">
import type { StoreEntry } from '~/plugins/storeEntry'
import { computed, ref, watch } from 'vue'
import PluginIcon from '~/components/plugins/PluginIcon.vue'
import PluginPermissions from '~/components/plugins/PluginPermissions.vue'
import StoreMarkdown from '~/components/plugins/StoreMarkdown.vue'
import StoreScreenshots from '~/components/plugins/StoreScreenshots.vue'
import TrustMark from '~/components/plugins/TrustMark.vue'
import UiButton from '~/components/ui/UiButton.vue'
import { toast } from '~/composables/useToast'
import { readme } from '~/plugins/storeCache'
import { iconRef, screenshotRefs } from '~/plugins/storeEntry'
import { ago, categoryOf } from '~/plugins/storeMeta'
import { usePluginStore } from '~/stores/pluginStore'

/**
 * One plugin, in full: screenshots, what it may do, what's new, and its long
 * description or README; with Install / Update / Switch off / Settings /
 * Remove, and whether this playhound can run it.
 */
const props = defineProps<{ entry: StoreEntry, busy: boolean, disabled: boolean }>()
const emit = defineEmits<{ back: [], get: [], settings: [id: string] }>()
const store = usePluginStore()

const icon = computed(() => iconRef(props.entry, store.pluginFile))
const shots = computed(() => screenshotRefs(props.entry, store.pluginFile))
const category = computed(() => categoryOf(props.entry.category ?? undefined))
const p = computed(() => props.entry.installed)
const following = computed(() => !!props.entry.repo && store.sourceList.some(r => r.toLowerCase() === props.entry.repo!.toLowerCase()))
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

// ─── About: the long description, else the README ───────────────────────────
const about = ref<string | null>(null)
const aboutLoading = ref(false)
const aboutError = ref('')
watch(() => [props.entry.repo, props.entry.version, props.entry.manifest?.longDescription] as const, async ([repo, version, long]) => {
  aboutError.value = ''
  if (long) {
    about.value = long
    return
  }
  about.value = null
  if (!repo)
    return
  aboutLoading.value = true
  try {
    const text = await readme(repo, version ?? '')
    if (props.entry.repo === repo)
      about.value = text
  }
  catch (err) {
    aboutError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    aboutLoading.value = false
  }
}, { immediate: true })

// Long release notes fold, so the rest of the page is a scroll away.
const notesOpen = ref(false)
const notes = computed(() => props.entry.release?.notes?.trim() ?? '')
const notesLong = computed(() => notes.value.length > 600 || notes.value.split('\n').length > 12)

// ─── Actions ─────────────────────────────────────────────────────────────────
const confirmRemove = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null
async function remove() {
  const info = p.value
  if (!info)
    return
  if (!confirmRemove.value) {
    confirmRemove.value = true
    if (confirmTimer)
      clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => (confirmRemove.value = false), 3500)
    return
  }
  confirmRemove.value = false
  await store.remove(info.manifest.id)
  toast(`Removed ${info.manifest.name}`, { icon: 'i-carbon-application' })
  // Nothing left to show for a plugin no followed repository offers.
  if (!following.value)
    emit('back')
}

function unfollow() {
  if (!props.entry.repo)
    return
  store.removeSource(props.entry.repo)
  toast(`Stopped following ${props.entry.repo}`, { icon: 'i-carbon-logo-github', detail: p.value ? 'It stays installed; updates no longer show here.' : undefined })
  if (!p.value)
    emit('back')
}

const followBusy = ref(false)
async function follow() {
  if (!props.entry.repo)
    return
  followBusy.value = true
  try {
    await store.addSource(props.entry.repo)
  }
  catch (err) {
    toast.error(`Couldn't follow ${props.entry.repo}`, { detail: err instanceof Error ? err.message : String(err) })
  }
  finally {
    followBusy.value = false
  }
}

const TRUST_NOTE = {
  official: { icon: 'i-carbon-checkmark-filled', tone: 'text-accent-300', text: 'Made by playhound’s author.' },
  trusted: { icon: 'i-carbon-favorite-filled', tone: 'text-fg-muted', text: 'From an author known to playhound. Releases aren’t reviewed one by one.' },
}
</script>

<template>
  <div class="flex flex-col gap-5 min-w-0">
    <button type="button" class="text-[12.5px] text-fg-muted focusable rounded-[var(--radius-sm)] flex gap-1 items-center self-start hover:text-fg" @click="emit('back')">
      <span class="i-carbon-arrow-left text-[14px]" /> All plugins
    </button>

    <!-- Header -->
    <div class="flex flex-wrap gap-4 items-start">
      <PluginIcon :id="entry.id" :name="entry.name" :image="icon" :official="entry.trust === 'official'" :size="64" />
      <div class="flex flex-1 flex-col gap-1 min-w-[200px]">
        <div class="flex flex-wrap gap-x-2 gap-y-0.5 items-center">
          <h4 class="text-[17px] text-fg tracking-[-0.01em] font-semibold m-0">
            {{ entry.name }}
          </h4>
          <TrustMark :trust="entry.trust" label />
        </div>
        <div class="text-[12px] text-fg-muted flex flex-wrap gap-x-2.5 gap-y-0.5 items-center">
          <span v-if="entry.author">by {{ entry.author }}</span>
          <a v-if="entry.repo" :href="`https://github.com/${entry.repo}`" target="_blank" rel="noopener noreferrer" class="flex gap-1 items-center hover:text-fg hover:underline">
            <span class="i-carbon-logo-github text-[13px]" />{{ entry.repo }}
          </a>
          <a v-if="entry.manifest?.homepage" :href="entry.manifest.homepage" target="_blank" rel="noopener noreferrer nofollow" class="flex gap-1 items-center hover:text-fg hover:underline">
            <span class="i-carbon-launch text-[12px]" />Website
          </a>
        </div>
        <div class="text-[11.5px] text-fg-faint flex flex-wrap gap-x-2.5 gap-y-0.5 items-center">
          <span v-if="category" class="flex gap-1 items-center"><span :class="category.icon" class="text-[12px]" />{{ category.label }}</span>
          <span v-if="entry.version" class="num">{{ entry.version }}</span>
          <span v-if="entry.release?.publishedAt">updated {{ ago(entry.release.publishedAt) }}</span>
          <span v-if="entry.release?.downloads">{{ entry.release.downloads.toLocaleString() }} downloads</span>
          <span v-if="p">installed {{ p.manifest.version }}</span>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="flex flex-wrap gap-2 items-center">
      <template v-if="!p">
        <UiButton
          v-if="entry.release"
          variant="primary"
          icon="i-carbon-download"
          :loading="busy"
          :disabled="disabled || !!entry.problem"
          @click="emit('get')"
        >
          Install · {{ kb(entry.release.zipSize) }}
        </UiButton>
      </template>
      <template v-else>
        <UiButton
          v-if="entry.update"
          variant="primary"
          icon="i-carbon-upgrade"
          :loading="busy"
          :disabled="disabled || !!entry.problem"
          @click="emit('get')"
        >
          Update to {{ entry.update.version }}
        </UiButton>
        <UiButton icon="i-carbon-power" @click="store.setEnabled(p.manifest.id, !p.enabled)">
          {{ p.enabled ? 'Switch off' : 'Switch on' }}
        </UiButton>
        <UiButton icon="i-carbon-settings" @click="emit('settings', p.manifest.id)">
          Settings
        </UiButton>
        <UiButton v-if="!p.dev" variant="danger" icon="i-carbon-trash-can" @click="remove">
          {{ confirmRemove ? 'Click again to remove' : 'Remove' }}
        </UiButton>
      </template>
      <span class="flex-1" />
      <UiButton v-if="following" variant="ghost" size="xs" @click="unfollow">
        Stop following
      </UiButton>
      <UiButton v-else-if="entry.repo" variant="ghost" size="xs" icon="i-carbon-add" :loading="followBusy" @click="follow">
        Follow for updates
      </UiButton>
    </div>

    <p v-if="entry.problem" class="text-[12.5px] text-warn m-0 px-3 py-2.5 rounded-[var(--radius-md)] bg-warn/10 flex gap-2 items-start">
      <span class="i-carbon-warning-alt text-[15px] mt-px shrink-0" />
      <span>{{ entry.problem.replace(/\.$/, '') }}. <template v-if="/^Needs/.test(entry.problem)">Update playhound in Settings → Updates, then install it.</template></span>
    </p>
    <p v-if="entry.source?.status === 'error'" class="text-[12px] text-danger m-0 px-3 py-2 rounded-[var(--radius-md)] bg-danger/10">
      Last check: {{ entry.source.error }}
    </p>
    <p v-if="p?.dev" class="hint m-0 flex gap-1.5 items-center">
      <span class="i-carbon-folder text-[13px]" /> Loaded from a folder: {{ p.dev.label }}
    </p>

    <StoreScreenshots v-if="shots.length" :shots="shots" :name="entry.name" />

    <p v-if="entry.description" class="text-[13px] text-fg leading-relaxed m-0">
      {{ entry.description }}
    </p>

    <!-- What it may do, and who stands behind it -->
    <section v-if="entry.manifest || entry.release" class="p-4 card flex flex-col gap-3">
      <h5 class="eyebrow m-0">
        Permissions
      </h5>
      <PluginPermissions v-if="entry.manifest" :manifest="entry.manifest" />
      <p v-else class="hint m-0">
        Its release has no manifest.json, so what it asks for shows when you install it.
      </p>
      <div class="pt-3 border-t border-edge">
        <p v-if="entry.trust" class="text-[12px] text-fg-muted m-0 flex gap-2 items-start">
          <span :class="[TRUST_NOTE[entry.trust].icon, TRUST_NOTE[entry.trust].tone]" class="text-[14px] mt-px shrink-0" />
          {{ TRUST_NOTE[entry.trust].text }}
        </p>
        <p v-else class="text-[12px] text-warn m-0 flex gap-2 items-start">
          <span class="i-carbon-warning-alt text-[14px] mt-px shrink-0" />
          <span><strong class="font-semibold">Not reviewed by playhound.</strong> Anyone can publish a plugin. Install it only if you trust {{ entry.repo ? entry.repo.split('/')[0] : 'whoever made it' }}.</span>
        </p>
      </div>
    </section>

    <section v-if="notes" class="flex flex-col gap-2">
      <div class="flex gap-2 items-baseline">
        <h5 class="eyebrow m-0">
          What’s new in {{ entry.release!.version }}
        </h5>
        <a :href="entry.release!.pageUrl" target="_blank" rel="noopener noreferrer" class="text-[11px] text-fg-faint hover:text-fg hover:underline">Release page</a>
      </div>
      <div class="relative" :class="notesLong && !notesOpen ? 'max-h-[180px] overflow-hidden notes-fold' : ''">
        <StoreMarkdown :source="notes" :repo="entry.repo" />
      </div>
      <UiButton v-if="notesLong" variant="ghost" size="xs" class="self-start" :icon="notesOpen ? 'i-carbon-chevron-up' : 'i-carbon-chevron-down'" @click="notesOpen = !notesOpen">
        {{ notesOpen ? 'Show less' : 'Show all' }}
      </UiButton>
    </section>

    <section class="flex flex-col gap-2">
      <h5 class="eyebrow m-0">
        About
      </h5>
      <p v-if="aboutLoading && !about" class="hint m-0">
        Loading the README…
      </p>
      <StoreMarkdown v-else-if="about" :source="about" :repo="entry.repo" drop-title />
      <p v-else-if="aboutError" class="hint m-0">
        Couldn't load the README: {{ aboutError }}
      </p>
      <p v-else class="hint m-0">
        Nothing more to say about it.
      </p>
    </section>
  </div>
</template>

<style scoped>
.notes-fold {
  mask-image: linear-gradient(to bottom, #000 65%, transparent);
}
</style>
