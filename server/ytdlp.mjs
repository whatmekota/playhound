/**
 * yt-dlp, for the hosts playhound has no resolver of its own for.
 *
 * playhound keeps its own copy in `binDir` (the desktop app's data folder, or
 * ~/.playhound/bin from source), fetched from yt-dlp's official GitHub
 * releases only when the user agrees to it, and updated now and then. One
 * already on PATH is used if there is no copy of our own.
 */

import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { netFetch } from './net.mjs'

const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'
const ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp' }[process.platform] ?? 'yt-dlp'
const UPDATE_EVERY_MS = 7 * 24 * 60 * 60 * 1000

let binDir = path.join(os.homedir(), '.playhound', 'bin')
let installing = null

export function setBinDir(dir) {
  binDir = dir
}

const own = () => path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

function run(bin, args, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err)
        reject(new Error((stderr || err.message).trim().split('\n').pop()))
      else
        resolve(stdout)
    })
  })
}

/** The yt-dlp to use: our own copy, else one on PATH, else null. */
async function locate() {
  if (fs.existsSync(own()))
    return own()
  try {
    await run('yt-dlp', ['--version'], 10_000)
    return 'yt-dlp'
  }
  catch {
    return null
  }
}

export async function status() {
  const bin = await locate()
  if (!bin)
    return { installed: false, installing: !!installing }
  let version = null
  try {
    version = (await run(bin, ['--version'], 15_000)).trim()
  }
  catch {}
  return { installed: true, installing: false, version, own: bin === own() }
}

/** Download the official release into binDir. */
export function install() {
  installing ??= (async () => {
    fs.mkdirSync(binDir, { recursive: true })
    const res = await netFetch(RELEASE + ASSET)
    if (!res.ok)
      throw new Error(`GitHub answered ${res.status} for ${ASSET}`)
    const tmp = `${own()}.download`
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
    if (process.platform !== 'win32')
      fs.chmodSync(tmp, 0o755)
    fs.renameSync(tmp, own())
  })().finally(() => {
    installing = null
  })
  return installing
}

let updateChecked = false

/** Update our own copy in the background, at most once a week. */
function maybeUpdate() {
  if (updateChecked || !fs.existsSync(own()))
    return
  updateChecked = true
  if (Date.now() - fs.statSync(own()).mtimeMs < UPDATE_EVERY_MS)
    return
  run(own(), ['-U'], 120_000).then(() => fs.utimesSync(own(), new Date(), new Date())).catch(() => {})
}

/** A format <video> can play straight from its URL: one file with sound and picture. */
const progressive = f => /^https?$/.test(f.protocol) && f.vcodec !== 'none' && f.acodec !== 'none' && f.url
const hls = f => /m3u8/.test(f.protocol ?? '') && f.vcodec !== 'none' && f.url

/**
 * Ask yt-dlp about a page. Returns { title, sources: [{ label, height, kind,
 * target }] }, best first, or throws with yt-dlp's own complaint.
 */
export async function extract(url) {
  const bin = await locate()
  if (!bin) {
    const err = new Error('This site needs yt-dlp')
    err.code = 'needs-ytdlp'
    throw err
  }
  maybeUpdate()
  // yt-dlp honours HTTP(S)_PROXY from the environment by itself.
  const info = JSON.parse(await run(bin, ['-J', '--no-playlist', '--no-warnings', url]))
  const entry = info._type === 'playlist' ? info.entries?.find(Boolean) : info
  if (!entry)
    throw new Error('yt-dlp found nothing to play there')
  const formats = entry.formats ?? [entry]
  const pick = (list, kind) => list
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))
    .filter((f, i, all) => all.findIndex(g => (g.height ?? 0) === (f.height ?? 0)) === i)
    .map(f => ({
      label: f.height ? `${f.height}p` : (/[a-z]/i.test(f.format_note ?? '') ? f.format_note : 'Video'),
      height: f.height ?? 0,
      size: f.filesize ?? f.filesize_approx ?? null,
      kind,
      target: { type: kind === 'hls' ? 'hls' : 'http', url: f.url, headers: f.http_headers ?? {}, name: `x.${f.ext ?? 'mp4'}` },
    }))
  let sources = pick(formats.filter(progressive), 'file')
  // Only HLS (Pornhub, mostly): fine, the app plays it with hls.js.
  if (!sources.length)
    sources = pick(formats.filter(hls), 'hls')
  if (!sources.length)
    throw new Error('yt-dlp found no format a browser can play')
  return { title: entry.title ?? null, sources }
}
