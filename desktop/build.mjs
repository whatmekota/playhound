/* eslint-disable no-console, antfu/no-top-level-await, no-template-curly-in-string -- a build script: its log is the interface, and ${version} is electron-builder's macro, not ours */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Arch, build as builder, Platform } from 'electron-builder'
import { build as vite } from 'vite'
import { makeIcons } from './icons.mjs'

/**
 * `pnpm app:build` (after `vite build`): package the desktop app for Windows.
 *
 *   .desktop/icons   icon.png / icon.ico rendered from public/favicon.svg
 *   .desktop/app     what goes into app.asar: dist/, the bundled main process,
 *                    the preload and a package.json with no dependencies
 *   release/         NSIS installer, portable .exe and win-unpacked/
 *
 * The main process (plus es-proxy.mjs and ws) is bundled into one file, so the
 * package carries no node_modules at all — the renderer's dependencies are
 * already inside dist/, and electron-builder never has to make sense of the
 * pnpm tree. `--dir` skips the installers and only produces win-unpacked/.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const r = (...p) => path.join(root, ...p)
const dirOnly = process.argv.includes('--dir')

if (!fs.existsSync(r('dist', 'index.html'))) {
  console.error('[app:build] dist/ is missing — run vite build first (pnpm app:build does both).')
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync(r('package.json'), 'utf8'))
const electronVersion = JSON.parse(fs.readFileSync(r('node_modules', 'electron', 'package.json'), 'utf8')).version
const stage = r('.desktop', 'app')

// ── Stage ────────────────────────────────────────────────────────────────────

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(path.join(stage, 'desktop'), { recursive: true })

fs.cpSync(r('dist'), path.join(stage, 'dist'), { recursive: true })
fs.copyFileSync(r('desktop', 'preload.cjs'), path.join(stage, 'desktop', 'preload.cjs'))

const icons = makeIcons(root, r('.desktop', 'icons'))
fs.copyFileSync(icons.png, path.join(stage, 'desktop', 'icon.png'))

console.log('[app:build] bundling the main process')
await vite({
  configFile: false,
  root,
  publicDir: false,
  logLevel: 'warn',
  build: {
    // Lands at desktop/main.mjs inside the package, the same place it sits in
    // the repo, so paths resolved from import.meta.url hold in both.
    ssr: r('desktop', 'main.mjs'),
    outDir: path.join(stage, 'desktop'),
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    reportCompressedSize: false,
    rollupOptions: {
      external: ['electron'],
      output: { format: 'es', entryFileNames: 'main.mjs' },
    },
    commonjsOptions: {
      // ws tries these optional native speed-ups inside a try/catch. Leaving
      // the require() alone keeps that try/catch doing its job.
      ignore: ['bufferutil', 'utf-8-validate'],
    },
  },
  ssr: { noExternal: true, target: 'node' },
})

fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({
  name: pkg.name,
  productName: 'playhound',
  version: pkg.version,
  description: pkg.description,
  author: 'playhound',
  private: true,
  type: 'module',
  main: 'desktop/main.mjs',
}, null, 2)}\n`)

// ── Package ──────────────────────────────────────────────────────────────────

console.log(`[app:build] packaging with Electron ${electronVersion}${dirOnly ? ' (unpacked only)' : ''}`)
const artifacts = await builder({
  projectDir: root,
  targets: Platform.WINDOWS.createTarget(dirOnly ? ['dir'] : ['nsis', 'portable'], Arch.x64),
  config: {
    appId: 'local.playhound',
    productName: 'playhound',
    copyright: 'personal use',
    electronVersion,
    directories: {
      app: stage,
      output: r('release'),
      buildResources: r('.desktop', 'icons'),
    },
    // The staged app has no dependencies, but finding no node_modules there,
    // electron-builder falls back to the repo root and would pack the
    // renderer's (already bundled) dependency tree into the asar.
    files: ['**/*', '!**/node_modules/**'],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    publish: null,
    win: {
      icon: icons.ico,
      // Unsigned: a personal build. SmartScreen will ask once on first run.
      signAndEditExecutable: true,
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      shortcutName: 'playhound',
      // The library, playlists and settings live in %APPDATA%\playhound;
      // uninstalling must not take them with it.
      deleteAppDataOnUninstall: false,
      artifactName: 'playhound-setup-${version}.${ext}',
    },
    portable: {
      artifactName: 'playhound-${version}-portable.${ext}',
    },
  },
})

for (const a of artifacts) {
  const size = fs.existsSync(a) ? `${(fs.statSync(a).size / 1048576).toFixed(1)} MB` : ''
  console.log(`[app:build]   ${path.relative(root, a)}  ${size}`)
}
console.log(`[app:build]   ${path.relative(root, r('release', 'win-unpacked', 'playhound.exe'))}`)
