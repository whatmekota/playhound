import type { StageView } from './types'
import type { ViewId } from '~/lib/views'
import { VIEW_GROUPS } from '~/lib/views'

/** playhound's own stage views, in nav order. */
export const BUILTIN_STAGE = VIEW_GROUPS.flatMap(g => g.items.map(i => i.id)) as Exclude<ViewId, 'plugin'>[]

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,47}$/

/** What the stage shows, in the plugin API's terms. */
export function stageOf(view: ViewId, pluginView: string | null): StageView {
  return view === 'plugin' ? `plugin:${pluginView ?? ''}` : view
}

/** Read a stage view a plugin asked for; null if there is no such thing. */
export function parseStage(v: unknown): { view: Exclude<ViewId, 'plugin'> } | { plugin: string } | null {
  if (typeof v !== 'string')
    return null
  if (v.startsWith('plugin:')) {
    const id = v.slice('plugin:'.length)
    return PLUGIN_ID.test(id) ? { plugin: id } : null
  }
  return (BUILTIN_STAGE as string[]).includes(v) ? { view: v as Exclude<ViewId, 'plugin'> } : null
}
