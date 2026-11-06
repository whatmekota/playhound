import { describe, expect, it } from 'vitest'
import { OFFICIAL_OWNER, trustOf } from '~/plugins/sources'

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
