import { describe, expect, it } from 'vitest'
import { KEYS, runMigrations } from '~/lib/persist'
import { noteFirstRun, setupPending, setupStateOnStart } from '~/lib/setup'

describe('first-run setup: fresh install or not', () => {
  it('is offered to empty storage only, never to an install used before', () => {
    expect(setupStateOnStart(null, [])).toBe('pending')
    expect(setupStateOnStart(null, [KEYS.schema.key])).toBe('done')
    // From before the ph: namespace.
    expect(setupStateOnStart(null, ['mwhoplayer:playlists'])).toBe('done')
  })

  it('keeps its answer, so an unfinished first start gets it again', () => {
    expect(setupStateOnStart('pending', [KEYS.schema.key, KEYS.pluginSources.key])).toBe('pending')
  })

  it('decides before the migrations stamp the layout version', () => {
    localStorage.clear()
    expect(noteFirstRun(localStorage)).toBe('pending')
    runMigrations(localStorage)
    expect(setupPending(localStorage)).toBe(true)

    localStorage.clear()
    runMigrations(localStorage)
    expect(noteFirstRun(localStorage)).toBe('done')
  })
})
