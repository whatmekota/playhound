// @vitest-environment node
import { Buffer } from 'node:buffer'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createXrServer, makeCertificate, XR_PORT } from '../desktop/xr.mjs'
import { codeMatches, mediaType, parseRange, readCookie } from '../desktop/xrRules.mjs'

describe('headset server rules', () => {
  it('reads ranges as a video asks for them', () => {
    expect(parseRange(undefined, 1000)).toBeNull()
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=1000-', 1000)).toBe('bad')
    expect(parseRange('bytes=0-1,5-6', 1000)).toBe('bad')
  })

  it('pairs only with the code, and reads its cookie', () => {
    expect(codeMatches('123 456', '123456')).toBe(true)
    expect(codeMatches('123457', '123456')).toBe(false)
    expect(codeMatches('', '')).toBe(false)
    expect(readCookie('a=1; ph_xr=abc; b=2', 'ph_xr')).toBe('abc')
    expect(readCookie('a=1', 'ph_xr')).toBeNull()
    expect(mediaType('Clip.MP4')).toBe('video/mp4')
    expect(mediaType('x.mkv')).toBe('video/x-matroska')
  })

  it('makes a certificate for the LAN addresses', () => {
    const { cert, key } = makeCertificate(['10.1.2.3'])
    const x = new X509Certificate(cert)
    expect(x.subjectAltName).toContain('IP Address:10.1.2.3')
    expect(x.subjectAltName).toContain('DNS:localhost')
    expect(x.checkPrivateKey(createPrivateKey(key))).toBe(true)
  })
})

describe('headset server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-xr-'))
  const dist = path.join(dir, 'dist')
  fs.mkdirSync(dist)
  fs.writeFileSync(path.join(dist, 'index.html'), '<title>playhound</title>')
  const video = path.join(dir, 'clip.mp4')
  fs.writeFileSync(video, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)))

  const handlers = new Map<string, (...a: any[]) => any>()
  const ipcMain = { handle: (n: string, f: any) => handlers.set(n, f), on: (n: string, f: any) => handlers.set(n, f) }
  const sent: [string, any][] = []
  const win = { isDestroyed: () => false, webContents: { send: (ch: string, m: any) => sent.push([ch, m]) } }
  const server = createXrServer({ ipcMain, allowed: () => true, window: () => win, dataDir: dir, distDir: dist, devUrl: null, lanAddresses: () => [{ address: '127.0.0.1' }] } as any)
  const call = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args)

  function request(p: string, opts: https.RequestOptions = {}, body?: string): Promise<{ status: number, headers: any, body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: XR_PORT, path: p, rejectUnauthorized: false, ...opts }, (res) => {
        const parts: Buffer[] = []
        res.on('data', c => parts.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts) }))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  afterAll(async () => {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('pairs a headset with the code, then streams it what it was offered and passes its messages on', async () => {
    const state = await call('ph:xr:start', true)
    expect(state.on).toBe(true)
    expect(state.urls).toEqual([`https://127.0.0.1:${XR_PORT}`])

    // Not paired: the page loads, the rest does not.
    expect((await request('/')).headers.location).toBe('/xr')
    expect(JSON.parse(String((await request('/xr/hello')).body))).toEqual({ paired: false })
    await call('ph:xr:media', [{ id: 'v1', path: video, name: 'clip.mp4' }])
    expect((await request('/xr/media/v1')).status).toBe(401)

    // A wrong code, then the right one.
    const post = (code: string) => request('/xr/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ code }))
    expect((await post('000000x')).status).toBe(403)
    const ok = await post(state.code)
    expect(ok.status).toBe(200)
    const cookie = String(ok.headers['set-cookie']).split(';')[0]
    expect(cookie).toMatch(/^ph_xr=[0-9a-f]{64}$/)
    expect((await call('ph:xr:state')).code).not.toBe(state.code)

    // The video, in part.
    const part = await request('/xr/media/v1', { headers: { cookie, range: 'bytes=10-19' } })
    expect(part.status).toBe(206)
    expect(part.headers['content-range']).toBe('bytes 10-19/1000')
    expect([...part.body]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

    // The page's line to the main window.
    const ws = new WebSocket(`wss://127.0.0.1:${XR_PORT}/xr/ws`, { rejectUnauthorized: false, headers: { cookie } })
    await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject))
    ws.send(JSON.stringify({ type: 'hello' }))
    await vi.waitFor(() => expect(sent.some(([ch, m]) => ch === 'ph:xr:message' && m.type === 'hello')).toBe(true))
    ws.close()

    // Without the cookie the socket is refused.
    const stranger = new WebSocket(`wss://127.0.0.1:${XR_PORT}/xr/ws`, { rejectUnauthorized: false })
    await expect(new Promise((resolve, reject) => stranger.once('open', resolve).once('error', reject))).rejects.toBeTruthy()
  })
})
