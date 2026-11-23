<script setup lang="ts">
import type { SetupStep } from './steps'
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiModal from '~/components/ui/UiModal.vue'
import { useCompactLayout } from '~/composables/useCompactLayout'
import { markSetupDone, nextStep, prevStep, stepsHere } from '~/lib/setup'
import { useLibraryStore } from '~/stores/libraryStore'
import { useUiStore } from '~/stores/uiStore'
import { resetSetupRun } from './run'
import { SETUP_STEPS } from './steps'

/**
 * The first-run setup: a few questions, one at a time, each skippable. Shown
 * on a fresh install's first start (lib/setup.ts decides which that is) and
 * from Settings → Startup. Closed any way at all, finished, skipped or with
 * the cross, it is done and never comes back by itself.
 *
 * The steps are SETUP_STEPS (steps.ts); this is the frame round them: where
 * you are, Back, Skip and Next, and a summary at the end.
 */
const ui = useUiStore()
const library = useLibraryStore()
const compact = useCompactLayout()

interface StepHandle {
  /** False keeps the setup on the step: something in it wants another look (a plugin that failed). */
  commit?: () => void | boolean | Promise<void | boolean>
  primary?: string
  busy?: boolean
  /** False: nothing to go on with yet (no device connected), so Skip is the way on. */
  ready?: boolean
}

const current = shallowRef<SetupStep | null>(null)
/** Past the last step: the summary. */
const finished = ref(false)
/** Steps left with Next (or answered in the step itself); the rest were skipped. */
const answered = reactive(new Set<string>())
const stepEl = ref<StepHandle | null>(null)
const committing = ref(false)

function restart() {
  resetSetupRun()
  answered.clear()
  finished.value = false
  current.value = nextStep(SETUP_STEPS, null)
}
restart()
// Run again from Settings: from the start.
watch(() => ui.setupOpen, (open) => {
  if (open)
    restart()
  else
    markSetupDone()
})

const here = computed(() => stepsHere(SETUP_STEPS))
const position = computed(() => (current.value ? here.value.findIndex(s => s.id === current.value!.id) : here.value.length))
const busy = computed(() => committing.value || !!stepEl.value?.busy)
const last = computed(() => !!current.value && !nextStep(SETUP_STEPS, current.value.id))
const canGoBack = computed(() => finished.value ? here.value.length > 0 : !!current.value && !!prevStep(SETUP_STEPS, current.value.id))
const primary = computed(() => stepEl.value?.primary ?? (last.value ? 'Finish' : 'Next'))
const ready = computed(() => stepEl.value?.ready ?? true)

function go(step: SetupStep | null) {
  current.value = step
  finished.value = !step
}

async function next() {
  const step = current.value
  if (busy.value || !step)
    return
  committing.value = true
  try {
    if (await stepEl.value?.commit?.() === false)
      return
  }
  catch (err) {
    // The step says what went wrong itself; staying put lets it be fixed.
    console.error('[setup]', step.id, err)
    return
  }
  finally {
    committing.value = false
  }
  advance()
}

/** On to the next step, this one answered: after Next, or a choice in the step that says so ("No device yet"). */
function advance() {
  const step = current.value
  if (!step)
    return
  answered.add(step.id)
  go(nextStep(SETUP_STEPS, step.id))
}

/** On, leaving this step's setting as it was. */
function skip() {
  const step = current.value
  if (busy.value || !step)
    return
  go(nextStep(SETUP_STEPS, step.id))
}

function back() {
  if (busy.value)
    return
  if (finished.value)
    go(here.value.at(-1) ?? null)
  else if (current.value)
    go(prevStep(SETUP_STEPS, current.value.id) ?? current.value)
}

/** Straight to a step from the bars at the top, as Skip leaves this one. */
function jump(step: SetupStep) {
  if (busy.value || step === current.value)
    return
  go(step)
}

function close() {
  if (!busy.value)
    ui.setupOpen = false
}

// ─── The end ─────────────────────────────────────────────────────────────────
const picking = ref(false)
async function openFolder() {
  picking.value = true
  try {
    if (await library.pickFolder()) {
      ui.setupOpen = false
      ui.openView('library')
    }
  }
  catch (err) {
    console.error('Folder pick failed:', err)
  }
  finally {
    picking.value = false
  }
}
</script>

