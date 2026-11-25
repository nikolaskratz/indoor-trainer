import { describe, expect, it } from 'vitest'
import { bestAveragePower, rampCooldownIndex, rampTestResult, rampTestWorkout } from './ftpTest.ts'
import { RideSession, type RideIO, type RideSample } from './ride.ts'
import { flatten, validateWorkout } from './workout.ts'

const sample = (t: number, powerW: number | null, hrBpm: number | null = null): RideSample => ({
  t,
  ts: t * 1000,
  pos: t,
  powerW,
  targetW: null,
  cadenceRpm: 90,
  hrBpm,
  speedKph: 30,
  distanceM: t * 8,
  segment: 0,
})

/** A rider on the ramp test who holds every target, then stops after `rampMinutes` of the ramp. */
function rideRamp(ftp: number, rampMinutes: number): RideSample[] {
  const segments = flatten(rampTestWorkout().blocks)
  const out: RideSample[] = []
  for (const seg of segments.slice(0, 1 + rampMinutes)) {
    for (let s = 0; s < seg.durationS; s++) out.push(sample(out.length + 1, Math.round(seg.power * ftp), 120 + out.length / 20))
  }
  return out
}

describe('rampTestWorkout', () => {
  const workout = rampTestWorkout()
  const segments = flatten(workout.blocks)

  it('is a valid workout: warm-up, one-minute steps rising by 6 % of FTP, cool-down', () => {
    expect(validateWorkout(workout.blocks)).toEqual([])
    expect(workout.test).toBe('ramp')
    expect(segments[0]).toMatchObject({ durationS: 300, power: 0.46 })
    expect(segments[1]).toMatchObject({ durationS: 60, power: 0.52 })
    expect(segments[2]).toMatchObject({ durationS: 60, power: 0.58 })
    const ramp = segments.slice(1, -1)
    expect(ramp.every((s) => s.durationS === 60)).toBe(true)
    // Far beyond anyone's limit, so the ramp never runs out
    expect(ramp[ramp.length - 1].power).toBeGreaterThanOrEqual(2.4)
    expect(segments[segments.length - 1].kind).toBe('cooldown')
    expect(rampCooldownIndex(workout)).toBe(segments.length - 1)
  })
})

describe('bestAveragePower', () => {
  it('finds the best window', () => {
    const samples = [100, 100, 300, 300, 100].map((p, i) => sample(i + 1, p))
    expect(bestAveragePower(samples, 2)).toBe(300)
    expect(bestAveragePower(samples, 3)).toBeCloseTo(700 / 3)
    expect(bestAveragePower(samples, 5)).toBe(180)
  })

  it('counts seconds without a reading as zero and needs a full window', () => {
    expect(bestAveragePower([sample(1, 200), sample(2, null)], 2)).toBe(100)
    expect(bestAveragePower([sample(1, 200)], 2)).toBeNull()
  })
})

describe('rampTestResult', () => {
  it('confirms the FTP of a rider who fails where the theory says', () => {
    // FTP 250 W: best minute should be 250 / 0.75 = 333 W, the 15th ramp minute (136 %) is 340 W.
    const result = rampTestResult(rideRamp(250, 15), 250)!
    expect(result.bestMinuteW).toBe(340)
    expect(result.ftpW).toBe(255)
    expect(result.early).toBe(false)
    expect(result.maxHrBpm).toBeGreaterThan(150)
  })

  it('raises the FTP of a rider who lasts longer, and lowers it for one who stops sooner', () => {
    expect(rampTestResult(rideRamp(250, 18), 250)!.ftpW).toBe(289) // 154 % of 250 = 385 W
    expect(rampTestResult(rideRamp(250, 12), 250)!.ftpW).toBe(221) // 118 % of 250 = 295 W
  })

  it('flags a test that stopped before reaching the current FTP', () => {
    const result = rampTestResult(rideRamp(250, 6), 250)!
    expect(result.ftpW).toBe(154) // 82 % of 250 = 205 W
    expect(result.early).toBe(true)
  })

  it('gives no result without a minute of power', () => {
    expect(rampTestResult([], 250)).toBeNull()
    expect(rampTestResult(rideRamp(250, 0).slice(0, 30), 250)).toBeNull()
    expect(rampTestResult(Array.from({ length: 90 }, (_, i) => sample(i + 1, null)), 250)).toBeNull()
  })
})

describe('jumping to the cool-down', () => {
  it('moves the ride to the last step, sends its target and keeps recording', () => {
    let now = 0
    const targets: (number | null)[] = []
    const io: RideIO = {
      now: () => now,
      setTarget: (w) => targets.push(w),
      live: () => ({ powerW: 200, cadenceRpm: 90, hrBpm: 150 }),
      takeSecond: () => ({ powerW: 200, cadenceRpm: 90, hrBpm: 150 }),
    }
    const workout = rampTestWorkout()
    const ride = new RideSession(workout, { ftp: 250, weightKg: 75, maxHr: null, thresholdHr: null }, io, { autoPause: false })
    ride.start()
    for (let i = 0; i < 400; i++) {
      now += 1000
      ride.tick()
    }
    expect(ride.getView().segment?.index).toBe(2) // 5 min warm-up, then the second ramp minute
    ride.jumpTo(rampCooldownIndex(workout))
    const view = ride.getView()
    expect(view.segment?.kind).toBe('cooldown')
    expect(view.segmentRemainingS).toBe(600)
    expect(targets[targets.length - 1]).toBe(100) // 40 % of 250 W
    now += 1000
    ride.tick()
    expect(ride.samples.length).toBe(401)
    expect(ride.getView().status).toBe('running')
  })
})
