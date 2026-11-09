import { describe, expect, it } from 'vitest'
import { containRect } from '~/lib/pictureRect'

describe('containRect', () => {
  it('pillarboxes a portrait video in a wide player', () => {
    expect(containRect(1600, 900, 1080, 1920)).toEqual({ x: 546.875, y: 0, width: 506.25, height: 900, areaWidth: 1600, areaHeight: 900 })
  })
  it('letterboxes a wide video in a tall player', () => {
    const r = containRect(900, 1600, 1920, 1080)!
    expect(r.width).toBe(900)
    expect(r.height).toBeCloseTo(506.25)
    expect(r.y).toBeCloseTo((1600 - 506.25) / 2)
  })
  it('fills when the shapes match', () => {
    expect(containRect(1280, 720, 1920, 1080)).toMatchObject({ x: 0, y: 0, width: 1280, height: 720 })
  })
  it('is null without sizes', () => {
    expect(containRect(0, 720, 1920, 1080)).toBeNull()
    expect(containRect(1280, 720, 0, 0)).toBeNull()
  })
})
