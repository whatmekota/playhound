<script setup lang="ts">
import type { SourceState } from '~/stores/pluginStore'
import { computed, onMounted, ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import { toast } from '~/composables/useToast'
import { trustOf } from '~/plugins/sources'
import { usePluginStore } from '~/stores/pluginStore'

/**
 * Settings → Plugins → Get plugins: the GitHub repositories plugins come from,
 * their latest releases, and Install / Update for each. Nothing installs or
 * updates without a click.
 */
const emit = defineEmits<{ installed: [id: string] }>()
const store = usePluginStore()
const checking = ref(false)
const busy = ref<string | null>(null)
const adding = ref(false)
const newRepo = ref('')

/** What the marks next to a plugin's name mean. */
const TRUST_TIP = {
  official: 'Official: made by playhound\'s author',
  trusted: 'Trusted author: known to playhound',
}

const rows = computed(() => store.sourceList.map(repo => store.sources[repo] ?? { repo, status: 'idle', error: '', release: null } as SourceState))

async function check() {
  checking.value = true
  try {
    await store.checkSources()
  }
  finally {
    checking.value = false
  }
}
onMounted(() => void check())

async function get(s: SourceState) {
  busy.value = s.repo
  const was = store.installedFrom(s)
  try {
    const p = await store.installFromSource(s.repo)
    emit('installed', p.manifest.id)
    toast.success(was ? `Updated ${p.manifest.name} to ${p.manifest.version}` : `Installed ${p.manifest.name} ${p.manifest.version}`, {
      icon: 'i-carbon-application',
      detail: p.enabled ? undefined : 'Switch it on to use it',
    })
  }
  catch (err) {
    toast.error(`Couldn't get ${s.repo}`, { detail: err instanceof Error ? err.message : String(err) })
  }
  finally {
    busy.value = null
  }
}

async function add() {
  if (!newRepo.value.trim())
    return
  adding.value = true
  try {
    await store.addSource(newRepo.value)
    newRepo.value = ''
  }
  catch (err) {
    toast.error('Couldn\'t add that source', { detail: err instanceof Error ? err.message : String(err) })
  }
  finally {
    adding.value = false
  }
}

const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
</script>

<template>
  <div class="p-4 card flex flex-col gap-3">
    <div class="flex gap-2 items-center">
      <div class="flex flex-1 flex-col gap-0.5 min-w-0">
        <span class="text-[13.5px] text-fg font-medium">Get plugins</span>
        <span class="hint">The latest release of each GitHub repository below. Add any repository that publishes a plugin.</span>
      </div>
      <UiIconButton icon="i-carbon-renew" label="Check again" :disabled="checking" :class="checking && 'animate-spin'" @click="check" />
    </div>

    <div class="border border-edge rounded-[var(--radius-md)] flex flex-col">
      <div v-for="s in rows" :key="s.repo" class="px-3 py-2.5 border-t border-edge flex gap-3 items-center first:border-t-0">
        <div class="flex flex-1 flex-col gap-0.5 min-w-0">
          <div class="flex gap-2 min-w-0 items-baseline">
            <span class="text-[13px] text-fg font-medium truncate">{{ s.release?.manifest?.name ?? s.repo.split('/')[1] }}</span>
            <span
              v-if="trustOf(s.repo)"
              v-tip="TRUST_TIP[trustOf(s.repo)!]"
              class="text-[13px] shrink-0 self-center"
              :class="trustOf(s.repo) === 'official' ? 'i-carbon-checkmark-filled text-accent-300' : 'i-carbon-favorite-filled text-fg-muted'"
              :aria-label="trustOf(s.repo) === 'official' ? 'Official plugin' : 'Trusted author'"
            />
            <span v-if="s.release" class="text-[11.5px] text-fg-faint num shrink-0">{{ s.release.version }}</span>
            <a :href="`https://github.com/${s.repo}`" target="_blank" rel="noopener" class="text-[11px] text-fg-faint truncate hover:text-fg hover:underline">
              <span :class="trustOf(s.repo) === 'official' ? 'text-accent-300 font-medium' : trustOf(s.repo) === 'trusted' ? 'text-fg-muted font-medium' : ''">{{ s.repo.split('/')[0] }}</span>/{{ s.repo.split('/')[1] }}
            </a>
          </div>
          <span v-if="s.status === 'error'" class="text-[11.5px] text-danger">{{ s.error }}</span>
          <span v-else-if="s.status === 'checking' && !s.release" class="hint">Checking…</span>
          <span v-else-if="s.release?.manifest?.description" class="hint line-clamp-2">{{ s.release.manifest.description }}</span>
        </div>
        <template v-if="s.release">
          <UiButton
            v-if="!store.installedFrom(s)"
            variant="primary"
            icon="i-carbon-download"
            :loading="busy === s.repo"
            :disabled="!!busy"
            @click="get(s)"
          >
            Install · {{ mb(s.release.zipSize) }}
          </UiButton>
          <UiButton
            v-else-if="store.updateFor(s)"
            variant="primary"
            icon="i-carbon-upgrade"
            :loading="busy === s.repo"
            :disabled="!!busy"
            @click="get(s)"
          >
            Update to {{ s.release.version }}
          </UiButton>
          <span v-else class="text-[12px] text-ok flex shrink-0 gap-1 items-center">
            <span class="i-carbon-checkmark text-[14px]" /> Installed
          </span>
        </template>
        <UiIconButton icon="i-carbon-close" label="Stop following this repository" size="xs" @click="store.removeSource(s.repo)" />
      </div>
      <p v-if="!rows.length" class="hint m-0 px-3 py-2.5">
        No sources. Add a repository below.
      </p>
    </div>

    <form class="flex gap-2 items-center" @submit.prevent="add">
      <UiInput v-model="newRepo" class="flex-1" placeholder="owner/repo or a github.com link" size="sm" icon="i-carbon-logo-github" />
      <UiButton type="submit" icon="i-carbon-add" :loading="adding">
        Add
      </UiButton>
    </form>
  </div>
</template>
