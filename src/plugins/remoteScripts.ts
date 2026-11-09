import type { ScriptMatch, VideoEntry } from '~/stores/libraryStore'
import { AXIS_MAP } from '~/lib/axisMap'
import { pluginFetch } from './net'
import { cleanActions } from './scripts'

/**
 * The scripts of a video a plugin added to the library, fetched when it is
 * first played (or followed in a headset) and kept on its entry, so they go
 * through the same parser as files next to a video. The source's chapters
 * ride along in the main script's metadata, where the player reads authors'
 * chapters from.
 */

const inflight = new WeakMap<VideoEntry, Promise<ScriptMatch[]>>()

/** "default" → the stroke file, anything else → its suffix, as a library folder would name them. */
function fileName(entry: VideoEntry, axis: string): string {
  const base = entry.basename.replace(/[\\/:*?"<>|]/g, '_')
  return AXIS_MAP[axis]?.channel === 'L0' ? `${base}.funscript` : `${base}.${axis}.funscript`
}

async function fetchScript(url: string, headers: Record<string, string> | undefined): Promise<Record<string, unknown>> {
  const res = await pluginFetch(url, { headers })
  if (!res.ok)
    throw new Error(`${new URL(url).host} answered ${res.status}`)
  const json = await res.json()
  if (!json || typeof json !== 'object' || !Array.isArray(json.actions))
    throw new Error('not a funscript')
  return json
}

/**
 * The entry's scripts as library matches, fetching them the first time. A
 * script that fails is left out (and said in the console); the others play.
 */
export function remoteScriptMatches(entry: VideoEntry): Promise<ScriptMatch[]> {
  const r = entry.remote
  if (!r)
    return Promise.resolve(entry.scriptMatches)
  if (entry.scriptMatches.length)
    return Promise.resolve(entry.scriptMatches)
  let p = inflight.get(entry)
  if (p)
    return p
  p = (async () => {
    const scripts: { axis: string, json: Record<string, unknown> }[] = []
    if (r.scripts.length) {
      const got = await Promise.allSettled(r.scripts.map(async s => ({ axis: s.axis, json: await fetchScript(s.url, r.headers) })))
      for (const g of got) {
        if (g.status === 'fulfilled')
          scripts.push(g.value)
        else
          console.warn(`[plugins] ${r.label}: a script of "${entry.basename}" didn't load:`, g.reason)
      }
    }
    else if (r.loader) {
      try {
        for (const s of await r.loader())
          scripts.push({ axis: s.axis, json: { version: '1.0', actions: cleanActions(s.actions) } })
      }
      catch (err) {
        console.warn(`[plugins] ${r.label}: the scripts of "${entry.basename}" didn't load:`, err)
      }
    }
    const matches: ScriptMatch[] = scripts
      .filter(s => (s.json.actions as unknown[]).length)
      // The stroke first: it carries the chapters, and is the main script.
      .sort((a, b) => Number(AXIS_MAP[b.axis]?.channel === 'L0') - Number(AXIS_MAP[a.axis]?.channel === 'L0'))
      .map((s, i) => {
        let json = s.json
        // The source's chapters go with the main script, unless it has its own.
        if (i === 0 && r.chapters.length) {
          const meta = (json.metadata && typeof json.metadata === 'object' ? json.metadata : {}) as Record<string, unknown>
          if (!Array.isArray(meta.chapters) || !meta.chapters.length) {
            json = { ...json, metadata: { ...meta, chapters: r.chapters.map(c => ({ name: c.name, startTime: Math.round(c.start * 1000), ...(c.end ? { endTime: Math.round(c.end * 1000) } : {}) })) } }
          }
        }
        const name = fileName(entry, s.axis)
        // The axis is said outright: the entry's name isn't the files'.
        return { file: new File([JSON.stringify(json)], name, { type: 'application/json' }), isAlt: false, altName: '', suffix: s.axis }
      })
    entry.scriptMatches = matches
    entry.scriptFiles = matches.map(m => m.file)
    if (matches.length)
      entry.hasScript = true
    return matches
  })().finally(() => inflight.delete(entry))
  inflight.set(entry, p)
  return p
}
