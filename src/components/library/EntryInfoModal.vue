<script setup lang="ts">
import type { VideoMeta } from '~/lib/idb'
import type { ScriptProfile } from '~/lib/scriptIntensity'
import type { VideoEntry } from '~/stores/libraryStore'
import { computed, ref, shallowRef, watch } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiModal from '~/components/ui/UiModal.vue'
import UiSpinner from '~/components/ui/UiSpinner.vue'
import UiStat from '~/components/ui/UiStat.vue'
import { toast } from '~/composables/useToast'
import { effectiveMeta, formatDate, formatSize, scriptBadge } from '~/lib/entryInfo'
import { parseFunscriptContent } from '~/lib/funscriptParser'
import { videoMetaDb } from '~/lib/idb'
import { scriptProfile, speedUnits } from '~/lib/scriptIntensity'
import { formatTime } from '~/lib/time'
import { useLibraryStore } from '~/stores/libraryStore'
import IntensityMeter from './IntensityMeter.vue'
import SpeedSparkline from './SpeedSparkline.vue'
import { useScriptSummaries } from './useScriptSummaries'

/** Info & tags for one video: facts, a script profile, and the editable metadata. */
const entry = defineModel<VideoEntry | null>({ default: null })

const library = useLibraryStore()
const scripts = useScriptSummaries()

const draft = ref<VideoMeta | null>(null)
const tagInput = ref('')

const open = computed({
  get: () => !!entry.value && !!draft.value,
  set: (v) => {
    if (!v)
      close()
  },
})

function close() {
  entry.value = null
  draft.value = null
}

// ─── Script profile ───────────────────────────────────────────────────────
// Worked out fresh from the file: one script parses in a few milliseconds,
// and the stroke count and busiest stretch are not in the cached summary.
const profile = shallowRef<ScriptProfile | null>(null)
const profiling = ref(false)

watch(entry, async (e) => {
  draft.value = null
  profile.value = null
  profiling.value = false
  if (!e)
    return
  let stored: VideoMeta = {}
  try {
    stored = await videoMetaDb.get(e.name) ?? {}
  }
  catch {}
  if (entry.value !== e)
    return
  const d: VideoMeta = { ...(e.scriptMeta ?? {}), ...stored }
  d.tags = Array.isArray(d.tags) ? [...d.tags] : []
  tagInput.value = ''
  draft.value = d
  void loadProfile(e)
})

async function loadProfile(e: VideoEntry) {
  const match = e.scriptMatches.find(m => !m.isAlt) ?? e.scriptMatches[0]
  if (!match)
    return
  profiling.value = true
  try {
    const parsed = parseFunscriptContent(await match.file.text(), match.file.name, e.name)
    const axis = parsed.axes.find(a => a.channel === 'L0') ?? parsed.axes[0]
    if (entry.value !== e || !axis || axis.actions.length < 4)
      return
    const p = scriptProfile(axis.actions)
    profile.value = p
    // Same numbers the director would work out, so the card's marker can have them now.
    if (!scripts.summaryOf(e))
      scripts.remember(e, { meanSpeed: p.meanSpeed, peakSpeed: p.peakSpeed, meanSpm: p.meanSpm, durationMs: p.durationMs, actionCount: axis.actions.length })
  }
  catch {}
  finally {
    if (entry.value === e)
      profiling.value = false
  }
}

const busiest = computed(() => {
  const b = profile.value?.busiest
  if (!b)
    return null
  const secs = (b.endMs - b.startMs) / 1000
  return {
    length: secs >= 60 ? formatTime(secs) : `${Math.round(secs)} s`,
    at: formatTime(b.startMs / 1000),
    speed: speedUnits(b.speed),
  }
})

// ─── Tags ─────────────────────────────────────────────────────────────────
function addTag() {
  if (!draft.value)
    return
  for (const raw of tagInput.value.split(',')) {
    const t = raw.trim().toLowerCase()
    if (t && !draft.value.tags!.includes(t))
      draft.value.tags!.push(t)
  }
  tagInput.value = ''
}

