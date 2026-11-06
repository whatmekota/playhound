<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import UiInput from '~/components/ui/UiInput.vue'
import { normalizeTag } from '~/lib/tags'
import TagPill from './TagPill.vue'
import { useLibraryTags } from './useLibraryTags'

/**
 * Every tag in the library, to filter by. Stays open while tags are picked:
 * choosing two or three is the usual case, and a menu that closed after each
 * would make that a chore.
 */
const props = defineProps<{ selected: ReadonlySet<string> }>()
const emit = defineEmits<{ toggle: [tag: string] }>()

const tags = useLibraryTags()
const find = ref('')
const findEl = ref<InstanceType<typeof UiInput> | null>(null)
// `autofocus` only counts on page load; the menu mounts later, when opened.
onMounted(() => nextTick(() => findEl.value?.focus()))

const list = computed(() => {
  const q = normalizeTag(find.value)
  return q ? tags.all.value.filter(t => t.tag.includes(q)) : tags.all.value
})
const manual = computed(() => list.value.filter(t => !t.auto))
const auto = computed(() => list.value.filter(t => t.auto))

function onEnter() {
  const first = list.value[0]
  if (first)
    emit('toggle', first.tag)
}
</script>

<template>
  <div class="p-1.5 flex flex-col gap-1.5 w-[240px]">
    <UiInput ref="findEl" v-model="find" icon="i-carbon-search" placeholder="Find a tag" @enter="onEnter" />
    <div class="scroll-y flex flex-col max-h-[300px]">
      <template v-for="group in [{ id: 'manual', title: 'Your tags', rows: manual }, { id: 'auto', title: 'Automatic', rows: auto }]" :key="group.id">
        <template v-if="group.rows.length">
          <p class="eyebrow px-2 pb-1 pt-2">
            {{ group.title }}
          </p>
          <button
            v-for="t in group.rows"
            :key="t.tag"
            type="button"
            role="menuitemcheckbox"
            :aria-checked="props.selected.has(t.tag)"
            class="px-2 text-left focusable rounded-[var(--radius-sm)] flex shrink-0 gap-2 h-8 transition-colors items-center hover:bg-fg/8"
            @click="emit('toggle', t.tag)"
          >
            <span class="flex-1 min-w-0"><TagPill :tag="t.tag" :auto="t.auto" /></span>
            <span class="text-[11px] text-fg-faint num">{{ t.count.toLocaleString() }}</span>
            <span class="i-carbon-checkmark text-[14px] text-accent-300 shrink-0" :class="props.selected.has(t.tag) ? '' : 'opacity-0'" />
          </button>
        </template>
      </template>
      <p v-if="!list.length" class="hint px-2 py-3">
        {{ find ? 'No tag matches.' : 'No tags yet. Add some from a video\'s menu.' }}
      </p>
    </div>
    <p class="hint px-2 pb-1">
      Or type <span class="text-fg-muted font-mono">tag:name</span> or <span class="text-fg-muted font-mono">-tag:name</span> in the search.
    </p>
  </div>
</template>
