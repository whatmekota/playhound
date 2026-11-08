import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

// IndexedDB clones what it stores; structuredClone does the same and, like it,
// cannot clone a Proxy.
const written: Record<string, [string, unknown][]> = {}
vi.mock('~/lib/idb', () => ({
  BACKUP_STORES: ['meta', 'playlists', 'vidmeta', 'summaries'],
  exportStore: vi.fn(async () => []),
  importStore: vi.fn(async (name: string, records: [string, unknown][]) => {
    written[name] = structuredClone(records)
  }),
}))

const { restoreBackup } = await import('~/lib/backup')

describe('restoring a backup', () => {
  beforeEach(() => {
    localStorage.clear()
    for (const k of Object.keys(written))
      delete written[k]
  })

  it('writes video info even when the backup is held in Vue state', async () => {
    const backup = reactive({
      _app: 'playhound',
      _version: 1,
      _exportedAt: '',
      _origin: 'x',
      local: {},
      idb: { vidmeta: [['clip.mp4', { tags: ['pov'], rating: 4 }]] },
    })
    const res = await restoreBackup(backup, 'merge')
    expect(res.skipped).toEqual([])
    expect(res.idbRecords).toBe(1)
    expect(written.vidmeta).toEqual([['clip.mp4', { tags: ['pov'], rating: 4 }]])
  })
})
