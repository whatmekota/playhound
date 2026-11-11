#!/usr/bin/env node
/* eslint-disable no-console -- a build script: its log is the interface */
/**
 * The Android app's build steps, for the npm scripts:
 *
 *   node android/run.mjs sync      vite build, then cap sync android
 *   node android/run.mjs apk       sync, then a debug APK (release/android/playhound-debug.apk)
 *   node android/run.mjs install   adb install -r that APK on the connected phone
 *   node android/run.mjs test      the plugins' JVM unit tests
 *
 * The toolchain lives in one folder (F:\tools\android, or PH_ANDROID_TOOLS),
 * and every tool's home and cache is pointed into it here, the same way
 * android/env.cmd does for a shell, so a build never writes to the user
 * profile (~/.gradle, ~/.android…). It refuses to run without that folder.
 *
 * CAP_SERVER_URL=http://<this PC's LAN address>:7140 with sync points the
 * app at a dev server (pnpm mobile:dev) for live reload instead.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const win = process.platform === 'win32'
const tools = process.env.PH_ANDROID_TOOLS || (win ? 'F:\\tools\\android' : path.join(root, '.android-tools'))
const tmp = process.env.PH_ANDROID_TMP || (win ? 'F:\\tools\\tmp\\mobile' : path.join(tools, 'tmp'))

function toolchainEnv() {
  const jdk = path.join(tools, 'jdk-21')
  const sdk = path.join(tools, 'sdk')
  if (!fs.existsSync(jdk) || !fs.existsSync(sdk)) {
    console.error(`No Android toolchain in ${tools} (expected jdk-21\\ and sdk\\). Set PH_ANDROID_TOOLS, or see "Android app" in README.md.`)
    process.exit(1)
  }
  const env = {
    ...process.env,
    JAVA_HOME: jdk,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    GRADLE_USER_HOME: path.join(tools, 'gradle'),
    ANDROID_USER_HOME: path.join(tools, 'user-home'),
    ANDROID_AVD_HOME: path.join(tools, 'user-home', 'avd'),
    JAVA_TOOL_OPTIONS: `-Duser.home=${path.join(tools, 'home')} -Djava.io.tmpdir=${tmp}`,
    APPDATA: path.join(tools, 'appdata'),
    TEMP: tmp,
    TMP: tmp,
    npm_config_cache: path.join(tmp, 'npm-cache'),
    CAPACITOR_TELEMETRY: 'false',
  }
  for (const d of [env.GRADLE_USER_HOME, env.ANDROID_AVD_HOME, path.join(tools, 'home'), env.APPDATA, tmp])
    fs.mkdirSync(d, { recursive: true })
  // Windows spells it Path; the copy above is a plain object, so match it.
  const PATH = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[PATH] = [path.join(jdk, 'bin'), path.join(sdk, 'platform-tools'), env[PATH]].join(path.delimiter)
  return env
}

function run(cmd, args, opts) {
  console.log(`> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: win, ...opts })
  if (r.status !== 0)
    process.exit(r.status ?? 1)
}

const apkOut = path.join(root, 'release', 'android', 'playhound-debug.apk')

/** A package's CLI, run with this Node: no pnpm (or anything else) needed on the PATH. */
function node(env, script, args) {
  run(process.execPath, [path.join(root, 'node_modules', ...script.split('/')), ...args], { cwd: root, env, shell: false })
}

function sync(env) {
  node(env, 'vite/bin/vite.js', ['build'])
  node(env, '@capacitor/cli/bin/capacitor', ['sync', 'android'])
}

function gradle(env, tasks) {
  // Gradle hands the PATH to its test JVMs as java.library.path, and a long
  // Windows PATH with spaces in it breaks their command line ("Could not find
  // or load main class Files\…"). Gradle needs nothing on it but Java.
  const PATH = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  const sys = process.env.SystemRoot || 'C:\\Windows'
  const short = win
    ? [path.join(env.JAVA_HOME, 'bin'), path.join(sys, 'System32'), sys, path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
    : env[PATH]
  // By its full path: a shell may be set not to look in the current folder.
  const gradlew = path.join(root, 'android', win ? 'gradlew.bat' : 'gradlew')
  run(gradlew, [...tasks, '--console=plain'], { cwd: path.join(root, 'android'), env: { ...env, [PATH]: short } })
}

const step = process.argv[2]
const env = toolchainEnv()
if (step === 'sync') {
  sync(env)
}
else if (step === 'apk') {
  sync(env)
  gradle(env, ['assembleDebug'])
  const built = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
  fs.mkdirSync(path.dirname(apkOut), { recursive: true })
  fs.copyFileSync(built, apkOut)
  console.log(`\nDebug APK: ${apkOut} (${(fs.statSync(apkOut).size / 1e6).toFixed(1)} MB)`)
}
else if (step === 'install') {
  run(path.join(env.ANDROID_HOME, 'platform-tools', win ? 'adb.exe' : 'adb'), ['install', '-r', apkOut], { env, shell: false })
}
else if (step === 'test') {
  gradle(env, ['testDebugUnitTest'])
}
else {
  console.error('Usage: node android/run.mjs sync | apk | install | test')
  process.exit(1)
}
