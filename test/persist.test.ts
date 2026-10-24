import type { KV } from '../src/lib/persist'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_KEYS, KEYS, LEGACY_RENAMES, runMigrations, SCHEMA_VERSION, storedSchema } from '../src/lib/persist'

function memory(init: Record<string, string> = {}): KV & { data: Record<string, string> } {
  const data = { ...init }
  return {
    data,
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v },
    removeItem: (k) => { delete data[k] },
  }
}

describe('runMigrations', () => {
  it('marks fresh storage as current without running anything', () => {
    const kv = memory()
    expect(runMigrations(kv)).toEqual([])
    expect(kv.data[KEYS.schema.key]).toBe(String(SCHEMA_VERSION))
  })

  it('moves every legacy key to its new name and removes the old one', () => {
    const kv = memory({
      'mwhoplayer:playlists': '[{"id":"x","name":"Mine","entries":[]}]',
      'ph-hypno-words': '["a","b"]',
      'bp:url': '"ws://localhost:12345"',
      'deviceConfig': '{"axes":1}',
    })
    expect(storedSchema(kv)).toBe(1)
    expect(runMigrations(kv)).toEqual([1, 2])

    expect(kv.data[KEYS.playlists.key]).toBe('[{"id":"x","name":"Mine","entries":[]}]')
    expect(kv.data[KEYS.hypnoWords.key]).toBe('["a","b"]')
    expect(kv.data[KEYS.buttplugUrl.key]).toBe('"ws://localhost:12345"')
    expect(kv.data[KEYS.deviceConfig.key]).toBe('{"axes":1}')
    for (const old of ['mwhoplayer:playlists', 'ph-hypno-words', 'bp:url', 'deviceConfig'])
      expect(kv.data[old]).toBeUndefined()
    expect(kv.data[KEYS.schema.key]).toBe(String(SCHEMA_VERSION))
  })

  it('keeps the theme as a bare string for the pre-paint script', () => {
    const kv = memory({ theme: 'dracula' })
    runMigrations(kv)
    expect(kv.data[KEYS.theme.key]).toBe('dracula')
  })

  it('lifts motion out of the old uiState blob', () => {
    const kv = memory({ uiState: JSON.stringify({ sidebarWidth: 300, motion: { source: 'manual' } }) })
    runMigrations(kv)
    expect(JSON.parse(kv.data[KEYS.motionConfig.key])).toEqual({ source: 'manual' })
    expect(kv.data.uiState).toBeUndefined()
  })

  it('prefers a standalone motion key over the blob', () => {
    const kv = memory({
      motion: '{"source":"beat"}',
      uiState: JSON.stringify({ motion: { source: 'manual' } }),
    })
    runMigrations(kv)
    expect(JSON.parse(kv.data[KEYS.motionConfig.key])).toEqual({ source: 'beat' })
  })

  it('folds the old Favorites playlist into stars', () => {
    const kv = memory({
      'mwhoplayer:starred': '["a.mp4"]',
      'mwhoplayer:playlists': JSON.stringify([{ id: 'favorites', entries: [{ videoName: 'b.mp4' }, { videoName: 'a.mp4' }] }]),
    })
    runMigrations(kv)
    expect(JSON.parse(kv.data[KEYS.starred.key]).sort()).toEqual(['a.mp4', 'b.mp4'])
  })

  it('does not fold Favorites again once a previous version already did', () => {
    const kv = memory({
      'ph-favorites-into-stars': '1',
      'mwhoplayer:starred': '[]',
      'mwhoplayer:playlists': JSON.stringify([{ id: 'favorites', entries: [{ videoName: 'b.mp4' }] }]),
    })
    runMigrations(kv)
    expect(JSON.parse(kv.data[KEYS.starred.key])).toEqual([])
    expect(kv.data['ph-favorites-into-stars']).toBeUndefined()
  })

  it('never overwrites a value already under the new name', () => {
    const kv = memory({ 'ph-volume': '0.9', [KEYS.audioVolume.key]: '0.2' })
    runMigrations(kv, 1)
    expect(kv.data[KEYS.audioVolume.key]).toBe('0.2')
    expect(kv.data['ph-volume']).toBeUndefined()
  })

  it('drops keys of features that no longer exist', () => {
    const kv = memory({ 'ph:schema': '2', 'mwhoplayer:llm': '{}', 'ph-sec-beat': 'true', 'ph:playlists': '[]' })
    expect(runMigrations(kv)).toEqual([2])
    expect(kv.data['mwhoplayer:llm']).toBeUndefined()
    expect(kv.data['ph-sec-beat']).toBeUndefined()
    expect(kv.data['ph:playlists']).toBe('[]')
    expect(kv.data[KEYS.schema.key]).toBe(String(SCHEMA_VERSION))
  })

  it('walks every step from the oldest layout', () => {
    const kv = memory({ 'ph-volume': '0.5', 'ph-sec-layers': 'true' })
    expect(runMigrations(kv)).toEqual([1, 2])
    expect(kv.data[KEYS.audioVolume.key]).toBe('0.5')
    expect(kv.data['ph-sec-layers']).toBeUndefined()
  })

  it('is idempotent', () => {
    const kv = memory({ 'ph-base-freq': '200' })
    runMigrations(kv)
    const after = { ...kv.data }
    expect(runMigrations(kv)).toEqual([])
    expect(kv.data).toEqual(after)
  })

  it('leaves the version alone when a step throws, so it is retried', () => {
    const kv = memory({ 'ph-base-freq': '200' })
    const broken: KV = {
      getItem: kv.getItem,
      removeItem: kv.removeItem,
      setItem: (k, v) => {
        if (k === KEYS.audioBaseFreq.key)
          throw new Error('quota')
        kv.setItem(k, v)
      },
    }
    expect(runMigrations(broken)).toEqual([])
    expect(kv.data[KEYS.schema.key]).toBeUndefined()
    expect(kv.data['ph-base-freq']).toBe('200')
  })
})

describe('key registry', () => {
  it('has unique keys, all in the ph: namespace', () => {
    const keys = ALL_KEYS.map(k => k.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys)
      expect(k.startsWith('ph:')).toBe(true)
  })

  it('maps every legacy name to a registered key', () => {
    const known = new Set(ALL_KEYS.map(k => k.key))
    for (const to of Object.values(LEGACY_RENAMES))
      expect(known.has(to)).toBe(true)
  })

  // Catches a key typed straight into a component without being registered,
  // which is how storage drifted into four dialects in the first place.
  it('covers every ph: key the source code uses', () => {
    const known = new Set(ALL_KEYS.map(k => k.key))
    const unknown: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          walk(p)
          continue
        }
        if (!/\.(?:ts|vue)$/.test(name) || name === 'persist.ts')
          continue
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(/['`](ph:[\w.]+)['`]/g)) {
          if (!known.has(m[1]))
            unknown.push(`${p}: ${m[1]}`)
        }
      }
    }
    walk(join(__dirname, '../src'))
    expect(unknown).toEqual([])
  })

  it('leaves no legacy key names in the source', () => {
    const legacy = Object.keys(LEGACY_RENAMES).filter(k => k !== 'theme' && k !== 'motion')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          walk(p)
          continue
        }
        if (!/\.(?:ts|vue)$/.test(name) || name === 'persist.ts')
          continue
        const src = readFileSync(p, 'utf8')
        for (const k of legacy) {
          if (src.includes(`'${k}'`) || src.includes(`\`${k}\``))
            hits.push(`${p}: ${k}`)
        }
      }
    }
    walk(join(__dirname, '../src'))
    expect(hits).toEqual([])
  })
})
