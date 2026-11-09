// Which paths the LAN server hands to plugins, kept apart from pluginhttp.mjs
// (which needs Electron) so tests can load it on their own.

/** Root paths headsets ask for on their own, which one serving plugin may take (see src/plugins/http.ts). */
export const ROOT_ALIASES = new Set(['deovr', 'heresphere'])
export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,47}$/

/** `/deovr…` → `/plugins/<owner>/deovr…` when a plugin holds that alias; the path unchanged otherwise. */
export function aliasPath(pathname, aliases) {
  const m = pathname.match(/^\/([a-z]+)(\/.*)?$/)
  if (!m || !aliases.has(m[1]))
    return pathname
  return `/plugins/${aliases.get(m[1])}/${m[1]}${m[2] ?? ''}`
}
