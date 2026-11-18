import { OutputType } from 'buttplug'
import { describe, expect, it } from 'vitest'
import { motorsOf, toyName } from '~/composables/useButtplug'

/** A device with these features, each a list of the outputs it has. */
function toy(features: OutputType[][]): any {
  const map = new Map(features.map((outs, index) => [index, { index, hasOutput: (t: OutputType) => outs.includes(t) }]))
  return { features: map, hasOutput: (t: OutputType) => features.some(f => f.includes(t)) }
}

describe('a toy\'s motors', () => {
  it('lists each motor once, numbering the ones of a kind', () => {
    expect(motorsOf(toy([[OutputType.Vibrate], [OutputType.Vibrate]])).map(m => [m.feature, m.label]))
      .toEqual([[0, 'Vibration 1'], [1, 'Vibration 2']])
    expect(motorsOf(toy([[OutputType.Vibrate], [OutputType.Rotate]])).map(m => m.label)).toEqual(['Vibration', 'Rotation'])
  })

  it('leaves a stroker\'s oscillate alone', () => {
    expect(motorsOf(toy([[OutputType.HwPositionWithDuration, OutputType.Oscillate]]))).toEqual([])
  })

  it('goes by the name given in Intiface when there is one', () => {
    expect(toyName({ name: 'Lovense Lush', displayName: 'Left one' } as any)).toBe('Left one')
    expect(toyName({ name: 'Lovense Lush', displayName: '  ' } as any)).toBe('Lovense Lush')
  })
})
