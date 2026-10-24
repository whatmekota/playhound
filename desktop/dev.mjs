/* eslint-disable no-console, antfu/no-top-level-await -- a launcher script run from a terminal */
import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { createServer } from 'vite'
import { ensureIcons } from './icons.mjs'
import { probe } from './serve.mjs'

/**
 * `pnpm app`: the desktop app against the Vite dev server, with HMR.
 *
 * Starts Vite on :6969 (or reuses one already running there, e.g. from
 * `pnpm dev` or start.bat), then Electron with PH_DEV set. Closing the window
 * stops both. Changes under src/ hot-reload; changes under desktop/ need the
 * app restarting.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const url = 'http://localhost:6969'

ensureIcons(root, fileURLToPath(new URL('../.desktop/icons', import.meta.url)))

let vite = null
const running = await probe(url)
if (running === 'vite') {
  console.log(`[app] reusing the dev server already on ${url}`)
}
else if (running === 'built') {
  console.error(`[app] the built desktop app (or a production server) is holding ${url}. Close it first.`)
  process.exit(1)
}
else {
  vite = await createServer({ root, server: { host: true, port: 6969, strictPort: true } })
  await vite.listen()
  vite.printUrls()
}

const env = { ...process.env, PH_DEV: '1', PH_DEV_URL: url }
// Set by some editors' terminals; it would make electron.exe behave as plain node.
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['.'], { cwd: root, env, stdio: 'inherit' })

async function shutdown(code) {
  await vite?.close()
  process.exit(code)
}
child.on('exit', code => void shutdown(code ?? 0))
process.on('SIGINT', () => child.kill())
process.on('SIGTERM', () => child.kill())
