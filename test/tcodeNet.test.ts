import { describe, expect, it } from 'vitest'
import { encodeBatch, encodeTCode } from '~/lib/tcodeEncoder'
import {
  describeTarget,
  formatAddress,
  MAX_DATAGRAM,
  mixedContentBlocked,
  NET_PRESETS,
  parseAddress,
  presetById,
  RESUME_MS,
  resumeInterval,
  RETRY_MAX_MS,
  retryDelay,
  toNetMessages,
  wsUrl,
} from '~/lib/tcodeNet'

function ok(input: string, protocol: 'ws' | 'udp' = 'udp', path = '') {
  const r = parseAddress(input, protocol, path)
  if (!r.ok)
    throw new Error(r.error)
  return r.target
}

describe('parseAddress', () => {
  it('takes a bare host, with the protocol\'s default port', () => {
    expect(ok('tcode.local')).toEqual({ protocol: 'udp', host: 'tcode.local', port: 8000, path: '' })
    expect(ok('tcode.local', 'ws')).toEqual({ protocol: 'ws', host: 'tcode.local', port: 80, path: '/' })
  })

  it('takes host:port and IPv4 addresses', () => {
    expect(ok('192.168.1.40:8001')).toMatchObject({ host: '192.168.1.40', port: 8001 })
    expect(ok('  OSR2.local:9000 ')).toMatchObject({ host: 'osr2.local', port: 9000 })
  })

  it('takes IPv6, bracketed with a port or bare', () => {
    expect(ok('[::1]:12347')).toMatchObject({ host: '::1', port: 12347 })
    expect(ok('fe80::1')).toMatchObject({ host: 'fe80::1', port: 8000 })
    expect(formatAddress(ok('[::1]:12347'))).toBe('[::1]:12347')
  })

  it('reads whole WebSocket URLs, scheme winning over the chosen protocol', () => {
    expect(ok('ws://localhost:12346/tcode', 'udp')).toEqual({ protocol: 'ws', host: 'localhost', port: 12346, path: '/tcode' })
    expect(ok('wss://box.example')).toEqual({ protocol: 'ws', host: 'box.example', port: 443, path: '/', secure: true })
    expect(ok('udp://tcode.local:8000', 'ws')).toMatchObject({ protocol: 'udp', port: 8000 })
  })

  it('uses the preset\'s path when a WebSocket address has none', () => {
    expect(ok('tcode.local', 'ws', '/ws').path).toBe('/ws')
    expect(ok('tcode.local/other', 'ws', '/ws').path).toBe('/other')
  })

  it('refuses what is not an address, saying why', () => {
    for (const bad of ['', '   ', 'http://x', 'host:0', 'host:70000', 'host:abc', 'bad host', 'udp://h:1/path', '[::1', '/b']) {
      const r = parseAddress(bad, 'udp')
      expect(r.ok, bad).toBe(false)
      if (!r.ok)
        expect(r.error.length).toBeGreaterThan(5)
    }
  })

  it('writes WebSocket URLs back without a redundant port', () => {
    expect(wsUrl(ok('tcode.local', 'ws', '/ws'))).toBe('ws://tcode.local/ws')
    expect(wsUrl(ok('localhost:12346', 'ws', '/tcode'))).toBe('ws://localhost:12346/tcode')
    expect(describeTarget(ok('localhost:12346', 'ws', '/tcode'))).toBe('localhost:12346/tcode')
  })
})

describe('presets', () => {
  it('match what the firmware and restim listen on by default', () => {
    expect(presetById('esp32-udp')!.target).toEqual({ protocol: 'udp', host: 'tcode.local', port: 8000, path: '' })
    expect(presetById('esp32-ws')!.target).toEqual({ protocol: 'ws', host: 'tcode.local', port: 80, path: '/ws' })
    expect(presetById('restim-ws')!.target).toEqual({ protocol: 'ws', host: 'localhost', port: 12346, path: '/tcode' })
    expect(presetById('restim-udp')!.target).toEqual({ protocol: 'udp', host: 'localhost', port: 12347, path: '' })
    expect(presetById('custom')!.target).toBeNull()
  })

  it('round-trip through the address field', () => {
    for (const p of NET_PRESETS) {
      if (!p.target)
        continue
      expect(ok(formatAddress(p.target), p.target.protocol, p.target.path)).toEqual(p.target)
    }
  })
})

