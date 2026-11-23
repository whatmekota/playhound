<script setup lang="ts">
import type { StoreEntry } from '~/plugins/storeEntry'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import PluginIcon from '~/components/plugins/PluginIcon.vue'
import PluginPermissions from '~/components/plugins/PluginPermissions.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiSpinner from '~/components/ui/UiSpinner.vue'
import { DEFAULT_SOURCES } from '~/plugins/sources'
import { buildEntries, iconRef } from '~/plugins/storeEntry'
import { usePluginStore } from '~/stores/pluginStore'
import { setupRun } from './run'

/**
 * The setup's plugins step: playhound's own plugins, each with one line and
 * a box to tick. Ticked ones install through the store, as Settings →
 * Plugins does, and are switched on. What each may do shows by its box once
 * ticked, which is the store's install question asked here: it is not asked
 * again unless the download wants more. One that can't run here (the Android
 * app refuses what needs the desktop) says so, as it does in the store.
 */
const store = usePluginStore()

/** Shown first; the rest of the official ones are under "More". */
const FIRST = ['whatmekota/phthreads', 'whatmekota/phsounds', 'whatmekota/phbeatbar', 'whatmekota/phvr', 'whatmekota/phstash']
/** A name and one line each, for before (or without) the store's listing. */
const ABOUT: Record<string, { name: string, line: string }> = {
  'whatmekota/phthreads': { name: 'Threads', line: 'Finds your videos\' EroScripts threads: their tags, and newer scripts.' },
  'whatmekota/phsounds': { name: 'Stroke sounds', line: 'Sex sounds in time with each stroke, for silent videos and motion.' },
  'whatmekota/phbeatbar': { name: 'Beat bar', line: 'A Cock Hero style beat bar over the video, to follow by hand.' },
  'whatmekota/phvr': { name: 'VR headset', line: 'Drives your device from a video playing in HereSphere or DeoVR.' },
  'whatmekota/phstash': { name: 'Stash', line: 'Your Stash scenes with scripts, streamed into the library.' },
  'whatmekota/playmate': { name: 'playmate', line: 'An AI partner that talks to you and drives the stroker.' },
  'whatmekota/ph2gether': { name: 'ph2gether', line: 'Watch and play in sync with a partner over the internet.' },
  'whatmekota/phbrowser': { name: 'Browser', line: 'A web browser on playhound\'s stage, with the motion still going.' },
  'whatmekota/phpmv': { name: 'PMV maker', line: 'PMVs cut on the beat from your own scripted videos.' },
  'whatmekota/phgacha': { name: 'Gacha', line: 'Pulls your next video by rarity, with a random twist on top.' },
}

const entries = computed(() => buildEntries(store.sourceList, store.sources, store.plugins))
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

type State = 'checking' | 'ready' | 'installed' | 'blocked' | 'unreachable'
interface Row {
  repo: string
  name: string
  line: string
  entry: StoreEntry | null
  state: State
  why: string
}

function rowOf(repo: string): Row {
  const entry = entries.value.find(e => e.repo && sameRepo(e.repo, repo)) ?? null
  const about = ABOUT[repo]
  const base = { repo, name: entry?.manifest?.name ?? about?.name ?? repo.split('/')[1], line: about?.line ?? entry?.description ?? '', entry }
  if (entry?.installed)
    return { ...base, state: 'installed', why: '' }
  if (entry?.problem)
    return { ...base, state: 'blocked', why: entry.problem }
  if (entry?.release)
    return { ...base, state: 'ready', why: '' }
  const src = entry?.source
  if (src?.status === 'error')
    return { ...base, state: 'unreachable', why: src.error }
  return { ...base, state: 'checking', why: '' }
}

// Only sources still followed: one removed in the store was removed on purpose.
const rows = computed(() => DEFAULT_SOURCES.filter(r => store.sourceList.some(s => sameRepo(s, r))).map(rowOf))
const first = computed(() => FIRST.map(repo => rows.value.find(r => r.repo === repo)).filter((r): r is Row => !!r))
const more = computed(() => rows.value.filter(r => !FIRST.includes(r.repo)))
const showMore = ref(false)
const anyUnreachable = computed(() => rows.value.some(r => r.state === 'unreachable'))

