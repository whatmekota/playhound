import { describe, expect, it } from 'vitest'
import { guessVrFormat, guessVrLayout, looksSbsBySize, looksTbBySize, looksVrFrame, oneEyeRect, vrFormat } from '~/lib/vrFormat'

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

describe('top-bottom and 360°', () => {
  it.each([
    ['scene_360_TB.mp4', 'tb', 'eq360'],
    ['JAV_VR_OU_180.mp4', 'tb', null],
    ['scene_180_3dv.mp4', 'tb', null],
    ['scene_180_LR.mp4', 'sbs', 'eq180'],
    ['tour_360_mono_vr.mp4', 'mono', 'eq360'],
    ['clip_360p.mp4', null, null],
    ['D:\TB\scene.mp4', null, null],
  ])('%s → %s, %s', (name, layout, format) => {
    expect(guessVrLayout(name)).toBe(layout)
    expect(guessVrFormat(name)).toBe(format)
  })

  it('knows top-bottom by shape', () => {
    expect(looksTbBySize(4096, 4096)).toBe('eq360')
    expect(looksTbBySize(2880, 5760)).toBe('eq180')
    expect(looksTbBySize(1080, 1080)).toBeNull()
    expect(looksTbBySize(1080, 1920)).toBeNull()
  })
})

describe('one eye for pictures', () => {
  it('takes the left half, the top half, or the whole frame', () => {
    expect(oneEyeRect('scene_180_LR.mp4', 5760, 2880)).toEqual({ sx: 0, sy: 0, sw: 2880, sh: 2880 })
    expect(oneEyeRect('scene_360_TB.mp4', 4096, 4096)).toEqual({ sx: 0, sy: 0, sw: 4096, sh: 2048 })
    expect(oneEyeRect('big square.mp4', 4096, 4096)).toEqual({ sx: 0, sy: 0, sw: 4096, sh: 2048 })
    expect(oneEyeRect('scene_mono_360.mp4', 4096, 2048)).toEqual({ sx: 0, sy: 0, sw: 4096, sh: 2048 })
  })

  it('knows a two-eye frame without taking a flat title for one', () => {
    expect(looksVrFrame('anything.mp4', 4096, 4096)).toBe(true)
    expect(looksVrFrame('clip_TB.mp4', 2880, 2880)).toBe(true)
    expect(looksVrFrame('toi ou moi.mp4', 1920, 1080)).toBe(false)
  })
})
