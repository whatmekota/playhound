import type { Ref } from 'vue'
import type { VideoEntry } from '~/stores/libraryStore'
import { useLocalStorage } from '@vueuse/core'
import { computed, ref } from 'vue'
import { KEYS } from '~/lib/persist'
import { shownTags, tagCounts } from '~/lib/tags'
import { useLibraryStore } from '~/stores/libraryStore'
import { useUiStore } from '~/stores/uiStore'
import { useScriptSummaries } from './useScriptSummaries'

let showAutoRef: Ref<boolean> | null = null

/**
 * Settings → Library: whether automatic tags are shown. Hidden, they leave
 * cards, rows and the tag pickers, but `tag:` searches and smart playlists
 * that already name one keep working, so nothing changes under anyone's feet.
 */
export function useShowAutoTags(): Ref<boolean> {
  return (showAutoRef ??= useLocalStorage(KEYS.autoTags.key, true))
}

/**
 * A tag something outside the library (the command palette) wants it
 * filtered by. The Library view picks it up and clears it, whether it was
 * open already or is about to be.
 */
export const tagFilterRequest = ref<string | null>(null)

export function filterLibraryByTag(tag: string) {
  tagFilterRequest.value = tag
  useUiStore().openView('library')
}

/** Tags across the library, and the ones to show for one video. */
export function useLibraryTags() {
  const library = useLibraryStore()
  const scripts = useScriptSummaries()
  const showAuto = useShowAutoTags()

  /**
   * Every tag with its count. Lazy: only a list that is on screen pays for
   * it, and it follows analyses at the throttled pace, not one by one.
   */
  const all = computed(() => {
    void scripts.settledCount.value
    return tagCounts(library.videos, { auto: showAuto.value, summaryOf: scripts.peek })
  })

  /** Tags given by hand anywhere in the library, for autocomplete. */
  const manualNames = computed(() => tagCounts(library.videos, { auto: false }).map(t => t.tag))

  /** For a card or row: manual first, then automatic (only those a card has no other mark for, with `onCardOnly`). */
  function shown(entry: VideoEntry, onCardOnly = false) {
    return shownTags(entry, scripts.summaryOf(entry), { auto: showAuto.value, onCardOnly })
  }

  return { showAuto, all, manualNames, shown }
}
