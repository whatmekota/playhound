import { describe, expect, it } from 'vitest'
import { newer } from '../desktop/version.mjs'

describe('newer', () => {
  it.each([
    ['1.4.1', '1.4.0', true],
    ['1.10.0', '1.9.2', true],
    ['2.0.0', '1.99.99', true],
    ['v1.5.0', '1.4.0', true],
    ['1.4.0', '1.4.0', false],
    ['1.3.9', '1.4.0', false],
    ['1.5.0', '1.5.0-beta.1', true],
    ['1.5.0-beta.1', '1.5.0', false],
  ])('%s over %s: %s', (a, b, want) => {
    expect(newer(a, b)).toBe(want)
  })
})