const picked = reactive(new Set<string>())
const installing = ref(false)
function toggle(r: Row) {
  if (r.state !== 'ready' || installing.value)
    return
  if (!picked.delete(r.repo))
    picked.add(r.repo)
}

// What the store has seen shows at once; GitHub is asked when that is old or missing.
onMounted(() => void store.refreshSources().catch(() => {}))
const retrying = ref(false)
async function retry() {
  retrying.value = true
  try {
    await store.checkSources()
  }
  catch {}
  finally {
    retrying.value = false
  }
}

// ─── Installing ──────────────────────────────────────────────────────────────
type Progress = 'installing' | 'done' | 'declined' | 'failed'
const progress = reactive(new Map<string, Progress>())
const errors = reactive(new Map<string, string>())

// An install still waiting for a yes when the step goes says no, as the store's page does.
onBeforeUnmount(() => store.answerInstall(false))

/** One at a time, in the order shown. Stays on the step if one failed, to say which. */
async function commit(): Promise<boolean> {
  const todo = rows.value.filter(r => picked.has(r.repo) && r.state === 'ready')
  if (!todo.length)
    return true
  installing.value = true
  let failed = false
  try {
    for (const r of todo) {
      progress.set(r.repo, 'installing')
      errors.delete(r.repo)
      try {
        const p = await store.installFromSource(r.repo, r.entry?.release?.manifest ?? undefined)
        if (!p) {
          progress.set(r.repo, 'declined')
          picked.delete(r.repo)
          continue
        }
        if (!p.enabled)
          await store.setEnabled(p.manifest.id, true)
        setupRun.installed.push(p.manifest.name)
        progress.set(r.repo, 'done')
        picked.delete(r.repo)
      }
      catch (err) {
        failed = true
        progress.set(r.repo, 'failed')
        errors.set(r.repo, err instanceof Error ? err.message : String(err))
      }
    }
  }
  finally {
    installing.value = false
  }
  return !failed
}

const primary = computed(() => {
  const n = rows.value.filter(r => picked.has(r.repo) && r.state === 'ready').length
  return n ? `Install ${n}` : undefined
})

