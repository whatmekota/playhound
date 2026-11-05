<script setup lang="ts">
import type { SelectOption, SettingField } from '~/plugins/types'
import type { PluginInfo } from '~/stores/pluginStore'
import { computed, onMounted, reactive, ref } from 'vue'
import UiField from '~/components/ui/UiField.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiSelect from '~/components/ui/UiSelect.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { usePluginStore } from '~/stores/pluginStore'

/** A plugin's settings, drawn from the fields it declared with ctx.ui.settings(). */
const props = defineProps<{ plugin: PluginInfo }>()
const store = usePluginStore()

const id = computed(() => props.plugin.manifest.id)
const fields = computed(() => props.plugin.fields ?? [])
const values = computed<Record<string, unknown>>(() => {
  const out: Record<string, unknown> = {}
  for (const f of fields.value) {
    if (f.type !== 'heading' && f.default !== undefined)
      out[f.key] = f.default
  }
  return { ...out, ...props.plugin.values }
})
const visible = computed(() => fields.value.filter((f) => {
  try {
    return !f.when || f.when(values.value)
  }
  catch {
    return true
  }
}))

function set(key: string, v: unknown) {
  void store.setValue(id.value, key, v)
}
const str = (key: string) => String(values.value[key] ?? '')
const num = (key: string, fallback = 0) => Number(values.value[key] ?? fallback)

// ─── Selects whose options come from the plugin (fetched) ───────────────────
const options = reactive<Record<string, SelectOption[]>>({})
const loading = reactive<Record<string, boolean>>({})
const optionError = reactive<Record<string, string>>({})
async function loadOptions(f: Extract<SettingField, { type: 'select' }>) {
  if (Array.isArray(f.options)) {
    options[f.key] = f.options
    return
  }
  loading[f.key] = true
  optionError[f.key] = ''
  try {
    options[f.key] = await f.options()
  }
  catch (err) {
    optionError[f.key] = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading[f.key] = false
  }
}
onMounted(() => {
  for (const f of fields.value) {
    if (f.type === 'select')
      void loadOptions(f)
  }
})
function selectOptions(f: Extract<SettingField, { type: 'select' }>) {
  const list = options[f.key] ?? (Array.isArray(f.options) ? f.options : [])
  const cur = str(f.key)
  // An empty value is a choice too ("use the default"), not "nothing picked".
  const head = cur && !list.some(o => o.value === cur) ? [{ value: cur, label: cur }] : !cur && !list.some(o => o.value === '') ? [{ value: '', label: 'Default' }] : []
  return [...head, ...list]
}

const shown = ref<Record<string, boolean>>({})

// ─── Sections ───────────────────────────────────────────────────────────────
// Each heading starts a section that folds away, so a plugin with a lot of
// settings is a short list of topics, not one long page. The first opens by
// itself; fields before any heading are always shown.
type Heading = Extract<SettingField, { type: 'heading' }>
interface Group { key: string, heading: Heading | null, items: Exclude<SettingField, Heading>[] }
const groups = computed<Group[]>(() => {
  const out: Group[] = []
  let cur: Group = { key: '', heading: null, items: [] }
  for (const f of visible.value) {
    if (f.type === 'heading') {
      if (cur.heading || cur.items.length)
        out.push(cur)
      cur = { key: f.label, heading: f, items: [] }
    }
    else {
      cur.items.push(f)
    }
  }
  if (cur.heading || cur.items.length)
    out.push(cur)
  return out
})
const opened = reactive<Record<string, boolean>>({})
const firstSection = computed(() => groups.value.find(g => g.heading)?.key)
const isOpen = (g: Group) => !g.heading || (opened[g.key] ?? g.key === firstSection.value)
function toggle(g: Group) {
  opened[g.key] = !isOpen(g)
}
/** A select that couldn't load its list keeps its section open, so the problem isn't hidden. */
const hasProblem = (g: Group) => g.items.some(f => f.type === 'select' && !!optionError[f.key])

/** "Other…" in a select that takes any value: swaps the select for a text box. */
const OTHER = '__other__'
const typing = reactive<Record<string, boolean>>({})
</script>