describe('toNetMessages', () => {
  it('sends the same commands as serial, on one line', () => {
    const limits = { min: 0.05, max: 0.95, invert: false }
    const serial = encodeTCode({ channel: 'L0', position: 0.5, interval: 33 }, limits, 'v3')
    expect(toNetMessages(serial)).toEqual([serial])

    const batch = encodeBatch([
      { channel: 'L0', position: 0.5, interval: 500 },
      { channel: 'R0', position: 0.5, interval: 500 },
      { channel: 'R1', position: 0.2, interval: 500 },
    ], undefined, 'v3')
    const msgs = toNetMessages(batch)
    expect(msgs).toEqual(['L05000I500 R05000I500 R12000I500\n'])
    // Exactly the serial commands, nothing added, nothing lost.
    expect(msgs.join('').trim().split(' ')).toEqual(batch.trim().split('\n'))
  })

  it('splits between commands to stay inside a datagram', () => {
    const many = Array.from({ length: 40 }, (_, i) => `L0${String(i).padStart(4, '0')}I33\n`).join('')
    const msgs = toNetMessages(many)
    expect(msgs.length).toBeGreaterThan(1)
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(MAX_DATAGRAM)
      expect(m.endsWith('\n')).toBe(true)
    }
    expect(msgs.join(' ').split(/\s+/).filter(Boolean)).toEqual(many.trim().split('\n'))
  })

  it('sends nothing for nothing', () => {
    expect(toNetMessages('')).toEqual([])
    expect(toNetMessages('\n\n')).toEqual([])
  })
})

describe('retryDelay', () => {
  it('backs off 1, 2, 4, 8 s, then holds at 15 s', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(a => retryDelay(a, 0.5))).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000])
  })

  it('jitters by at most ±20%, never past the cap', () => {
    expect(retryDelay(0, 0)).toBe(800)
    expect(retryDelay(0, 1)).toBe(1200)
    expect(retryDelay(10, 1)).toBe(RETRY_MAX_MS)
  })
})

describe('mixedContentBlocked', () => {
  const ws = (host: string, secure = false) => ({ protocol: 'ws' as const, host, port: 80, path: '/', ...(secure ? { secure } : {}) })
  it('only blocks plain ws:// to another machine from an https page', () => {
    expect(mixedContentBlocked('https:', ws('tcode.local'))).toBe(true)
    expect(mixedContentBlocked('https:', ws('localhost'))).toBe(false)
    expect(mixedContentBlocked('https:', ws('127.0.0.1'))).toBe(false)
    expect(mixedContentBlocked('https:', ws('tcode.local', true))).toBe(false)
    expect(mixedContentBlocked('http:', ws('tcode.local'))).toBe(false)
    expect(mixedContentBlocked('https:', { protocol: 'udp', host: 'tcode.local', port: 8000, path: '' })).toBe(false)
  })
})

describe('resumeInterval', () => {
  it('stretches moves right after the link comes up, so the device glides', () => {
    expect(resumeInterval(33, 0)).toBe(RESUME_MS)
    expect(resumeInterval(33, 300)).toBe(RESUME_MS - 300)
    // Every move in the window lands at the same moment: the end of it.
    for (const t of [0, 100, 400, 700])
      expect(t + resumeInterval(33, t)).toBe(RESUME_MS)
  })

  it('leaves slower moves and later moves alone', () => {
    expect(resumeInterval(1000, 100)).toBe(1000)
    expect(resumeInterval(33, RESUME_MS)).toBe(33)
    expect(resumeInterval(33, Number.POSITIVE_INFINITY)).toBe(33)
    expect(resumeInterval(33, Number.NaN)).toBe(33)
  })
})