defineExpose({ commit, primary, busy: installing })
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- A download that asks for more than its listing said: the store's question, here -->
    <div v-if="store.pendingInstall" class="p-4 card flex flex-col gap-3 ring-1 ring-accent/50" role="group" aria-label="Confirm install">
      <div class="flex flex-col gap-0.5">
        <span class="text-[14px] text-fg font-medium">Install {{ store.pendingInstall.manifest.name }} {{ store.pendingInstall.manifest.version }}?</span>
        <span class="hint">The download asks for more than its listing said.</span>
      </div>
      <PluginPermissions :manifest="store.pendingInstall.manifest" />
      <div class="flex gap-2 justify-end">
        <UiButton @click="store.answerInstall(false)">
          Cancel
        </UiButton>
        <UiButton variant="primary" icon="i-carbon-download" @click="store.answerInstall(true)">
          Install
        </UiButton>
      </div>
    </div>

    <template v-for="group in [{ id: 'first', rows: first }, { id: 'more', rows: more }]" :key="group.id">
      <button
        v-if="group.id === 'more' && group.rows.length"
        type="button"
        class="text-[12px] text-fg-muted px-1 focusable rounded-[var(--radius-sm)] flex gap-1.5 h-7 transition-colors items-center hover:text-fg -mb-2"
        :aria-expanded="showMore"
        @click="showMore = !showMore"
      >
        <span class="i-carbon-chevron-right text-[11px] transition-transform duration-200" :class="showMore ? 'rotate-90' : ''" />
        More official plugins
        <span class="text-fg-faint num">{{ group.rows.length }}</span>
      </button>
      <ul v-if="group.rows.length && (group.id === 'first' || showMore)" class="m-0 p-0 list-none card">
        <li v-for="r in group.rows" :key="r.repo" class="border-t border-edge first:border-t-0">
          <button
            type="button"
            role="checkbox"
            :aria-checked="r.state === 'installed' || picked.has(r.repo)"
            :aria-disabled="r.state !== 'ready'"
            class="px-3 py-2.5 text-left focusable rounded-[var(--radius-lg)] flex gap-3 w-full transition-colors items-center"
            :class="r.state === 'ready' && !installing ? 'hover:bg-fg/3' : 'cursor-default'"
            @click="toggle(r)"
          >
            <span
              class="tick rounded center shrink-0 h-4 w-4"
              :class="[r.state === 'installed' || picked.has(r.repo) ? 'is-on' : '', r.state === 'ready' || r.state === 'installed' ? '' : 'opacity-40']"
            >
              <span v-if="r.state === 'installed' || picked.has(r.repo)" class="i-carbon-checkmark text-[11px]" />
            </span>
            <PluginIcon :id="r.entry?.id ?? r.repo.split('/')[1]" :name="r.name" :image="r.entry ? iconRef(r.entry, store.pluginFile) : null" official :size="34" />
            <span class="flex flex-1 flex-col gap-0.5 min-w-0">
              <span class="flex gap-2 min-w-0 items-center">
                <span class="text-[13px] text-fg font-medium truncate">{{ r.name }}</span>
                <span v-if="progress.get(r.repo) === 'installing'" class="text-[11px] text-fg-muted flex shrink-0 gap-1 items-center"><UiSpinner :size="11" /> Installing</span>
                <span v-else-if="r.state === 'installed'" class="text-[11px] text-ok font-medium flex shrink-0 gap-1 items-center"><span class="i-carbon-checkmark text-[12px]" /> Installed</span>
                <span v-else-if="progress.get(r.repo) === 'failed'" class="text-[11px] text-danger font-medium shrink-0">Failed</span>
                <span v-else-if="r.state === 'blocked'" class="text-[11px] text-warn font-medium shrink-0">{{ /needs the desktop app/.test(r.why) ? 'Needs the desktop app' : 'Can\'t install' }}</span>
                <span v-else-if="r.state === 'checking'" class="text-[11px] text-fg-faint shrink-0">Checking…</span>
                <span v-else-if="r.state === 'unreachable'" v-tip="r.why" class="text-[11px] text-fg-faint shrink-0">Not checked</span>
              </span>
              <span class="hint">{{ r.line }}</span>
            </span>
          </button>
          <div v-if="errors.get(r.repo)" class="text-[12px] text-danger px-3 pb-2.5 pl-10">
            {{ errors.get(r.repo) }}
          </div>
          <div v-else-if="picked.has(r.repo) && r.entry?.release?.manifest" class="px-3 pb-3 pl-10">
            <div class="p-2.5 well">
              <PluginPermissions :manifest="r.entry.release.manifest" />
            </div>
          </div>
        </li>
      </ul>
    </template>

    <div v-if="anyUnreachable" class="text-[12px] text-fg-muted flex gap-2 items-center">
      <span class="i-carbon-cloud-offline text-[15px] text-warn shrink-0" />
      <span class="flex-1 min-w-0">Some couldn't be checked: GitHub didn't answer. They're in Settings → Plugins later.</span>
      <UiButton size="xs" variant="ghost" icon="i-carbon-renew" :loading="retrying" @click="retry">
        Try again
      </UiButton>
    </div>

    <p class="hint m-0">
      Ticked ones are installed and switched on. A plugin runs inside playhound with what it lists, so these are
      playhound's own; Settings → Plugins has others and keeps them all up to date.
    </p>
  </div>
</template>

<style scoped>
.tick {
  box-shadow: inset 0 0 0 1.5px var(--border-strong);
}
.tick.is-on {
  background: var(--accent);
  color: var(--accent-contrast);
  box-shadow: none;
}
</style>
