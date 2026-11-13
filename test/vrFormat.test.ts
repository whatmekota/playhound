import { describe, expect, it } from 'vitest'
import { guessVrFormat, looksSbsBySize, vrFormat } from '~/lib/vrFormat'

describe('guessVrFormat', () => {
  it.each([
    ['SLR_Studio_Scene_original_12345_MKX200.mp4', 'fe200'],
    ['scene_6K_MKX220_lr.mp4', 'fe220'],
    ['clip_VRCA220.mp4', 'fe220'],
    ['scene_FISHEYE190_alpha.mp4', 'fe190'],
    ['scene_rf52.mp4', 'fe190'],
    ['scene_fisheye.mp4', 'fe190'],
    ['scene_fisheye180_sbs.mp4', 'fe180'],
    ['D:\\vr\\scene_180_LR.mp4', 'eq180'],
    ['scene_180x180_3dh.mp4', 'eq180'],
    ['scene_SBS_180.mp4', 'eq180'],
  ])('%s → %s', (name, id) => {
    expect(guessVrFormat(name)).toBe(id)
  })

  it.each([
    'Sanae & Reimu After School Show.mp4',
    'clip_1080p.mp4',
    'episode 180.mp4',
    'D:\\fisheye\\plain.mp4',
  ])('says nothing about %s', (name) => {
    expect(guessVrFormat(name)).toBeNull()
  })
})

describe('vrFormat', () => {
  it('falls back to 180° equirectangular', () => {
    expect(vrFormat('nope').id).toBe('eq180')
    expect(vrFormat(null).fov).toBe(180)
    expect(vrFormat('fe200')).toMatchObject({ projection: 'fisheye', fov: 200 })
  })
})

describe('looksSbsBySize', () => {
  it('only a big 2:1 frame, not an 18:9 phone recording', () => {
    expect(looksSbsBySize(5760, 2880)).toBe(true)
    expect(looksSbsBySize(3840, 1920)).toBe(true)
    expect(looksSbsBySize(2160, 1080)).toBe(false)
    expect(looksSbsBySize(3840, 2160)).toBe(false)
  })
})