<template>
  <UiModal v-model:open="ui.setupOpen" width="600px" persistent flush>
    <template #header>
      <div class="flex gap-3 items-start">
        <div class="flex flex-1 flex-col gap-0.5 min-w-0">
          <h2 class="text-[16px] text-fg tracking-[-0.01em] font-semibold">
            Set up playhound
          </h2>
          <p class="text-[12.5px] text-fg-muted">
            Each step can be skipped, and all of it changed later in Settings.
          </p>
        </div>
        <button
          v-tip="'Close the setup'"
          type="button"
          class="text-fg-faint focusable rounded-[var(--radius-sm)] center shrink-0 h-7 w-7 hover:text-fg hover:bg-fg/8"
          aria-label="Close the setup"
          :disabled="busy"
          @click="close"
        >
          <span class="i-carbon-close text-[16px]" />
        </button>
      </div>
    </template>

    <div class="flex flex-col" :class="compact ? 'setup-body-phone' : 'h-[min(540px,64vh)]'">
      <!-- Where you are: one bar per step that applies here -->
      <nav class="px-5 pb-3 flex shrink-0 gap-1.5" aria-label="Setup steps">
        <button
          v-for="(s, i) in here"
          :key="s.id"
          type="button"
          class="group py-1 text-left focusable rounded-[var(--radius-xs)] flex flex-1 flex-col gap-1.5 min-w-0"
          :aria-current="current?.id === s.id ? 'step' : undefined"
          :aria-label="`${s.title}${answered.has(s.id) ? ', done' : ''}`"
          :disabled="busy"
          @click="jump(s)"
        >
          <span
            class="rounded-full h-1 w-full transition-colors duration-300"
            :class="i === position ? 'bg-accent' : answered.has(s.id) ? 'bg-accent/50' : i < position ? 'bg-fg/20' : 'bg-surface-700 group-hover:bg-surface-600'"
          />
          <span
            v-if="!compact"
            class="text-[11px] truncate transition-colors"
            :class="i === position ? 'text-fg font-medium' : 'text-fg-faint group-hover:text-fg-muted'"
          >{{ s.title }}</span>
        </button>
      </nav>

      <div class="px-5 pb-5 pt-1 scroll-y flex-1 min-h-0">
        <Transition name="t-view" mode="out-in">
          <div v-if="current" :key="current.id" class="flex flex-col gap-4">
            <header class="flex gap-3 items-center">
              <span class="text-accent-300 rounded-[var(--radius-md)] bg-accent-soft center shrink-0 h-10 w-10">
                <span :class="current.icon" class="text-[19px]" />
              </span>
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="eyebrow">Step {{ position + 1 }} of {{ here.length }}</span>
                <h3 class="text-[15px] text-fg tracking-[-0.01em] font-semibold m-0">
                  {{ current.title }}
                </h3>
              </div>
            </header>
            <p class="text-[13px] text-fg-muted leading-relaxed m-0">
              {{ current.lede }}
            </p>
            <component :is="current.component" ref="stepEl" @next="advance" />
          </div>

          <!-- The end: what is set now -->
          <div v-else key="done" class="flex flex-col gap-4">
            <header class="flex gap-3 items-center">
              <span class="text-ok rounded-[var(--radius-md)] bg-ok/12 center shrink-0 h-10 w-10">
                <span class="i-carbon-checkmark-outline text-[20px]" />
              </span>
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="eyebrow">Done</span>
                <h3 class="text-[15px] text-fg tracking-[-0.01em] font-semibold m-0">
                  You're set
                </h3>
              </div>
            </header>
            <ul class="m-0 p-0 list-none card">
              <li v-for="s in here" :key="s.id" class="px-3.5 py-2.5 border-t border-edge flex gap-3 items-center first:border-t-0">
                <span :class="s.icon" class="text-[16px] text-fg-muted shrink-0" />
                <span class="text-[13px] text-fg shrink-0 w-24">{{ s.title }}</span>
                <span class="text-[12.5px] text-fg-muted flex-1 min-w-0 truncate">{{ s.summary() }}</span>
                <span v-if="!answered.has(s.id)" class="text-[11px] text-fg-faint shrink-0">Skipped</span>
              </li>
            </ul>
            <p class="hint m-0">
              All of it is in Settings, and your device in the Device panel. Settings → Startup runs this again.
            </p>
            <div v-if="!library.hasVideos && !library.savedFolderName" class="p-4 card flex flex-col gap-3">
              <div class="flex flex-col gap-0.5">
                <span class="text-[13px] text-fg font-medium">Next: your videos</span>
                <span class="hint">Open a folder and playhound pairs each video with its scripts.</span>
              </div>
              <UiButton variant="primary" icon="i-carbon-folder-add" class="self-start" :loading="picking" @click="openFolder">
                Open a folder
              </UiButton>
            </div>
          </div>
        </Transition>
      </div>
    </div>

    <template #footer>
      <UiButton v-if="canGoBack" variant="ghost" icon="i-carbon-arrow-left" class="mr-auto" :disabled="busy" @click="back">
        Back
      </UiButton>
      <template v-if="current">
        <UiButton :variant="ready ? 'ghost' : 'secondary'" :icon-right="ready ? undefined : 'i-carbon-arrow-right'" :disabled="busy" @click="skip">
          Skip
        </UiButton>
        <UiButton v-if="ready" variant="primary" :icon-right="last ? undefined : 'i-carbon-arrow-right'" :loading="busy" @click="next">
          {{ primary }}
        </UiButton>
      </template>
      <UiButton v-else variant="primary" icon="i-carbon-checkmark" @click="close">
        Done
      </UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
/* A phone: the whole screen, less the title and the buttons. */
.setup-body-phone {
  height: calc(100dvh - 132px);
}
</style>
