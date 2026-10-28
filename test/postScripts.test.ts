import { describe, expect, it } from 'vitest'
import { classifyPostScripts, scriptsForVideo } from '~/lib/postScripts'

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
})
