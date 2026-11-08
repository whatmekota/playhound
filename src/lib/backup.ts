import type { BackupStore, VideoMeta } from './idb'
import { BACKUP_STORES, exportStore, importStore } from './idb'
import { isOwnKey, runMigrations, SCHEMA_VERSION, storedSchema } from './persist'

/**
 * Backup and restore of everything the app keeps in the browser.
 *
 * Browser storage is scoped to the origin — scheme, host *and port* — so
 * running the app on a different port makes existing data invisible even though
 * nothing was deleted. That is the usual reason a library looks "wiped", and
 * this is the way back: export on the origin that has the data, import on the
 * one you want to use.
 */

export const BACKUP_VERSION = 1

const KEYS_SCHEMA = 'ph:schema'

export interface Backup {
  _app: 'playhound'
  _version: number
  _exportedAt: string
  _origin: string
  local: Record<string, string>
  idb: Partial<Record<BackupStore, [string, unknown][]>>
}

/**
 * localStorage keys belonging to this app: everything listed in ./persist.ts,
 * plus the legacy names an older backup file may still carry (they are
 * migrated straight after a restore).
 */
export function isOurKey(key: string): boolean {
  return isOwnKey(key)
}

/** Everything in localStorage that belongs to this app. */
export function collectLocal(): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !isOurKey(key))
      continue
    const value = localStorage.getItem(key)
    if (value !== null)
      out[key] = value
  }
  return out
}

export async function createBackup(): Promise<Backup> {
  const idb: Backup['idb'] = {}
  for (const name of BACKUP_STORES) {
    try {
      idb[name] = await exportStore(name)
    }
    catch {
      // A store that does not exist yet simply has nothing to back up.
      idb[name] = []
    }
  }

  return {
    _app: 'playhound',
    _version: BACKUP_VERSION,
    _exportedAt: new Date().toISOString(),
    _origin: location.origin,
    local: collectLocal(),
    idb,
  }
}

export interface RestoreResult {
  localKeys: number
  idbRecords: number
  skipped: string[]
}

/**
 * Write a backup back into this origin.
 *
 * `replace` clears our own keys first, so a restore is exact rather than merged
 * on top of whatever is already here. It only ever touches keys this app owns.
 */
export async function restoreBackup(
  data: unknown,
  mode: 'merge' | 'replace' = 'merge',
): Promise<RestoreResult> {
  const backup = data as Backup
  if (!backup || backup._app !== 'playhound' || typeof backup.local !== 'object')
    throw new Error('Not a playhound backup file')

  const skipped: string[] = []

  if (mode === 'replace') {
    for (const key of Object.keys(collectLocal()))
      localStorage.removeItem(key)
  }

  let localKeys = 0
  for (const [key, value] of Object.entries(backup.local ?? {})) {
    // Never write keys outside our own namespace, whatever the file claims.
    if (!isOurKey(key)) {
      skipped.push(key)
      continue
    }
    localStorage.setItem(key, value)
    localKeys++
  }
  // A backup from before the storage layout changed carries old key names;
  // bring them forward exactly as a normal start would.
  if (backup.local && !(KEYS_SCHEMA in backup.local)) {
    localStorage.removeItem(KEYS_SCHEMA)
    runMigrations(localStorage, storedSchema(localStorage))
  }
  else if (storedSchema(localStorage) < SCHEMA_VERSION) {
    runMigrations(localStorage)
  }

  let idbRecords = 0
  for (const name of BACKUP_STORES) {
    const records = backup.idb?.[name]
    if (!records?.length)
      continue
    try {
      // A plain copy: IndexedDB cannot store a Proxy (a backup held in Vue
      // state is one, all the way down), and the records came from JSON anyway.
      await importStore(name, JSON.parse(JSON.stringify(records)))
      idbRecords += records.length
    }
    catch (err) {
      skipped.push(`idb:${name}${err instanceof Error && err.name !== 'Error' ? ` (${err.name})` : ''}`)
    }
  }

  return { localKeys, idbRecords, skipped }
}

export interface StorageInventory {
  local: { key: string, bytes: number }[]
  idb: { store: string, records: number }[]
  totalBytes: number
  /** Videos with at least one tag of their own. */
  tagged: number
}

/**
 * Videos with tags, in a set of `vidmeta` records. Tags travel inside each
 * video's saved info (with its notes and rating), so a backup carries them
 * without a key of their own; this is how the Backup panel can still say so.
 */
export function countTagged(records: [string, unknown][] | undefined): number {
  let n = 0
  for (const [, v] of records ?? []) {
    const tags = (v as VideoMeta | null)?.tags
    if (Array.isArray(tags) && tags.length)
      n++
  }
  return n
}

/**
 * What is actually stored on this origin right now.
 *
 * Exists because "my data is gone" is almost always "my data is on a different
 * origin" or "the folder permission lapsed", and guessing between those is
 * hopeless without simply looking.
 */
export async function inventory(): Promise<StorageInventory> {
  const local = Object.entries(collectLocal())
    .map(([key, value]) => ({ key, bytes: value.length }))
    .sort((a, b) => b.bytes - a.bytes)

  const idb: { store: string, records: number }[] = []
  let tagged = 0
  for (const name of BACKUP_STORES) {
    try {
      const records = await exportStore(name)
      idb.push({ store: name, records: records.length })
      if (name === 'vidmeta')
        tagged = countTagged(records)
    }
    catch {
      idb.push({ store: name, records: 0 })
    }
  }

  return {
    local,
    idb,
    totalBytes: local.reduce((s, k) => s + k.bytes, 0),
    tagged,
  }
}

export function downloadBackup(backup: Backup): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `playhound-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