function onTagKey(e: KeyboardEvent) {
  if (e.key === ',' || e.key === 'Enter') {
    e.preventDefault()
    addTag()
  }
  else if (e.key === 'Backspace' && !tagInput.value && draft.value?.tags?.length) {
    draft.value.tags.pop()
  }
}

const allTags = computed(() => {
  if (!entry.value)
    return []
  const set = new Set<string>()
  for (const v of library.videos) {
    for (const t of effectiveMeta(v).tags ?? [])
      set.add(t)
  }
  return [...set].sort()
})

async function save() {
  const e = entry.value
  if (!e || !draft.value)
    return
  addTag()
  const clean: VideoMeta = JSON.parse(JSON.stringify(draft.value))
  try {
    await videoMetaDb.set(e.name, clean)
    e.userMeta = clean
    toast.success('Info saved', { detail: e.basename, key: 'meta' })
    close()
  }
  catch {
    toast.error('Could not save info')
  }
}

const listId = `ph-tags-${Math.random().toString(36).slice(2, 8)}`
</script>

<template>
  <UiModal v-model:open="open" title="Info & tags" icon="i-carbon-tag-edit" width="520px" :subtitle="entry?.basename">
    <div v-if="entry && draft" class="flex flex-col gap-4">
      <!-- Read-only facts -->
      <div class="flex gap-3">
        <div class="rounded-[var(--radius-md)] bg-surface-800 shrink-0 h-[90px] w-40 overflow-hidden">
          <img v-if="entry.thumbnailUrl" :src="entry.thumbnailUrl" class="h-full w-full object-cover" alt="">
        </div>
        <dl class="text-[12px] gap-x-3 gap-y-1 grid grid-cols-[auto_1fr] min-w-0">
          <dt class="text-fg-faint">
            Length
          </dt>
          <dd class="num">
            {{ formatTime(entry.duration, '—') }}
          </dd>
          <dt class="text-fg-faint">
            Size
          </dt>
          <dd class="num">
            {{ formatSize(entry.file.size) }}
          </dd>
          <dt class="text-fg-faint">
            Modified
          </dt>
          <dd>{{ formatDate(entry.file.lastModified) }}</dd>
          <dt class="text-fg-faint">
            Script
          </dt>
          <dd class="truncate">
            {{ scriptBadge(entry).long }}<template v-if="entry.channels?.length">
              · <span class="num">{{ entry.channels.join(' ') }}</span>
            </template>
          </dd>
        </dl>
      </div>
      <div v-if="entry.scriptMatches.length" class="px-3 py-2 well flex flex-col gap-1">
        <div v-for="m in entry.scriptMatches" :key="m.file.name" class="text-[12px] flex gap-2 items-center">
          <span class="i-carbon-document text-fg-faint shrink-0" />
          <span class="text-fg-muted flex-1 truncate">{{ m.file.name }}</span>
          <UiBadge v-if="m.isAlt" size="xs" tone="info">
            alt · {{ m.altName }}
          </UiBadge>
        </div>
      </div>

      <!-- Script profile -->
      <Transition name="t-fade" mode="out-in">
        <div v-if="profile" class="px-3 pb-2.5 pt-2 well flex flex-col gap-2.5">
          <div class="flex gap-2 items-center">
            <span class="eyebrow">Script profile</span>
            <span class="flex-1" />
            <IntensityMeter :summary="profile" label />
          </div>
          <SpeedSparkline :curve="profile.curve" :duration-ms="profile.durationMs" :busiest="profile.busiest" />
          <div class="gap-3 grid grid-cols-4">
            <UiStat size="sm" label="Avg speed" :value="speedUnits(profile.meanSpeed)" unit="u/s" hint="Mean speed over the whole script, in funscript units per second" />
            <UiStat size="sm" label="Peak" :value="speedUnits(profile.peakSpeed)" unit="u/s" hint="Fastest three-second stretch" />
            <UiStat size="sm" label="Strokes" :value="profile.strokes.toLocaleString()" :hint="`About ${Math.round(profile.meanSpm)} a minute while moving`" />
            <UiStat
              size="sm"
              label="Busiest run"
              :value="busiest?.length ?? '—'"
              :hint="busiest ? `From ${busiest.at}, averaging ${busiest.speed} u/s (shaded above)` : 'No sustained busy section'"
            />
          </div>
        </div>
        <div v-else-if="profiling" class="text-[12px] text-fg-faint px-3 py-2.5 well flex gap-2 items-center">
          <UiSpinner :size="12" /> Reading the script…
        </div>
      </Transition>

      <div class="divider-y" />

      <div class="gap-3 grid grid-cols-2">
        <UiInput v-model="draft.creator" label="Creator" placeholder="Who made the script" />
        <UiInput v-model="draft.date" label="Date" placeholder="2024-10-05" />
        <UiInput v-model="draft.url" label="Source URL" placeholder="https://…" class="col-span-2">
          <template #suffix>
            <a
              v-if="draft.url"
              v-tip="'Open link'"
              :href="draft.url"
              target="_blank"
              rel="noopener noreferrer"
              class="text-fg-faint mr-1.5 rounded center h-5 w-5 hover:text-fg"
            ><span class="i-carbon-launch text-[13px]" /></a>
          </template>
        </UiInput>
      </div>

      <div class="flex flex-col gap-1">
        <span class="label">Rating</span>
        <div class="flex gap-0.5 items-center">
          <button
            v-for="n in 5"
            :key="n"
            type="button"
            class="text-[20px] focusable rounded pressable"
            :class="(draft.rating ?? 0) >= n ? 'text-warn' : 'text-fg-faint hover:text-fg-muted'"
            :aria-label="`${n} star${n === 1 ? '' : 's'}`"
            @click="draft.rating = draft.rating === n ? 0 : n"
          >
            <span :class="(draft.rating ?? 0) >= n ? 'i-carbon-star-filled' : 'i-carbon-star'" />
          </button>
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <span class="label">Tags</span>
        <div class="p-1.5 border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 flex flex-wrap gap-1 min-h-8 transition-[border-color,box-shadow] items-center focus-within:border-accent/70 focus-within:ring-3 focus-within:ring-accent-soft">
          <TransitionGroup name="t-pop">
            <span v-for="tag in draft.tags" :key="tag" class="text-[11.5px] text-accent-300 pl-2 pr-1 rounded-[var(--radius-xs)] bg-accent-soft flex gap-1 h-6 items-center">
              {{ tag }}
              <button type="button" class="rounded center h-4 w-4 hover:bg-fg/10" :aria-label="`Remove ${tag}`" @click="draft.tags = draft.tags!.filter(t => t !== tag)">
                <span class="i-carbon-close text-[11px]" />
              </button>
            </span>
          </TransitionGroup>
          <input
            v-model="tagInput"
            :list="listId"
            class="text-[12.5px] text-fg px-1 outline-none bg-transparent flex-1 min-w-[120px] placeholder:text-fg-faint"
            placeholder="Add a tag, Enter or comma"
            @keydown="onTagKey"
            @blur="addTag"
          >
          <datalist :id="listId">
            <option v-for="t in allTags" :key="t" :value="t" />
          </datalist>
        </div>
      </div>

      <label class="flex flex-col gap-1">
        <span class="label">Notes</span>
        <textarea
          v-model="draft.notes"
          rows="3"
          class="text-[12.5px] text-fg px-2.5 py-2 outline-none border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 resize-none transition-[border-color,box-shadow] placeholder:text-fg-faint focus:border-accent/70 focus:ring-3 focus:ring-accent-soft"
          placeholder="Personal notes…"
        />
      </label>
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="close">
        Cancel
      </UiButton>
      <UiButton variant="primary" icon="i-carbon-checkmark" @click="save">
        Save
      </UiButton>
    </template>
  </UiModal>
</template>
