// The FTP test: a ramp test. After a warm-up the target rises every minute until the
// rider cannot hold it any more. FTP is estimated as 75 % of the best one-minute power,
// the usual rule for one-minute ramps.

import type { RideSample } from './ride.ts'
import type { Block, Workout } from './workout.ts'

export const RAMP_TEST_ID = 'builtin-ramp-test'

const WARMUP_S = 5 * 60
const STEP_S = 60
const COOLDOWN_S = 10 * 60
/** Warm-up target, and the base the ramp climbs from. */
const START = 0.46
/** Each minute is this much of FTP harder than the one before. */
const RISE = 0.06
/** The ramp goes far beyond what anyone can ride, so it never runs out. */
const TOP = 2.5
export const FTP_SHARE_OF_BEST_MINUTE = 0.75

/** The ramp test, scaled to the rider's current FTP like every other workout. */
export function rampTestWorkout(): Workout {
  const blocks: Block[] = [{ type: 'step', kind: 'warmup', durationS: WARMUP_S, power: START, label: 'Warm-up' }]
  for (let i = 1; START + RISE * i <= TOP + 1e-9; i++) {
    const power = Math.round((START + RISE * i) * 100) / 100
    blocks.push({ type: 'step', kind: 'work', durationS: STEP_S, power, label: `Ramp minute ${i}` })
  }
  blocks.push({ type: 'step', kind: 'cooldown', durationS: COOLDOWN_S, power: 0.4, label: 'Cool-down' })
  return {
    id: RAMP_TEST_ID,
    name: 'FTP test (ramp)',
    description:
      'Five easy minutes, then the target rises every minute. Stay seated and ride until you cannot hold the target any more. Your FTP is estimated from your best minute.',
    blocks,
    source: 'builtin',
    test: 'ramp',
    createdAt: '2026-11-25T00:00:00.000Z',
  }
}

/** Index of the cool-down in the flattened ramp test (its last step). */
export const rampCooldownIndex = (workout: Workout): number => workout.blocks.length - 1

/** Minutes most riders spend on the test, warm-up and cool-down included, for display. */
export const RAMP_TYPICAL_MINUTES = '30 to 35'

/**
 * Highest average power over any `windowS` consecutive seconds of riding, or null when the
 * ride is shorter than the window. Seconds without a reading count as zero.
 */
export function bestAveragePower(samples: RideSample[], windowS: number): number | null {
  if (samples.length < windowS || windowS <= 0) return null
  let sum = 0
  let best = -1
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i].powerW ?? 0
    if (i >= windowS) sum -= samples[i - windowS].powerW ?? 0
    if (i >= windowS - 1 && sum > best) best = sum
  }
  return best / windowS
}

export interface RampResult {
  bestMinuteW: number
  /** Estimated FTP in watts. */
  ftpW: number
  maxHrBpm: number | null
  /**
   * True when the rider stopped before the ramp reached the FTP the test was scaled to:
   * the test was cut short and the estimate is too low.
   */
  early: boolean
}

/** The test result from a recorded ride; null when there is less than a minute of power data. */
export function rampTestResult(samples: RideSample[], ftpUsed: number): RampResult | null {
  const best = bestAveragePower(samples, 60)
  if (best === null || best <= 0) return null
  const hr = samples.map((s) => s.hrBpm).filter((h): h is number => h !== null)
  return {
    bestMinuteW: Math.round(best),
    ftpW: Math.round(best * FTP_SHARE_OF_BEST_MINUTE),
    maxHrBpm: hr.length ? Math.max(...hr) : null,
    early: best < ftpUsed,
  }
}
