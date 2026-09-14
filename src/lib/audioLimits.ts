/**
 * Psychoacoustic limits for the beat layer.
 *
 * These are perceptual constraints, not wellness claims: they bound what can
 * actually be heard as a beat at all.
 */

/**
 * Oster's limit: past roughly 35 Hz the two tones stop fusing into a beat and
 * are simply heard as two tones, so anything above this is not a beat at all.
 */
export const MAX_BEAT_HZ = 35

/**
 * Binaural beating needs the carrier below about 1 kHz, and perception is
 * widest around 250-450 Hz, which is also where most published work sits.
 */
export const CARRIER_MIN = 80
export const CARRIER_MAX = 900
export const CARRIER_RECOMMENDED: [number, number] = [250, 450]
