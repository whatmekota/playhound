import type { PluginManifest, PluginPermission } from './types'
import { isAndroidApp } from '../lib/android/detect'
import { APP_VERSION, meetsMin, readStoreFields, shortVersion } from './storeMeta'

/**
 * Reading and checking a plugin's manifest.json, and what it may do.
 *
 * A manifest names the plugin API it was written for (`"api"`, a whole
 * number; none means 1) and, from API 2 on, the permissions it needs. A
 * plugin that asks for nothing gets only what can't touch the user's videos,
 * device or network: its own settings, panel, commands, toasts and storage.
 * Plugins written before permissions existed (no `permissions` field, API 1)
 * keep full access, and the app says so.
 *
 * Permissions are a promise the API holds the plugin to, not a sandbox: a
 * plugin still runs inside playhound and could reach past ctx. They let the
 * user see what a plugin means to do before it does it, and catch a plugin
 * that quietly starts doing more in an update.
 */

/**
 * The newest plugin API this playhound speaks. 3 added external playback,
 * network sockets, serving on the LAN, library sources and session control;
 * plugins written for 1 and 2 run as before.
 */
export const PLUGIN_API = 3

export interface PermissionInfo {
  id: PluginPermission
  /** What it lets the plugin do, as the install screen says it. */
  label: string
  /** Which parts of ctx it opens, for plugin authors. */
  api: string
}

/** Every permission, in the order the install screen lists them. */
export const PERMISSIONS: PermissionInfo[] = [
  { id: 'device', label: 'Move your device, and reshape scripts on their way to it', api: 'motion.take, motion.filter' },
  { id: 'scripts', label: 'Read the loaded scripts and load its own', api: 'scripts.*' },
  { id: 'player', label: 'See what is playing, where, the picture, and your edges and intensity', api: 'player.state, player.onChange, player.script, player.frame, player.clock, playback.onEnded, session.edgeState, session.onEdge, session.intensity.get / max / onChange' },
  { id: 'playback', label: 'Play, pause, seek and change the speed of videos', api: 'playback.play, pause, resume, playFingerprint, player.seek, player.setRate' },
  { id: 'library', label: 'Read your library: video names, stats and playlists', api: 'library.list, analyse, onChange, fingerprint, info' },
  { id: 'library-edit', label: 'Change your videos\' tags and source links', api: 'library.tag, library.setSource' },
  { id: 'network', label: 'Connect to servers through playhound', api: 'net.fetch' },
  { id: 'stage', label: 'Show its own page and draw over the video', api: 'ui.page, ui.openPage, ui.showStage, ui.overlay' },
  // Any site, including one made to look like something else: the pages
  // themselves can't reach playhound, but what they show is the plugin's pick.
  { id: 'web', label: 'Open web pages inside playhound', api: 'webview.create' },
  // API 3.
  { id: 'external', label: 'Follow a video playing in another app, such as a VR headset, and move your device with it', api: 'playback.external' },
  { id: 'session', label: 'Call edges, change the intensity and know when you finish', api: 'session.edge, endEdge, onFinish, intensity.set (and what player reads)' },
  { id: 'library-source', label: 'Add videos to your library from another app', api: 'library.provide' },
  { id: 'socket', label: 'Connect to apps and devices on your network', api: 'net.socket' },
  { id: 'serve', label: 'Share your library with devices on your network', api: 'http.serve, library.mediaUrl, library.scriptUrl' },
]

const KNOWN = new Set<string>(PERMISSIONS.map(p => p.id))
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

/** What a plugin may do: everything (written before permissions), or the listed ones. */
export type Access = { full: true } | { full: false, granted: ReadonlySet<PluginPermission> }

export function accessOf(m: Pick<PluginManifest, 'api' | 'permissions'>): Access {
  if (Array.isArray(m.permissions))
    return { full: false, granted: new Set(m.permissions) }
  // No list: an older plugin keeps the access it always had; one written
  // for API 2 that lists nothing asked for nothing.
  return (m.api ?? 1) < 2 ? { full: true } : { full: false, granted: new Set() }
}

/**
 * What "full access" covers: everything there was before plugins asked. A
 * plugin written then can't know the newer calls, and an update that starts
 * using them has to ask, like any other.
 */
const FULL_ACCESS = new Set<PluginPermission>(['device', 'scripts', 'player', 'playback', 'library', 'library-edit', 'network', 'stage', 'web'])

