<script setup lang="ts">
import type { MenuItem } from '~/components/ui/menu'
import type { ActionKind, Condition, ConditionKind, ParamKind, Rule, RuleAction, Trigger, TriggerKind } from '~/lib/rules'
import { useIntervalFn } from '@vueuse/core'
import { computed, ref } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiMenu from '~/components/ui/UiMenu.vue'
import UiPanel from '~/components/ui/UiPanel.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import UiSection from '~/components/ui/UiSection.vue'
import UiSelect from '~/components/ui/UiSelect.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { useRules } from '~/composables/useRules'
import {
  ACTIONS,
  cleanTag,
  cloneRule,
  CONDITIONS,
  describeRule,
  MAX_ACTIONS,
  MAX_CONDITIONS,
  MAX_PER_MINUTE_LIMIT,
  MAX_RULES,
  MIN_COOLDOWN_SEC,
  MOTION_SOURCE_NAMES,
  newRule,
  RULE_PHASES,
  ruleId,
  TEMPLATES,
  TRIGGERS,
} from '~/lib/rules'

const { config, log, firedCount, lastFired, paused, tryRule, clearLog } = useRules()

const rules = computed(() => config.value.rules)
const onCount = computed(() => rules.value.filter(r => r.enabled).length)

// A clock for "2m ago"; slow, nothing here needs to be exact.
const now = ref(Date.now())
useIntervalFn(() => (now.value = Date.now()), 10_000)

