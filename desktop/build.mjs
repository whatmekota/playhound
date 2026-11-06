/* eslint-disable no-console, antfu/no-top-level-await, no-template-curly-in-string -- a build script: its log is the interface, and ${version} is electron-builder's macro, not ours */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Arch, build as builder, Platform } from 'electron-builder'
import { build as vite } from 'vite'
import { makeIcons } from './icons.mjs'

/**
 * `pnpm app:build` (after `vite build`): package the desktop app for the
 * platform it runs on — Windows here, macOS and Linux in CI
 * (.github/workflows/desktop-builds.yml). `--win`, `--mac` or `--linux` picks
 * one explicitly, as far as electron-builder can build it from this host.
 *
 *   .desktop/icons   icon.png / icon.ico / icon-1024.png from public/favicon.svg
 *   .desktop/app     what goes into app.asar: dist/, the bundled main process,
 *                    the preload and a package.json with no dependencies
 *   release/         Windows: NSIS installer, portable .exe, latest.yml (the
 *                    update feed: upload it with each release), win-unpacked/
 *                    macOS: .dmg and .zip for x64 and arm64, latest-mac.yml
 *                    Linux: x64 .AppImage, latest-linux.yml, linux-unpacked/
 *
 * The main process (plus es-proxy.mjs and ws) is bundled into one file, so the
 * package carries no node_modules at all — the renderer's dependencies are
 * already inside dist/, and electron-builder never has to make sense of the
 * pnpm tree. `--dir` skips the installers and only produces the unpacked app.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const r = (...p) => path.join(root, ...p)
const dirOnly = process.argv.includes('--dir')
const platform = ['win', 'mac', 'linux'].find(o => process.argv.includes(`--${o}`))
  ?? ({ darwin: 'mac', linux: 'linux' }[process.platform] || 'win')

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

const targets = {
  win: () => Platform.WINDOWS.createTarget(dirOnly ? ['dir'] : ['nsis', 'portable'], Arch.x64),
  // Separate x64 and arm64 builds rather than one universal app: each is half
  // the download, and the release page says which is which.
  mac: () => Platform.MAC.createTarget(dirOnly ? ['dir'] : ['dmg', 'zip'], Arch.x64, Arch.arm64),
  linux: () => Platform.LINUX.createTarget(dirOnly ? ['dir'] : ['AppImage'], Arch.x64),
}[platform]()

console.log(`[app:build] packaging for ${platform} with Electron ${electronVersion}${dirOnly ? ' (unpacked only)' : ''}`)
const artifacts = await builder({
  projectDir: root,
  targets,
  publish: 'never',
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
    // Updates come from GitHub Releases: this writes release/latest.yml (to
    // upload with each release; latest-mac.yml / latest-linux.yml in CI) and
    // app-update.yml into the app, which electron-updater reads. Nothing is
    // uploaded from here.
    publish: { provider: 'github', owner: 'whatmekota', repo: 'playhound', releaseType: 'release' },
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
    mac: {
      icon: icons.large,
      category: 'public.app-category.entertainment',
      darkModeSupport: true,
      // No Apple developer account, so no real signature and no notarising.
      // An ad-hoc signature still matters: Apple silicon will not run
      // unsigned code at all, and without one macOS calls the download
      // "damaged" instead of offering to open it anyway. Hardened runtime
      // would reject Electron's own frameworks under an ad-hoc signature.
      identity: '-',
      hardenedRuntime: false,
      notarize: false,
      // Without these macOS kills the app the moment it touches Bluetooth.
      extendInfo: {
        NSBluetoothAlwaysUsageDescription: 'playhound connects to the Bluetooth devices you pick: the Handy and heart-rate monitors.',
        NSBluetoothPeripheralUsageDescription: 'playhound connects to the Bluetooth devices you pick: the Handy and heart-rate monitors.',
        NSLocalNetworkUsageDescription: 'playhound serves its phone remote on your local network and talks to devices on it.',
      },
      artifactName: 'playhound-${version}-mac-${arch}.${ext}',
    },
    linux: {
      icon: icons.png,
      category: 'AudioVideo',
      executableName: 'playhound',
      synopsis: 'Funscript video player',
      artifactName: 'playhound-${version}-linux-${arch}.${ext}',
    },
  },
})

for (const a of artifacts) {
  const size = fs.existsSync(a) ? `${(fs.statSync(a).size / 1048576).toFixed(1)} MB` : ''
  console.log(`[app:build]   ${path.relative(root, a)}  ${size}`)
}
const unpacked = {
  win: ['win-unpacked/playhound.exe'],
  mac: ['mac/playhound.app', 'mac-arm64/playhound.app'],
  linux: ['linux-unpacked/playhound'],
}[platform]
for (const u of unpacked)
  console.log(`[app:build]   ${path.relative(root, r('release', ...u.split('/')))}`)
