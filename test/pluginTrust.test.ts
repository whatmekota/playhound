import { describe, expect, it } from 'vitest'
import { builtInIcon } from '~/plugins/builtInIcons'
import { addNewDefaults, DEFAULT_SOURCES, OFFICIAL_OWNER, trustOf } from '~/plugins/sources'
import { buildEntries } from '~/plugins/storeEntry'

describe('built-in icons for the official plugins', () => {
  const OFFICIAL = ['playmate', 'ph2gether', 'phbrowser', 'phthreads', 'phbeatbar', 'phvr', 'phstash']
  it('has one for each official plugin', () => {
    const icons = OFFICIAL.map(id => builtInIcon(id, true))
    for (const icon of icons)
      expect(icon).toMatch(/svg/)
    expect(new Set(icons).size).toBe(OFFICIAL.length)
  })
  it('gives none to a plugin that isn\'t official, even with an official id', () => {
    expect(builtInIcon('playmate', false)).toBeNull()
    expect(builtInIcon('something-else', true)).toBeNull()
    expect(builtInIcon('constructor', true)).toBeNull()
  })
  it('goes by the repository, not the id', () => {
    const entries = buildEntries(['whatmekota/playmate', 'someone/playmate'], {}, [])
    expect(entries.map(e => builtInIcon(e.id, e.trust === 'official'))).toEqual([builtInIcon('playmate', true), null])
  })
})

describe('plugin source trust', () => {
  it('marks the official owner\'s repositories, whatever the case', () => {
    expect(trustOf(`${OFFICIAL_OWNER}/playmate`)).toBe('official')
    expect(trustOf('WhatMeKota/ph2gether')).toBe('official')
  })
  it('leaves everyone else unmarked unless they are on the trusted list', () => {
    expect(trustOf('someone/plugin')).toBeNull()
    expect(trustOf('whatmekota-fan/plugin')).toBeNull()
  })
})

describe('official plugins joining the store list', () => {
  it('adds new ones to a list from before they were tracked, keeping playmate removed if it was', () => {
    const r = addNewDefaults([], null)
    expect(r.list).toEqual(DEFAULT_SOURCES.filter(s => s !== 'whatmekota/playmate'))
    expect(r.seen.sort()).toEqual([...DEFAULT_SOURCES].sort())
  })
  it('keeps what the user added, and never adds a default twice', () => {
    const r = addNewDefaults(['whatmekota/playmate', 'someone/thing', 'WhatMeKota/ph2gether'], null)
    expect(r.list).toEqual(['whatmekota/playmate', 'someone/thing', 'WhatMeKota/ph2gether', 'whatmekota/phbrowser', 'whatmekota/phthreads', 'whatmekota/phbeatbar', 'whatmekota/phstash', 'whatmekota/phvr'])
  })
  it('doesn\'t bring back one the user removed after it was offered', () => {
    const r = addNewDefaults(['whatmekota/playmate'], [...DEFAULT_SOURCES])
    expect(r.list).toEqual(['whatmekota/playmate'])
  })
})
