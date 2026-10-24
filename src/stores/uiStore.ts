import type { FloatingId, InspectorId, ViewId } from '~/lib/views'
/**
 * Shell state: which view owns the stage, which inspectors are open, which
 * floating windows and dialogs are up. Persisted, so a reload comes back to
 * the same layout.
 *
 * Components never reach into the shell's template; they call these actions
 * (`ui.openView('library')`, `ui.openInspector('device')`) instead.
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { findView } from '~/lib/views'

const LS_KEY = 'ph:ui.shell'

interface Persisted {
  view?: ViewId
  inspector?: InspectorId | null
  pinned?: InspectorId | null
  drawerWidth?: number
  pinnedHeight?: number
  floating?: FloatingId[]
  navExpanded?: boolean
}

function load(): Persisted {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') }
  catch { return {} }
}

export const DRAWER_MIN = 280
export const DRAWER_MAX = 640

export const useUiStore = defineStore('ui', () => {
  const saved = load()
  const validView = (id: unknown): id is ViewId => typeof id === 'string' && findView(id as ViewId)?.kind === 'view'
  const validInspector = (id: unknown): id is InspectorId => typeof id === 'string' && findView(id as InspectorId)?.kind === 'inspector'

  /** What the main stage shows. */
  const view = ref<ViewId>(validView(saved.view) ? saved.view : 'player')
  /** The view before the current one, for "back". */
  const previousView = ref<ViewId>('library')
  /** Active inspector in the right drawer (null = drawer closed). */
  const inspector = ref<InspectorId | null>(validInspector(saved.inspector) ? saved.inspector : null)
  /** Inspector pinned above the active one. */
  const pinned = ref<InspectorId | null>(validInspector(saved.pinned) ? saved.pinned : null)
  const drawerWidth = ref(Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, saved.drawerWidth ?? 340)))
  /** Pinned inspector's share of the drawer height, in percent. */
  const pinnedHeight = ref(Math.max(20, Math.min(80, saved.pinnedHeight ?? 45)))
  const floating = ref<FloatingId[]>(Array.isArray(saved.floating) ? saved.floating.filter(f => f === 'emulator') : [])
  /** Left nav shows labels next to icons. */
  const navExpanded = ref(saved.navExpanded ?? false)

  // Transient UI — not persisted.
  const paletteOpen = ref(false)
  const shortcutsOpen = ref(false)
  const settingsOpen = ref(false)
  /** A file is being dragged over the window. */
  const dragging = ref(false)

  const drawerOpen = computed(() => inspector.value !== null || pinned.value !== null)
  /** The player is on stage; anywhere else it shrinks to the mini player. */
  const onPlayer = computed(() => view.value === 'player')

  function openView(id: ViewId) {
    if (view.value !== id)
      previousView.value = view.value
    view.value = id
  }

  /** Toggle between the player and whatever was open before it. */
  function togglePlayerView() {
    openView(view.value === 'player' ? previousView.value : 'player')
  }

  /** Open an inspector; clicking the open one again closes it. */
  function toggleInspector(id: InspectorId) {
    if (pinned.value === id) {
      // Clicking the pinned one's icon focuses it as the active panel.
      pinned.value = null
      inspector.value = id
      return
    }
    inspector.value = inspector.value === id ? null : id
  }

  function openInspector(id: InspectorId) {
    if (pinned.value === id)
      return
    inspector.value = id
  }

  function closeInspector(id?: InspectorId) {
    if (!id || inspector.value === id)
      inspector.value = null
    if (id && pinned.value === id)
      pinned.value = null
  }

  function togglePin(id: InspectorId) {
    if (pinned.value === id) {
      pinned.value = null
      inspector.value ??= id
      return
    }
    pinned.value = id
    if (inspector.value === id)
      inspector.value = null
  }

  function toggleFloating(id: FloatingId) {
    const i = floating.value.indexOf(id)
    if (i >= 0)
      floating.value.splice(i, 1)
    else
      floating.value.push(id)
  }

  function isFloatingOpen(id: FloatingId) {
    return floating.value.includes(id)
  }

  /** Any registry id: views switch the stage, inspectors toggle, floating windows toggle. */
  function activate(id: ViewId | InspectorId | FloatingId) {
    const def = findView(id)
    if (!def)
      return
    if (def.kind === 'view')
      openView(id as ViewId)
    else if (def.kind === 'inspector')
      toggleInspector(id as InspectorId)
    else
      toggleFloating(id as FloatingId)
  }

  watch(
    [view, inspector, pinned, drawerWidth, pinnedHeight, floating, navExpanded],
    () => {
      const p: Persisted = {
        view: view.value,
        inspector: inspector.value,
        pinned: pinned.value,
        drawerWidth: drawerWidth.value,
        pinnedHeight: pinnedHeight.value,
        floating: floating.value,
        navExpanded: navExpanded.value,
      }
      localStorage.setItem(LS_KEY, JSON.stringify(p))
    },
    { deep: true },
  )

  return {
    view,
    previousView,
    inspector,
    pinned,
    drawerWidth,
    pinnedHeight,
    floating,
    navExpanded,
    paletteOpen,
    shortcutsOpen,
    settingsOpen,
    dragging,
    drawerOpen,
    onPlayer,
    openView,
    togglePlayerView,
    toggleInspector,
    openInspector,
    closeInspector,
    togglePin,
    toggleFloating,
    isFloatingOpen,
    activate,
  }
})
