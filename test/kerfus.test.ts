import { describe, expect, it } from 'vitest'
import { kerfusPose } from '~/lib/kerfus'

const base = { expr: null, panicked: false, edging: false, intensity: 0 } as const

describe('kerfusPose', () => {
  it('gives each expression its own face', () => {
    const eyes = (['calm', 'focused', 'excited', 'flustered', 'sleepy', 'shocked'] as const)
      .map(expr => kerfusPose({ ...base, expr }).eyes)
    expect(eyes).toEqual(['ring', 'lid', 'wink', 'squeeze', 'sleep', 'ring'])
    expect(kerfusPose({ ...base, expr: 'shocked' }).mouth).toBe('o')
  })

  it('lets panic and an edge override the expression', () => {
    expect(kerfusPose({ ...base, expr: 'excited', panicked: true })).toMatchObject({ eyes: 'shut', dim: true })
    expect(kerfusPose({ ...base, expr: 'excited', edging: true })).toMatchObject({ eyes: 'sad', mouth: 'm' })
  })

  it('climbs the ladder by intensity without an expression from the app', () => {
    expect(kerfusPose({ ...base, intensity: 0.5 }).eyes).toBe('lid')
    expect(kerfusPose({ ...base, intensity: 0.9 }).eyes).toBe('squeeze')
    expect(kerfusPose({ ...base, intensity: 0.9, hearts: 'auto' }).eyes).toBe('hearts')
    expect(kerfusPose({ ...base, expr: 'flustered', hearts: 'auto' }).eyes).toBe('squeeze')
    expect(kerfusPose({ ...base, expr: 'calm', hearts: 'always' }).eyes).toBe('hearts')
  })
})
