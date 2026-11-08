import { describe, expect, it } from 'vitest'
import { classifyPostScripts, pickVideo, scriptsForVideo } from '~/lib/postScripts'

const axes = (names: string[]) => Object.fromEntries(classifyPostScripts(names).map(s => [s.filename, s.suffix]))

describe('classifyPostScripts', () => {
  it('reads axes against the sibling scripts, not the video', () => {
    expect(axes(['Heart Pie.funscript', 'Heart Pie.roll.funscript', 'Heart Pie.twist.funscript'])).toEqual({
      'Heart Pie.funscript': 'default',
      'Heart Pie.roll.funscript': 'roll',
      'Heart Pie.twist.funscript': 'twist',
    })
  })

  it('understands axis tails without a stroke sibling', () => {
    expect(axes(['Song_L0.funscript', 'Song_R1.funscript', 'Song (pitch).funscript', 'Song - surge.funscript'])).toEqual({
      'Song_L0.funscript': 'l0',
      'Song_R1.funscript': 'r1',
      'Song (pitch).funscript': 'pitch',
      'Song - surge.funscript': 'surge',
    })
  })

  it('does not take a word ending in an axis name for one', () => {
    expect(axes(['Rabbit Hole.funscript'])['Rabbit Hole.funscript']).toBe('default')
    expect(axes(['Bankroll.funscript'])['Bankroll.funscript']).toBe('default')
  })
})

describe('scriptsForVideo', () => {
  const two = classifyPostScripts(['Miku Rabbit Hole.funscript', 'Miku Rabbit Hole.roll.funscript', 'Sanae Heart Pie.funscript'])

  it('loads a single set whatever the video is called', () => {
    const one = classifyPostScripts(['Song.roll.funscript', 'Song.funscript'])
    expect(scriptsForVideo(one, { title: 'v1234_final_1080p' }).map(s => s.filename)).toEqual(['Song.funscript', 'Song.roll.funscript'])
  })

  it('picks the set sharing the most words with the video', () => {
    expect(scriptsForVideo(two, { title: '[Krayzee] Rabbit Hole', index: 0, count: 2 }).map(s => s.filename))
      .toEqual(['Miku Rabbit Hole.funscript', 'Miku Rabbit Hole.roll.funscript'])
  })

  it('falls back to post order, then to everything', () => {
    expect(scriptsForVideo(two, { title: 'part2.mp4', index: 1, count: 2 }).map(s => s.filename)).toEqual(['Sanae Heart Pie.funscript'])
    expect(scriptsForVideo(two, { title: 'part2.mp4', index: 0, count: 3 })).toHaveLength(3)
  })

  it('gives each video of a folder the sets named closest to it', () => {
    const rem = classifyPostScripts(['rem hj.funscript', 'rem hj full.funscript', 'rem(oni) hj.funscript'])
    const titles = ['rem(oni).mp4', 'rem.mp4']
    expect(scriptsForVideo(rem, { title: 'rem(oni).mp4', index: 0, count: 2, titles }).map(s => s.filename)).toEqual(['rem(oni) hj.funscript'])
    expect(scriptsForVideo(rem, { title: 'rem.mp4', index: 1, count: 2, titles }).map(s => s.filename)).toEqual(['rem hj.funscript', 'rem hj full.funscript'])
  })

  it('falls back when the names settle nothing', () => {
    expect(scriptsForVideo(two, { title: 'a.mp4', index: 1, count: 2, titles: ['a.mp4', 'b.mp4'] }).map(s => s.filename)).toEqual(['Sanae Heart Pie.funscript'])
  })
})

describe('pickVideo', () => {
  const folder = ['NIKKE-trailer-4K.mp4', 'remote_control.mp4', 'S085_001 papa.mp4', 'STARS-804 Sense Cut - Chapter 1.mp4']

  it('finds the post video in a big folder by the script names', () => {
    expect(pickVideo(folder, ['S085_001.funscript', 'S085_001.roll.funscript'])).toBe(2)
  })

  it('leaves the choice alone when nothing stands out', () => {
    expect(pickVideo(folder, ['something else.funscript'])).toBe(-1)
    expect(pickVideo(['a part.mp4', 'b part.mp4'], ['part.funscript'])).toBe(-1)
    expect(pickVideo(['only.mp4'], ['only.funscript'])).toBe(-1)
  })
})
