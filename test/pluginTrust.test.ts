import { describe, expect, it } from 'vitest'
import { addNewDefaults, DEFAULT_SOURCES, OFFICIAL_OWNER, trustOf } from '~/plugins/sources'

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
    expect(r.list).toEqual(['whatmekota/playmate', 'someone/thing', 'WhatMeKota/ph2gether', 'whatmekota/phbrowser'])
  })
  it('doesn\'t bring back one the user removed after it was offered', () => {
    const r = addNewDefaults(['whatmekota/playmate'], [...DEFAULT_SOURCES])
    expect(r.list).toEqual(['whatmekota/playmate'])
  })
})