function ago(ts: number | undefined): string {
  if (!ts)
    return ''
  const s = Math.max(0, Math.round((now.value - ts) / 1000))
  if (s < 60)
    return 'just now'
  const m = Math.round(s / 60)
  if (m < 60)
    return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const status = computed(() => {
  if (paused.value)
    return { tone: 'warn' as const, text: 'Paused by panic' }
  if (!config.value.enabled)
    return { tone: 'neutral' as const, text: 'Off: no rule fires' }
  if (!onCount.value)
    return { tone: 'neutral' as const, text: 'No rule switched on' }
  return { tone: 'ok' as const, text: `${onCount.value} ${onCount.value === 1 ? 'rule' : 'rules'} watching` }
})

// ─── Editing ────────────────────────────────────────────────────────────────

const openId = ref<string | null>(null)

const triggerOptions = TRIGGERS.map(t => ({ value: t.kind, label: t.label }))
const conditionOptions = CONDITIONS.map(c => ({ value: c.kind, label: c.label }))
const actionOptions = ACTIONS.map(a => ({ value: a.kind, label: a.label }))
const phaseOptions = RULE_PHASES
const sourceOptions = MOTION_SOURCE_NAMES

const triggerDef = (k: TriggerKind) => TRIGGERS.find(t => t.kind === k)!
const conditionDef = (k: ConditionKind) => CONDITIONS.find(c => c.kind === k)!
const actionDef = (k: ActionKind) => ACTIONS.find(a => a.kind === k)!

const UNIT: Partial<Record<NonNullable<ParamKind>, string>> = {
  bpm: 'bpm',
  rise: 'bpm',
  minutes: 'min',
  percent: '%',
  delta: '%',
  seconds: 's',
}

/** Fresh params for a kind, so switching kinds never carries a stale value. */
function paramsFor(def: { param: ParamKind, value?: number }): { value?: number, phase?: Rule['trigger']['phase'], tag?: string, text?: string, source?: RuleAction['source'] } {
  switch (def.param) {
    case 'phase': return { phase: 'build' }
    case 'tag': return { tag: '' }
    case 'text': return { text: '' }
    case 'source': return { source: 'music' }
    case null: return {}
    default: return { value: def.value ?? 0 }
  }
}

function setTrigger(r: Rule, kind: TriggerKind) {
  r.trigger = { kind, ...paramsFor(triggerDef(kind)) } as Trigger
}
function setCondition(r: Rule, i: number, kind: ConditionKind) {
  r.conditions[i] = { kind, ...paramsFor(conditionDef(kind)) } as Condition
}
function setAction(r: Rule, i: number, kind: ActionKind) {
  r.actions[i] = { kind, ...paramsFor(actionDef(kind)) } as RuleAction
}

function setNumber(target: { value?: number }, raw: string | number) {
  const v = typeof raw === 'number' ? raw : Number.parseFloat(raw)
  if (Number.isFinite(v))
    target.value = Math.round(v)
}

function setTag(target: { tag?: string }, raw: string | number) {
  target.tag = cleanTag(String(raw))
}

function addCondition(r: Rule) {
  if (r.conditions.length < MAX_CONDITIONS)
    r.conditions.push({ kind: 'phase', phase: 'build' })
}
function addAction(r: Rule) {
  if (r.actions.length < MAX_ACTIONS)
    r.actions.push({ kind: 'toast', text: '' })
}

function create() {
  if (rules.value.length >= MAX_RULES)
    return
  const r = newRule()
  config.value.rules.push(r)
  openId.value = r.id
}

function duplicate(r: Rule) {
  if (rules.value.length >= MAX_RULES)
    return
  const copy = { ...cloneRule(r), id: ruleId(), name: `${r.name} copy`, enabled: false }
  const i = rules.value.findIndex(x => x.id === r.id)
  config.value.rules.splice(i + 1, 0, copy)
  openId.value = copy.id
}

function remove(r: Rule) {
  config.value.rules = config.value.rules.filter(x => x.id !== r.id)
  if (openId.value === r.id)
    openId.value = null
}

function move(r: Rule, d: -1 | 1) {
  const list = config.value.rules
  const i = list.findIndex(x => x.id === r.id)
  const j = i + d
  if (i < 0 || j < 0 || j >= list.length)
    return
  const [moved] = list.splice(i, 1)
  list.splice(j, 0, moved)
}

function ruleMenu(r: Rule, i: number): MenuItem[] {
  return [
    { label: 'Try it now', icon: 'i-carbon-play', run: () => tryRule(r.id), disabled: !r.actions.length },
    { label: 'Duplicate', icon: 'i-carbon-copy', run: () => duplicate(r), disabled: rules.value.length >= MAX_RULES },
    { label: 'Move up', icon: 'i-carbon-arrow-up', run: () => move(r, -1), disabled: i === 0 },
    { label: 'Move down', icon: 'i-carbon-arrow-down', run: () => move(r, 1), disabled: i === rules.value.length - 1 },
    { separator: true },
    { label: 'Delete', icon: 'i-carbon-trash-can', danger: true, run: () => remove(r) },
  ]
}

/** Starters that are not in the list any more (deleted), to add back. */
const missingTemplates = computed(() => TEMPLATES.filter(t => !rules.value.some(r => r.id === t.id)))
const templateMenu = computed<MenuItem[]>(() => [
  { label: 'Starters', heading: true },
  ...TEMPLATES.map(t => ({
    label: t.name,
    icon: TRIGGERS.find(x => x.kind === t.trigger.kind)?.icon,
    disabled: rules.value.length >= MAX_RULES,
    run: () => {
      const present = rules.value.some(r => r.id === t.id)
      const copy = { ...cloneRule(t), id: present ? ruleId() : t.id }
      config.value.rules.push(copy)
      openId.value = copy.id
    },
  })),
])

const cooldownFormat = (v: number) => (v < 60 ? `${v} s` : `${Math.floor(v / 60)}m${v % 60 ? ` ${v % 60}s` : ''}`)

const triggerHint = computed(() => (r: Rule) => {
  switch (r.trigger.kind) {
    case 'heart-above':
    case 'heart-below':
    case 'heart-rising':
      return 'Needs a heart-rate monitor (Device panel). Fires once on the way over, and again only after it has dropped back a few beats.'
    case 'minutes':
      return 'Counted from the first video of the session. Half an hour with nothing playing starts a new one.'
    case 'script-above':
      return 'How hard the script is going right here, against the rest of the same script.'
    case 'phase':
      return 'Phases come from a programme or a session started in Binaural.'
    case 'tag':
      return 'Your own tags and the automatic ones (fast, intense, vr…).'
    default:
      return ''
  }
})
</script>

<template>
  <UiPanel>
    <!-- ─── Hero: what it is, and the master switch ───────────────────────── -->
    <section class="p-3 card flex flex-col gap-3">
      <div class="flex gap-3 items-start">
        <div
          class="text-[18px] rounded-[var(--radius-md)] center shrink-0 h-9 w-9 ring-1 transition-colors"
          :class="config.enabled && !paused ? 'bg-accent-soft text-accent-300 ring-accent/30' : 'bg-surface-800 text-fg-muted ring-edge'"
        >
          <span class="i-carbon-rule" />
        </div>
        <div class="flex flex-1 flex-col gap-0.5 min-w-0">
          <span class="text-[13px] text-fg font-medium">Rules</span>
          <span class="hint">When something happens, do something. No rule can go past the speed ceiling, and panic stops them all.</span>
        </div>
        <UiSwitch v-model="config.enabled" />
      </div>
      <div class="flex gap-2 items-center">
        <UiBadge :tone="status.tone" :dot="status.tone !== 'neutral'" :pulse="status.tone === 'ok'">
          {{ status.text }}
        </UiBadge>
        <span v-if="firedCount" class="text-[11.5px] text-fg-faint num ml-auto">fired {{ firedCount }}× since start</span>
      </div>
    </section>

    <!-- ─── The rules ──────────────────────────────────────────────────────── -->
    <UiSection title="Your rules" icon="i-carbon-list-checked" :summary="`${onCount} / ${rules.length} on`">
      <template #actions>
        <UiPopover placement="bottom" align="end" flush>
          <template #trigger="{ toggle, open }">
            <UiButton size="xs" variant="ghost" icon="i-carbon-template" :active="open" @click="toggle">
              Starters
            </UiButton>
          </template>
          <template #default="{ close }">
            <div class="p-1 max-w-[320px]">
              <UiMenu :items="templateMenu" @done="close" />
            </div>
          </template>
        </UiPopover>
        <UiButton size="xs" variant="ghost" icon="i-carbon-add" :disabled="rules.length >= MAX_RULES" @click="create">
          New
        </UiButton>
      </template>

      <UiEmpty
        v-if="!rules.length"
        icon="i-carbon-rule"
        title="No rules"
        description="Start from a starter, or make one: a trigger, any conditions, and what to do."
        size="sm"
      />

      <TransitionGroup v-else tag="div" name="t-list" class="flex flex-col gap-1.5 relative">
        <div
          v-for="(r, i) in rules"
          :key="r.id"
          class="well flex flex-col"
          :class="r.enabled ? '' : 'opacity-85'"
        >
          <div class="py-2 pl-2.5 pr-1 flex gap-2.5 items-start">
            <UiSwitch v-model="r.enabled" size="sm" class="mt-0.5" :aria-label="`${r.name} on or off`" />
            <button
              type="button"
              class="text-left focusable rounded-[var(--radius-xs)] flex flex-1 flex-col gap-0.5 min-w-0"
              :aria-expanded="openId === r.id"
              @click="openId = openId === r.id ? null : r.id"
            >
              <span class="text-[12.5px] font-medium flex gap-1.5 items-center" :class="r.enabled ? 'text-fg' : 'text-fg-muted'">
                <span :class="TRIGGERS.find(t => t.kind === r.trigger.kind)?.icon" class="text-[13px] text-fg-faint shrink-0" />
                <span class="truncate">{{ r.name }}</span>
              </span>
              <span class="text-[11px] text-fg-faint leading-snug">{{ describeRule(r) }}</span>
              <span v-if="lastFired[r.id]" class="text-[10.5px] text-accent-300 num">fired {{ ago(lastFired[r.id]) }}</span>
            </button>
            <UiPopover placement="bottom" align="end" flush>
              <template #trigger="{ toggle, open }">
                <UiIconButton icon="i-carbon-overflow-menu-vertical" label="Rule actions" size="xs" :active="open" @click="toggle" />
              </template>
              <template #default="{ close }">
                <div class="p-1">
                  <UiMenu :items="ruleMenu(r, i)" @done="close" />
                </div>
              </template>
            </UiPopover>
          </div>

          <Transition name="t-collapse">
            <div v-if="openId === r.id">
              <div class="min-h-0 overflow-hidden">
                <div class="px-2.5 pb-3 pt-1 flex flex-col gap-3">
                  <UiInput v-model="r.name" size="sm" label="Name" placeholder="What it does" />

                  <!-- When -->
                  <div class="flex flex-col gap-1.5">
                    <span class="label">When</span>
                    <div class="flex gap-1.5 items-center">
                      <UiSelect :model-value="r.trigger.kind" :options="triggerOptions" size="sm" class="flex-1 min-w-0" @update:model-value="setTrigger(r, $event)" />
                      <template v-if="triggerDef(r.trigger.kind).param === 'phase'">
                        <UiSelect v-model="r.trigger.phase!" :options="phaseOptions" size="sm" class="w-28" />
                      </template>
                      <template v-else-if="triggerDef(r.trigger.kind).param === 'tag'">
                        <UiInput :model-value="r.trigger.tag ?? ''" size="sm" placeholder="tag" class="w-28" @update:model-value="setTag(r.trigger, $event)" />
                      </template>
                      <template v-else-if="triggerDef(r.trigger.kind).param">
                        <UiInput :model-value="r.trigger.value ?? 0" type="number" size="sm" class="num w-18" @update:model-value="setNumber(r.trigger, $event)" />
                        <span class="text-[11px] text-fg-faint shrink-0">{{ UNIT[triggerDef(r.trigger.kind).param!] }}</span>
                      </template>
                    </div>
                    <p v-if="triggerHint(r)" class="hint">
                      {{ triggerHint(r) }}
                    </p>
                  </div>

                  <!-- Only if -->
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-center justify-between">
                      <span class="label">Only if</span>
                      <UiButton size="xs" variant="subtle" icon="i-carbon-add" :disabled="r.conditions.length >= MAX_CONDITIONS" @click="addCondition(r)">
                        Condition
                      </UiButton>
                    </div>
                    <p v-if="!r.conditions.length" class="hint">
                      Always. Add conditions and all of them must hold.
                    </p>
                    <div v-for="(c, ci) in r.conditions" :key="ci" class="flex gap-1.5 items-center">
                      <UiSelect :model-value="c.kind" :options="conditionOptions" size="sm" class="flex-1 min-w-0" @update:model-value="setCondition(r, ci, $event)" />
                      <template v-if="conditionDef(c.kind).param === 'phase'">
                        <UiSelect v-model="c.phase!" :options="phaseOptions" size="sm" class="w-28" />
                      </template>
                      <template v-else-if="conditionDef(c.kind).param === 'tag'">
                        <UiInput :model-value="c.tag ?? ''" size="sm" placeholder="tag" class="w-28" @update:model-value="setTag(c, $event)" />
                      </template>
                      <template v-else-if="conditionDef(c.kind).param">
                        <UiInput :model-value="c.value ?? 0" type="number" size="sm" class="num w-18" @update:model-value="setNumber(c, $event)" />
                        <span class="text-[11px] text-fg-faint shrink-0">{{ UNIT[conditionDef(c.kind).param!] }}</span>
                      </template>
                      <UiIconButton icon="i-carbon-close" label="Remove condition" size="xs" @click="r.conditions.splice(ci, 1)" />
                    </div>
                  </div>

                  <!-- Then -->
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-center justify-between">
                      <span class="label">Then</span>
                      <UiButton size="xs" variant="subtle" icon="i-carbon-add" :disabled="r.actions.length >= MAX_ACTIONS" @click="addAction(r)">
                        Action
                      </UiButton>
                    </div>
                    <p v-if="!r.actions.length" class="hint text-warn">
                      Nothing yet: a rule needs at least one action to fire.
                    </p>
                    <div v-for="(a, ai) in r.actions" :key="ai" class="flex gap-1.5 items-center">
                      <UiSelect :model-value="a.kind" :options="actionOptions" size="sm" class="flex-1 min-w-0" @update:model-value="setAction(r, ai, $event)" />
                      <template v-if="actionDef(a.kind).param === 'source'">
                        <UiSelect v-model="a.source!" :options="sourceOptions" size="sm" class="w-28" />
                      </template>
                      <template v-else-if="actionDef(a.kind).param === 'tag'">
                        <UiInput :model-value="a.tag ?? ''" size="sm" placeholder="tag" class="w-28" @update:model-value="setTag(a, $event)" />
                      </template>
                      <template v-else-if="actionDef(a.kind).param === 'text'">
                        <UiInput v-model="a.text" size="sm" placeholder="Words" class="w-32" />
                      </template>
                      <template v-else-if="actionDef(a.kind).param">
                        <UiInput :model-value="a.value ?? 0" type="number" size="sm" class="num w-18" @update:model-value="setNumber(a, $event)" />
                        <span class="text-[11px] text-fg-faint shrink-0">{{ UNIT[actionDef(a.kind).param!] }}</span>
                      </template>
                      <UiIconButton icon="i-carbon-close" label="Remove action" size="xs" @click="r.actions.splice(ai, 1)" />
                    </div>
                    <p v-if="r.actions.some(a => a.kind === 'face')" class="hint">
                      Shown in the face window (Face panel → Open face window). The CYD board has no room for words.
                    </p>
                    <p v-if="r.actions.some(a => a.kind.startsWith('intensity') || a.kind === 'cool-down')" class="hint">
                      Intensity moves gradually, about 5% a second. Touch the knob yourself and the rule lets go.
                    </p>
                  </div>

                  <UiSlider
                    v-model="r.cooldownSec"
                    label="Cooldown"
                    :min="MIN_COOLDOWN_SEC"
                    :max="600"
                    :step="5"
                    :format="cooldownFormat"
                    hint="The shortest time between two firings of this rule."
                  />

                  <div class="flex gap-2 justify-end">
                    <UiButton size="xs" variant="ghost" icon="i-carbon-play" :disabled="!r.actions.length || paused" @click="tryRule(r.id)">
                      Try it now
                    </UiButton>
                    <UiButton size="xs" variant="subtle" icon="i-carbon-checkmark" @click="openId = null">
                      Done
                    </UiButton>
                  </div>
                </div>
              </div>
            </div>
          </Transition>
        </div>
      </TransitionGroup>

      <p v-if="missingTemplates.length && rules.length" class="hint">
        Deleted a starter? <b class="text-fg-muted font-medium">Starters</b> above adds it back.
      </p>
    </UiSection>

    <!-- ─── Limits ─────────────────────────────────────────────────────────── -->
    <UiSection title="Limits" icon="i-carbon-meter" :summary="`${config.maxPerMinute} a minute`" collapsible>
      <UiSlider
        v-model="config.maxPerMinute"
        label="Most firings a minute"
        :min="1"
        :max="MAX_PER_MINUTE_LIMIT"
        :step="1"
        hint="Across all rules together, so two rules that set each other off cannot run away. Each rule also waits out its own cooldown, and never answers what it caused itself."
      />
    </UiSection>

    <!-- ─── Log ────────────────────────────────────────────────────────────── -->
    <UiSection title="What fired" icon="i-carbon-catalog" :summary="log.length ? `last ${log.length}` : 'nothing yet'" collapsible>
      <template v-if="log.length" #actions>
        <UiButton size="xs" variant="ghost" icon="i-carbon-erase" @click="clearLog">
          Clear
        </UiButton>
      </template>
      <p v-if="!log.length" class="hint">
        Each time a rule fires, it shows here with the reason and what it did. Kept until the app closes.
      </p>
      <ol v-else class="flex flex-col gap-1">
        <li v-for="(e, i) in log" :key="`${e.at}-${i}`" class="px-2 py-1.5 rounded-[var(--radius-sm)] flex gap-2 items-start hover:bg-fg/4">
          <span
            class="mt-1.5 rounded-full shrink-0 h-1.5 w-1.5"
            :class="e.tone === 'ok' ? 'bg-ok' : e.tone === 'warn' ? 'bg-warn' : 'bg-fg/30'"
          />
          <div class="flex flex-1 flex-col min-w-0">
            <div class="flex gap-2 items-baseline">
              <span class="text-[12px] text-fg font-medium flex-1 truncate">{{ e.name }}</span>
              <span class="text-[10.5px] text-fg-faint num shrink-0">{{ clock(e.at) }}</span>
            </div>
            <span class="text-[11px] text-fg-muted">{{ e.reason }}</span>
            <span class="text-[11px] text-fg-faint">→ {{ e.did }}</span>
          </div>
        </li>
      </ol>
    </UiSection>
  </UiPanel>
</template>
