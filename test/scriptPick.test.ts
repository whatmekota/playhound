import { describe, expect, it } from 'vitest'
import { scriptInputAccept, splitPickedScripts } from '../src/lib/browserApi'

describe('picking scripts by hand', () => {
  it('filters by .funscript on desktop, not on Android', () => {
    expect(scriptInputAccept('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/140.0')).toEqual(['.funscript'])
    expect(scriptInputAccept('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/140.0 Mobile Safari/537.36')).toEqual([])
  })

  it('keeps funscripts and refuses the rest', () => {
    const picked = [{ name: 'a.funscript' }, { name: 'b.roll.FUNSCRIPT' }, { name: 'c.mp4' }, { name: 'funscript.txt' }]
    const { scripts, refused } = splitPickedScripts(picked)
    expect(scripts.map(f => f.name)).toEqual(['a.funscript', 'b.roll.FUNSCRIPT'])
    expect(refused.map(f => f.name)).toEqual(['c.mp4', 'funscript.txt'])
  })
})