<template>
  <div class="flex flex-col gap-2">
    <section
      v-for="g in groups"
      :key="g.key"
      :class="g.heading ? 'rounded-[var(--radius-md)] border border-edge bg-surface-900/40' : 'flex flex-col gap-3 pb-1'"
    >
      <button
        v-if="g.heading"
        type="button"
        class="px-3 py-2.5 text-left focusable rounded-[var(--radius-md)] flex gap-2.5 w-full items-center hover:bg-fg/4"
        :aria-expanded="isOpen(g) || hasProblem(g)"
        @click="toggle(g)"
      >
        <span class="i-carbon-chevron-right text-[13px] text-fg-faint shrink-0 transition-transform duration-150" :class="(isOpen(g) || hasProblem(g)) && 'rotate-90'" />
        <span class="flex flex-1 flex-col gap-0.5 min-w-0">
          <span class="text-[13px] text-fg font-medium">{{ g.heading.label }}</span>
          <span v-if="g.heading.hint && !(isOpen(g) || hasProblem(g))" class="text-[11.5px] text-fg-faint truncate">{{ g.heading.hint }}</span>
        </span>
        <span v-if="hasProblem(g)" class="i-carbon-warning-alt text-[14px] text-warn shrink-0" />
      </button>
      <div v-if="isOpen(g) || hasProblem(g)" class="flex flex-col gap-3" :class="g.heading ? 'px-3 pb-3.5 pt-0.5' : ''">
        <span v-if="g.heading?.hint" class="hint -mt-1">{{ g.heading.hint }}</span>
        <template v-for="f in g.items" :key="f.key">
          <UiSwitch
            v-if="f.type === 'switch'"
            :model-value="!!values[f.key]"
            :label="f.label"
            :hint="f.hint"
            @update:model-value="set(f.key, $event)"
          />

          <UiField v-else-if="f.type === 'slider'" :label="f.label" :hint="f.hint" stacked>
            <UiSlider
              :model-value="num(f.key, f.min)"
              :min="f.min"
              :max="f.max"
              :step="f.step ?? 1"
              :unit="f.unit"
              @update:model-value="set(f.key, $event)"
            />
          </UiField>

          <UiField v-else-if="f.type === 'textarea'" :label="f.label" :hint="f.hint" stacked>
            <textarea
              :value="str(f.key)"
              :rows="f.rows ?? 6"
              :placeholder="f.placeholder"
              spellcheck="false"
              class="text-[12.5px] text-fg leading-relaxed px-2.5 py-2 outline-none border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 w-full resize-y placeholder:text-fg-faint focus:border-accent/70 focus:ring-3 focus:ring-accent-soft"
              @change="set(f.key, ($event.target as HTMLTextAreaElement).value)"
            />
          </UiField>

          <UiField v-else-if="f.type === 'select'" :label="f.label" :hint="optionError[f.key] ? `Couldn't load the list: ${optionError[f.key]}` : f.hint" stacked>
            <div class="flex gap-1.5 items-center">
              <div class="flex-1 min-w-0">
                <input
                  v-if="f.free && typing[f.key]"
                  :value="str(f.key)"
                  spellcheck="false"
                  placeholder="Type a value, Enter to keep it"
                  class="text-[12.5px] text-fg px-2.5 outline-none border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 h-7 w-full focus:border-accent/70 focus:ring-3 focus:ring-accent-soft"
                  @vue:mounted="({ el }: any) => el.focus()"
                  @change="set(f.key, ($event.target as HTMLInputElement).value.trim()); typing[f.key] = false"
                  @keydown.escape="typing[f.key] = false"
                  @blur="typing[f.key] = false"
                >
                <UiSelect
                  v-else
                  :model-value="str(f.key)"
                  :options="f.free ? [...selectOptions(f), { value: OTHER, label: 'Other…' }] : selectOptions(f)"
                  @update:model-value="$event === OTHER ? (typing[f.key] = true) : set(f.key, $event)"
                />
              </div>
              <UiIconButton
                v-if="!Array.isArray(f.options)"
                icon="i-carbon-renew"
                label="Refresh the list"
                size="sm"
                :disabled="loading[f.key]"
                :class="loading[f.key] && 'animate-spin'"
                @click="loadOptions(f)"
              />
            </div>
          </UiField>

          <UiField v-else-if="f.type === 'number'" :label="f.label" :hint="f.hint">
            <input
              type="number"
              :value="num(f.key)"
              :min="f.min"
              :max="f.max"
              :step="f.step ?? 1"
              class="text-[12.5px] text-fg px-2 outline-none border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 h-7 w-24 focus:border-accent/70"
              @change="set(f.key, Number(($event.target as HTMLInputElement).value))"
            >
          </UiField>

          <UiField v-else :label="f.label" :hint="f.hint" stacked>
            <UiInput
              class="w-full"
              :model-value="str(f.key)"
              :type="f.type === 'password' && !shown[f.key] ? 'password' : 'text'"
              :placeholder="f.placeholder"
              :mono="f.type === 'password'"
              size="sm"
              @update:model-value="set(f.key, String($event))"
            >
              <template v-if="f.type === 'password'" #suffix>
                <button
                  type="button"
                  class="text-fg-faint mr-1.5 rounded center shrink-0 h-5 w-5 hover:text-fg hover:bg-fg/8"
                  :aria-label="shown[f.key] ? 'Hide' : 'Show'"
                  @click="shown[f.key] = !shown[f.key]"
                >
                  <span :class="shown[f.key] ? 'i-carbon-view-off' : 'i-carbon-view'" class="text-[13px]" />
                </button>
              </template>
            </UiInput>
          </UiField>
        </template>
      </div>
    </section>
  </div>
</template>