export function allows(access: Access, p: PluginPermission): boolean {
  return access.full ? FULL_ACCESS.has(p) : access.granted.has(p)
}

/** Permissions in `next` that `prev` did not have; an older plugin had them all. */
export function addedPermissions(prev: Access | null, next: Access): PluginPermission[] {
  const all = PERMISSIONS.map(p => p.id)
  const has = (a: Access) => all.filter(p => allows(a, p))
  if (!prev)
    return has(next)
  return has(next).filter(p => !allows(prev, p))
}

/**
 * Read a parsed manifest.json into a manifest, or throw saying what is wrong
 * with it, fit to show the user. `main` defaults to index.js.
 */
export function readManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('manifest.json is not an object')
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || !ID_RE.test(m.id))
    throw new Error('manifest.json: "id" must be lower-case letters, digits and dashes')
  if (typeof m.name !== 'string' || !m.name.trim())
    throw new Error('manifest.json: "name" is missing')
  if (typeof m.version !== 'string' || !m.version.trim())
    throw new Error('manifest.json: "version" is missing')
  if (m.main !== undefined && (typeof m.main !== 'string' || !m.main.trim()))
    throw new Error('manifest.json: "main" must be a file name')

  let api = 1
  if (m.api !== undefined) {
    if (typeof m.api !== 'number' || !Number.isInteger(m.api) || m.api < 1)
      throw new Error('manifest.json: "api" must be a whole number, 1 or more')
    if (m.api > PLUGIN_API)
      throw new Error(`This plugin needs a newer playhound: it is written for plugin API ${m.api}, and this version speaks ${PLUGIN_API}. Update playhound first.`)
    api = m.api
  }
  // The store's fields (icon, screenshots, category, …) never stop an install,
  // except a playhound too old for it.
  const store = readStoreFields(m).fields
  if (store.minPlayhound && !meetsMin(store.minPlayhound, APP_VERSION))
    throw new Error(`This plugin needs playhound ${shortVersion(store.minPlayhound)} or newer, and this is ${APP_VERSION}. Update playhound first.`)

  let permissions: PluginPermission[] | undefined
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions) || m.permissions.some(p => typeof p !== 'string'))
      throw new Error('manifest.json: "permissions" must be a list of names')
    const unknown = m.permissions.filter(p => !KNOWN.has(p))
    if (unknown.length)
      throw new Error(`manifest.json: unknown permission${unknown.length > 1 ? 's' : ''} ${unknown.map(p => `"${p}"`).join(', ')}. Known: ${[...KNOWN].join(', ')}`)
    // In the app's order, once each.
    permissions = PERMISSIONS.map(p => p.id).filter(p => (m.permissions as string[]).includes(p))
    const why = desktopOnlyReason(permissions)
    if (why)
      throw new Error(why)
  }

  return {
    id: m.id,
    name: m.name.trim(),
    version: m.version.trim(),
    description: typeof m.description === 'string' ? m.description : undefined,
    author: typeof m.author === 'string' ? m.author : undefined,
    main: typeof m.main === 'string' ? m.main.trim().replace(/^\.?\//, '') : 'index.js',
    api,
    ...(permissions ? { permissions } : {}),
    ...store,
  }
}

/** What only the desktop app can do: web views (Electron's), sockets and the LAN server (its main process). */
export const DESKTOP_ONLY_PERMISSIONS: readonly PluginPermission[] = ['web', 'socket', 'serve']

/**
 * Why a plugin that asks for these permissions can't run here, or null: in
 * the Android app, one that needs a desktop-only part is refused at install
 * (and shown so in the store) rather than failing once it runs.
 */
export function desktopOnlyReason(permissions: readonly string[] | undefined, android = isAndroidApp): string | null {
  if (!android || !permissions)
    return null
  const needs = PERMISSIONS.filter(p => DESKTOP_ONLY_PERMISSIONS.includes(p.id) && permissions.includes(p.id))
  if (!needs.length)
    return null
  return `This plugin needs the desktop app: it asks to ${needs.map(p => p.label.charAt(0).toLowerCase() + p.label.slice(1)).join(', and to ')}, which the Android app can't do.`
}

/** The error a call outside the plugin's permissions throws. */
export function permissionError(name: string, p: PluginPermission, call: string): Error {
  return new Error(`${name} can't use ${call}: its manifest doesn't ask for the "${p}" permission`)
}
