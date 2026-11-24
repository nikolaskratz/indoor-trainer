import { describe, expect, it } from 'vitest'
import { BUILTIN_WORKOUTS } from './builtin.ts'
import { summarize } from './metrics.ts'
import { bikeModel, steadySpeed, stepSpeed } from './physics.ts'
import type { RideSample } from './ride.ts'
import { buildTcx, rideFileName } from './tcx.ts'
import {
  flatten,
  formatDuration,
  normalized,
  powerAt,
  segmentAt,
  totalDuration,
  validateWorkout,
  workoutStats,
  type Block,
} from './workout.ts'
import { hrZone, powerZone, powerZoneTable } from './zones.ts'

const step = (durationS: number, power: number, extra: object = {}): Block => ({
  type: 'step',
  kind: 'steady',
  durationS,
  power,
  ...extra,
})

describe('workout', () => {
  const blocks: Block[] = [
    step(60, 0.5, { powerEnd: 0.7, kind: 'warmup' }),
    {
      type: 'repeat',
      count: 2,
      blocks: [
        { type: 'repeat', count: 3, blocks: [step(30, 1.2, { kind: 'work', label: 'On' }), step(30, 0.5, { kind: 'recovery' })] },
        step(120, 0.5, { label: 'Set recovery' }),
      ],
    },
  ]
  const segments = flatten(blocks)

  it('expands nested repeats in order with their position', () => {
    expect(segments).toHaveLength(1 + 2 * (6 + 1))
    expect(totalDuration(segments)).toBe(60 + 2 * (180 + 120))
    expect(segments[1]).toMatchObject({ label: 'On', rep: '1/2 · 1/3', startS: 60, endS: 90 })
    expect(segments[2]).toMatchObject({ label: 'Recovery', rep: '1/2 · 1/3' })
    expect(segments[7]).toMatchObject({ label: 'Set recovery', rep: '1/2', startS: 240 })
    expect(segments[8]).toMatchObject({ label: 'On', rep: '2/2 · 1/3', startS: 360 })
    expect(segments.map((s) => s.index)).toEqual(segments.map((_, i) => i))
  })

  it('finds the segment at a position, with boundaries going to the later one', () => {
    expect(segmentAt(segments, 0)?.index).toBe(0)
    expect(segmentAt(segments, 59.9)?.index).toBe(0)
    expect(segmentAt(segments, 60)?.index).toBe(1)
    expect(segmentAt(segments, 659)?.index).toBe(14)
    expect(segmentAt(segments, 660)).toBeNull()
  })

  it('interpolates ramps', () => {
    expect(powerAt(segments[0], 0)).toBeCloseTo(0.5)
    expect(powerAt(segments[0], 30)).toBeCloseTo(0.6)
    expect(powerAt(segments[0], 60)).toBeCloseTo(0.7)
    expect(powerAt(segments[1], 75)).toBe(1.2)
  })

  it('computes planned load', () => {
    const steady = workoutStats(flatten([step(3600, 1)]))
    expect(steady.intensityFactor).toBeCloseTo(1)
    expect(steady.tss).toBeCloseTo(100)
    expect(steady.workPerFtpKJ).toBeCloseTo(3.6)
    const easy = workoutStats(flatten([step(1800, 0.7)]))
    expect(easy.tss).toBeCloseTo(24.5)
    // Intervals count for more than their average
    const intervals = workoutStats(segments)
    expect(intervals.intensityFactor).toBeGreaterThan(intervals.avgPower)
  })

  it('normalized power of a short ride is the plain average', () => {
    expect(normalized([100, 200])).toBe(150)
    expect(normalized([])).toBe(0)
  })

  it('accepts the built-in workouts and rejects unsafe ones', () => {
    for (const w of BUILTIN_WORKOUTS) expect(validateWorkout(w.blocks), w.name).toEqual([])
    expect(validateWorkout([])).toEqual(['The workout has no steps.'])
    expect(validateWorkout([step(60, 3)])[0]).toContain('300 %')
    expect(validateWorkout([step(2, 1)])[0]).toContain('minimum is 5 s')
    expect(validateWorkout([{ type: 'repeat', count: 0, blocks: [step(60, 1)] }])[0]).toContain('Repeat count')
    expect(validateWorkout([step(7 * 3600, 0.6)])).toEqual(['The workout is longer than 6 hours.'])
  })

  it('has the advertised built-in durations', () => {
    const minutes = (id: string) =>
      totalDuration(flatten(BUILTIN_WORKOUTS.find((w) => w.id === `builtin-${id}`)!.blocks)) / 60
    expect(minutes('quick-check')).toBe(8)
    expect(minutes('z2-45')).toBe(45)
    expect(minutes('vo2-30-30')).toBe(65)
    expect(minutes('sweet-spot')).toBe(64)
  })

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(75)).toBe('1:15')
    expect(formatDuration(3723)).toBe('1:02:03')
  })
})

describe('zones', () => {
  it('maps fractions of FTP to power zones', () => {
    expect(powerZone(0.5).zone).toBe(1)
    expect(powerZone(0.65).zone).toBe(2)
    expect(powerZone(0.9).zone).toBe(3)
    expect(powerZone(1.0).zone).toBe(4)
    expect(powerZone(1.2).zone).toBe(5)
    expect(powerZone(1.5).zone).toBe(6)
    expect(powerZone(2).zone).toBe(7)
  })

  it('builds a gap-free watt table', () => {
    const table = powerZoneTable(250)
    expect(table[0]).toMatchObject({ fromW: 0, toW: 138 })
    expect(table[1]).toMatchObject({ fromW: 139, toW: 188 })
    expect(table[6]).toMatchObject({ fromW: 376, toW: null })
  })

  it('derives heart rate zones from threshold, or from max when threshold is unknown', () => {
    expect(hrZone(120, 165, null)?.zone).toBe(1)
    expect(hrZone(150, 165, null)?.zone).toBe(3)
    expect(hrZone(170, 165, null)?.zone).toBe(5)
    expect(hrZone(150, null, 185)?.zone).toBe(3)
    expect(hrZone(150, null, null)).toBeNull()
  })
})

