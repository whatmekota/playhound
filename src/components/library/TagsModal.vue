<script setup lang="ts">
import type { VideoEntry } from '~/stores/libraryStore'
import { computed, nextTick, ref, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiModal from '~/components/ui/UiModal.vue'
import { toast } from '~/composables/useToast'
import { plural } from '~/lib/entryInfo'
import { manualTags, splitTagInput } from '~/lib/tags'
import { useLibraryStore } from '~/stores/libraryStore'
import TagPill from './TagPill.vue'
import { useLibraryTags } from './useLibraryTags'

/**
 * Tags for one video or a whole selection. Each tag the videos have is a
 * row: on for all of them, off for none, or a dash when only some have it,
 * which saving leaves alone unless it is clicked.
 */
const entries = defineModel<VideoEntry[] | null>({ default: null })

type State = 'all' | 'some' | 'none'
interface Row { tag: string, was: State, now: State, have: number }

const library = useLibraryStore()
const tags = useLibraryTags()

const rows = ref<Row[]>([])
const input = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
const saving = ref(false)

const open = computed({
  get: () => !!entries.value,
  set: (v) => {
    if (!v)
      entries.value = null
  },
})

watch(entries, (list) => {
  rows.value = []
  input.value = ''
  if (!list?.length)
    return
  const have = new Map<string, number>()
  for (const e of list) {
    for (const t of manualTags(e))
      have.set(t, (have.get(t) ?? 0) + 1)
  }
  rows.value = [...have]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, n]) => {
      const s: State = n === list.length ? 'all' : 'some'
      return { tag, was: s, now: s, have: n }
    })
  void nextTick(() => inputEl.value?.focus())
})

const count = computed(() => entries.value?.length ?? 0)

/** All, then none, then back to how it was for a tag only some had. */
function cycle(r: Row) {
  r.now = r.now === 'all' ? 'none' : r.now === 'none' ? (r.was === 'some' ? 'some' : 'all') : 'all'
}

function add(text = input.value) {
  for (const t of splitTagInput(text)) {
    const r = rows.value.find(x => x.tag === t)
    if (r)
      r.now = 'all'
    else
      rows.value.push({ tag: t, was: 'none', now: 'all', have: 0 })
  }
  input.value = ''
}

/** Library tags not on the list yet, most used first, to add with a click. */
const suggestions = computed(() => {
  const here = new Set(rows.value.map(r => r.tag))
  return tags.manualNames.value.filter(t => !here.has(t))
})
const listId = `ph-tag-list-${Math.random().toString(36).slice(2, 8)}`

const changed = computed(() => rows.value.some(r => r.now !== r.was) || splitTagInput(input.value).length > 0)

async function save() {
  const list = entries.value
  if (!list)
    return
  add()
  const plus = rows.value.filter(r => r.now === 'all' && r.was !== 'all').map(r => r.tag)
  const minus = rows.value.filter(r => r.now === 'none' && r.was !== 'none').map(r => r.tag)
  if (!plus.length && !minus.length) {
    entries.value = null
    return
  }
  saving.value = true
  try {
    const n = await library.editTags(list, plus, minus)
    const what = [plus.length && `added ${plus.join(', ')}`, minus.length && `removed ${minus.join(', ')}`].filter(Boolean).join(' · ')
    toast.success(list.length === 1 ? 'Tags saved' : `Tags saved on ${plural(n, 'video')}`, { detail: what, icon: 'i-carbon-tag', key: 'tags' })
    entries.value = null
  }
  catch {
    toast.error('Could not save tags')
  }
  finally {
    saving.value = false
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === ',') {
    e.preventDefault()
    add()
  }
  else if (e.key === 'Enter') {
    e.preventDefault()
    // Enter on an empty box saves, so typing a tag and pressing Enter twice is the whole job.
    if (input.value.trim())
      add()
    else
      void save()
  }
}
</script>

<template>
  <UiModal
    v-model:open="open"
    title="Tags"
    icon="i-carbon-tag"
    width="420px"
    :subtitle="count === 1 ? entries?.[0]?.basename : plural(count, 'video')"
    :persistent="saving"
  >
    <div class="flex flex-col gap-3">
      <!-- A plain input rather than UiInput: the datalist has to sit on the input itself. -->
      <span class="border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 flex h-8 transition-[border-color,box-shadow] items-center focus-within:border-accent/70 focus-within:ring-3 focus-within:ring-accent-soft">
        <span class="i-carbon-add text-[14px] text-fg-faint ml-2.5 shrink-0" />
        <input
          ref="inputEl"
          v-model="input"
          :list="listId"
          class="text-[13px] text-fg px-2 outline-none bg-transparent h-full min-w-0 w-full placeholder:text-fg-faint"
          placeholder="Add a tag, Enter or comma"
          aria-label="Add a tag"
          @keydown="onKey"
        >
        <datalist :id="listId">
          <option v-for="t in suggestions" :key="t" :value="t" />
        </datalist>
      </span>

      <div v-if="rows.length" class="py-1 well flex flex-col max-h-[260px] overflow-y-auto">
        <button
          v-for="r in rows"
          :key="r.tag"
          type="button"
          role="checkbox"
          :aria-checked="r.now === 'all' ? 'true' : r.now === 'some' ? 'mixed' : 'false'"
          class="mx-1 px-2 text-left focusable rounded-[var(--radius-sm)] flex shrink-0 gap-2.5 h-8 transition-colors items-center hover:bg-fg/6"
          @click="cycle(r)"
        >
          <span class="tick rounded center shrink-0 h-4 w-4" :class="`is-${r.now}`">
            <span v-if="r.now === 'all'" class="i-carbon-checkmark text-[11px]" />
            <span v-else-if="r.now === 'some'" class="i-carbon-subtract text-[11px]" />
          </span>
          <span class="flex-1 min-w-0" :class="r.now === 'none' ? 'opacity-50 line-through' : ''"><TagPill :tag="r.tag" /></span>
          <span v-if="r.now === 'some'" class="hint num shrink-0">{{ r.have }} of {{ count }}</span>
          <span v-else-if="r.was === 'none'" class="hint shrink-0">new</span>
        </button>
      </div>
      <p v-else class="hint">
        {{ count === 1 ? 'No tags yet.' : 'None of these videos has a tag yet.' }}
      </p>

      <div v-if="suggestions.length" class="flex flex-col gap-1.5">
        <span class="eyebrow">In your library</span>
        <div class="flex flex-wrap gap-1">
          <button
            v-for="t in suggestions.slice(0, 12)"
            :key="t"
            type="button"
            class="focusable rounded-[var(--radius-xs)] pressable"
            :aria-label="`Add ${t}`"
            @click="add(t)"
          >
            <TagPill :tag="t" class="opacity-70 hover:opacity-100" />
          </button>
        </div>
      </div>
    </div>
    <template #footer>
      <UiButton variant="ghost" :disabled="saving" @click="entries = null">
        Cancel
      </UiButton>
      <UiButton variant="primary" icon="i-carbon-checkmark" :loading="saving" :disabled="!changed" @click="save">
        Save
      </UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
.tick {
  box-shadow: inset 0 0 0 1.5px var(--border-strong);
}
.tick.is-all,
.tick.is-some {
  background: var(--accent);
  color: var(--accent-contrast);
  box-shadow: none;
}
</style>
