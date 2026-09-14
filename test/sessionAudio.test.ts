import { describe, expect, it } from 'vitest'
import { CARRIER_MAX, CARRIER_MIN, CARRIER_RECOMMENDED, MAX_BEAT_HZ } from '../src/lib/audioLimits'

describe('audio limits', () => {
  it('caps the beat at Oster\'s fusion limit', () => {
    // Past ~35 Hz the tones stop fusing and are heard as two separate tones,
    // so anything above this is not a beat at all.
    expect(MAX_BEAT_HZ).toBe(35)
  })

  it('keeps the carrier inside the range where beats are perceptible', () => {
    // Binaural beating needs the carrier below roughly 1 kHz.
    expect(CARRIER_MAX).toBeLessThanOrEqual(1000)
    expect(CARRIER_MIN).toBeGreaterThan(0)
    expect(CARRIER_MIN).toBeLessThan(CARRIER_MAX)
  })

  it('recommends the band the literature actually uses', () => {
    const [lo, hi] = CARRIER_RECOMMENDED
    expect(lo).toBeGreaterThanOrEqual(200)
    expect(hi).toBeLessThanOrEqual(500)
    expect(lo).toBeLessThan(hi)
    // The recommended band must sit inside the perceptible one.
    expect(lo).toBeGreaterThanOrEqual(CARRIER_MIN)
    expect(hi).toBeLessThanOrEqual(CARRIER_MAX)
  })
})