describe('speed model', () => {
  const model = bikeModel(75)

  it('gives a plausible flat-road speed', () => {
    const kph = steadySpeed(model, 200) * 3.6
    expect(kph).toBeGreaterThan(30)
    expect(kph).toBeLessThan(35)
    expect(steadySpeed(model, 0)).toBe(0)
  })

  it('accelerates to the steady speed and coasts down', () => {
    let v = 0
    for (let i = 0; i < 300; i++) v = stepSpeed(model, v, 200, 1)
    expect(v).toBeCloseTo(steadySpeed(model, 200), 1)
    const after5s = stepSpeed(model, v, 0, 5)
    expect(after5s).toBeLessThan(v)
    expect(after5s).toBeGreaterThan(v * 0.7)
    for (let i = 0; i < 600; i++) v = stepSpeed(model, v, 0, 1)
    expect(v).toBe(0)
  })
})

const sample = (t: number, patch: Partial<RideSample> = {}): RideSample => ({
  t,
  ts: Date.UTC(2026, 10, 24, 18, 0, t),
  pos: t,
  powerW: 200,
  targetW: 200,
  cadenceRpm: 90,
  hrBpm: 140,
  speedKph: 32.4,
  distanceM: t * 9,
  segment: t <= 60 ? 0 : 1,
  ...patch,
})

describe('ride summary', () => {
  it('summarizes a steady ride', () => {
    const samples = Array.from({ length: 3600 }, (_, i) => sample(i + 1))
    const s = summarize(samples, 250)
    expect(s).toMatchObject({
      durationS: 3600,
      distanceM: 32400,
      elevationM: 0,
      avgPowerW: 200,
      normalizedPowerW: 200,
      intensityFactor: 0.8,
      tss: 64,
      workKJ: 720,
      avgHrBpm: 140,
      maxHrBpm: 140,
      avgCadenceRpm: 90,
      avgSpeedKph: 32.4,
    })
  })

  it('copes with missing sensors and ignores coasting in cadence', () => {
    const samples = [
      sample(1, { powerW: null, hrBpm: null, cadenceRpm: 0 }),
      sample(2, { powerW: null, hrBpm: null, cadenceRpm: 80 }),
    ]
    const s = summarize(samples, 250)
    expect(s.avgPowerW).toBeNull()
    expect(s.tss).toBeNull()
    expect(s.avgHrBpm).toBeNull()
    expect(s.avgCadenceRpm).toBe(80)
    expect(summarize([], 250).durationS).toBe(0)
  })
})

describe('TCX export', () => {
  const segments = flatten([step(60, 0.8, { label: 'Warm & "easy"' }), step(60, 0.5, { kind: 'recovery' })])
  const samples = Array.from({ length: 120 }, (_, i) => sample(i + 1))
  const tcx = buildTcx({ name: 'Test <ride>', notes: 'A & B', startTs: samples[0].ts - 1000, samples, segments })

  it('writes one lap per workout step with all trackpoints', () => {
    expect(tcx.match(/<Lap /g)).toHaveLength(2)
    expect(tcx.match(/<Trackpoint>/g)).toHaveLength(120)
    expect(tcx).toContain('<Lap StartTime="2026-11-24T18:00:01Z">')
    expect(tcx).toContain('<Lap StartTime="2026-11-24T18:01:01Z">')
    expect(tcx).toContain('<TotalTimeSeconds>60</TotalTimeSeconds><DistanceMeters>540.0</DistanceMeters>')
    expect(tcx).toContain('<Intensity>Resting</Intensity>')
  })

  it('carries power, heart rate, cadence, speed and distance', () => {
    expect(tcx).toContain(
      '<Trackpoint><Time>2026-11-24T18:00:01Z</Time><DistanceMeters>9.0</DistanceMeters>' +
        '<HeartRateBpm><Value>140</Value></HeartRateBpm><Cadence>90</Cadence>' +
        '<Extensions><ns3:TPX><ns3:Speed>9.00</ns3:Speed><ns3:Watts>200</ns3:Watts></ns3:TPX></Extensions></Trackpoint>',
    )
    expect(tcx).toContain('<ns3:AvgWatts>200</ns3:AvgWatts>')
    expect(tcx).toContain('<Calories>12</Calories>')
  })

  it('escapes text and leaves out missing sensors', () => {
    expect(tcx).toContain('<Notes>A &amp; B</Notes>')
    expect(tcx).toContain('Warm &amp; &quot;easy&quot;')
    expect(tcx).toContain('<Name>Test &lt;ride&gt;</Name>')
    const bare = buildTcx({
      name: 'x',
      notes: '',
      startTs: 0,
      samples: [sample(1, { powerW: null, hrBpm: null, cadenceRpm: null })],
      segments,
    })
    expect(bare).not.toContain('HeartRateBpm')
    expect(bare).not.toContain('Watts')
    expect(bare).not.toContain('<Cadence>')
    expect(() => buildTcx({ name: 'x', notes: '', startTs: 0, samples: [], segments })).toThrow()
  })

  it('names the file by date and workout', () => {
    expect(rideFileName('VO2 max 3 x 10 x 30/30', Date.UTC(2026, 10, 24))).toBe('2026-11-24-vo2-max-3-x-10-x-30-30.tcx')
  })
})
