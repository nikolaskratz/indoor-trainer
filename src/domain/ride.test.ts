import { describe, expect, it } from 'vitest'
import { RideSession, type LiveReading, type RideIO, type RiderProfile } from './ride.ts'
import type { Block, Workout } from './workout.ts'

const step = (durationS: number, power: number, extra: object = {}): Block => ({
  type: 'step',
  kind: 'steady',
  durationS,
  power,
  ...extra,
})

const workout = (blocks: Block[]): Workout => ({
  id: 'w',
  name: 'Test',
  description: '',
  blocks,
  source: 'builtin',
  createdAt: '2026-11-24T00:00:00.000Z',
})

const profile: RiderProfile = { ftp: 200, weightKg: 75, maxHr: 185, thresholdHr: 165 }

/** A fake world: a clock the test advances, a rider with fixed readings, and a record of what was sent. */
function rig(blocks: Block[], autoPause = true) {
  const world = {
    now: 1_000_000,
    reading: { powerW: 150, cadenceRpm: 90, hrBpm: 130 } as LiveReading,
    targets: [] as (number | null)[],
    cues: [] as string[],
  }
  const io: RideIO = {
    now: () => world.now,
    setTarget: (w) => world.targets.push(w),
    live: () => world.reading,
    takeSecond: () => world.reading,
    cue: (kind) => world.cues.push(kind),
  }
  const ride = new RideSession(workout(blocks), profile, io, { autoPause })
  /** Advances the clock in 250 ms ticks. */
  const run = (seconds: number) => {
    for (let i = 0; i < seconds * 4; i++) {
      world.now += 250
      ride.tick()
    }
  }
  return { world, io, ride, run }
}

describe('ride session', () => {
  it('walks through the steps and sends each new target once', () => {
    const { world, ride, run } = rig([step(10, 0.5), step(10, 1.0), step(10, 0.6)])
    expect(ride.getView().status).toBe('ready')
    ride.start()
    expect(world.targets).toEqual([100])
    run(10)
    expect(ride.getView().segment?.index).toBe(1)
    expect(world.targets).toEqual([100, 200])
    run(10)
    expect(world.targets).toEqual([100, 200, 120])
    run(10)
    expect(ride.getView().status).toBe('finished')
    // Finishing releases the trainer
    expect(world.targets).toEqual([100, 200, 120, null])
    expect(ride.samples).toHaveLength(30)
  })

  it('records one sample per second with position, target and distance', () => {
    const { ride, run } = rig([step(10, 0.5), step(10, 1.0)])
    ride.start()
    run(12)
    expect(ride.samples).toHaveLength(12)
    expect(ride.samples[0]).toMatchObject({ t: 1, pos: 1, powerW: 150, targetW: 100, cadenceRpm: 90, hrBpm: 130, segment: 0 })
    expect(ride.samples[9]).toMatchObject({ t: 10, segment: 0, targetW: 100 })
    expect(ride.samples[10]).toMatchObject({ t: 11, segment: 1, targetW: 200 })
    expect(ride.samples[11].ts - ride.samples[10].ts).toBe(1000)
    const distances = ride.samples.map((s) => s.distanceM)
    expect(distances[11]).toBeGreaterThan(distances[5])
    expect(ride.getView().distanceM).toBeCloseTo(distances[11], 0)
  })

  it('updates a ramp target every second', () => {
    const { world, ride, run } = rig([step(10, 0.5, { powerEnd: 1.0 })])
    ride.start()
    run(5)
    expect(world.targets).toEqual([100, 110, 120, 130, 140, 150])
  })

  it('pauses on request: the clock stops and the target drops to an easy value', () => {
    const { world, ride, run } = rig([step(20, 1.2)])
    ride.start()
    run(5)
    ride.pause()
    expect(world.targets).toEqual([240, 100])
    run(30)
    expect(ride.getView()).toMatchObject({ status: 'paused', activeS: 5, positionS: 5 })
    ride.resume()
    expect(world.targets).toEqual([240, 100, 240])
    run(5)
    expect(ride.getView()).toMatchObject({ status: 'running', activeS: 10 })
  })

  it('pauses by itself when pedalling stops and resumes when it starts again', () => {
    const { world, ride, run } = rig([step(60, 1.0)])
    ride.start()
    run(5)
    world.reading = { powerW: 0, cadenceRpm: 0, hrBpm: 130 }
    run(2)
    expect(ride.getView().status).toBe('running')
    run(2)
    expect(ride.getView().status).toBe('autopaused')
    const at = ride.getView().activeS
    run(20)
    expect(ride.getView().activeS).toBe(at)
    world.reading = { powerW: 80, cadenceRpm: 70, hrBpm: 125 }
    run(1)
    expect(ride.getView().status).toBe('running')
    expect(world.targets).toEqual([200, 100, 200])
  })

  it('does not pause by itself when switched off or without a power signal', () => {
    const off = rig([step(60, 1.0)], false)
    off.ride.start()
    off.world.reading = { powerW: 0, cadenceRpm: 0, hrBpm: null }
    off.run(10)
    expect(off.ride.getView().status).toBe('running')

    const noTrainer = rig([step(60, 1.0)])
    noTrainer.ride.start()
    noTrainer.world.reading = { powerW: null, cadenceRpm: null, hrBpm: null }
    noTrainer.run(10)
    expect(noTrainer.ride.getView().status).toBe('running')
    expect(noTrainer.ride.samples[0].powerW).toBeNull()
  })

  it('skips to the next step and finishes when skipping the last one', () => {
    const { world, ride, run } = rig([step(60, 0.5), step(60, 1.0)])
    ride.start()
    run(5)
    ride.skip()
    expect(ride.getView()).toMatchObject({ positionS: 60, activeS: 5 })
    expect(ride.getView().segment?.index).toBe(1)
    expect(world.targets).toEqual([100, 200])
    ride.skip()
    expect(ride.getView().status).toBe('finished')
    expect(ride.samples).toHaveLength(5)
  })

  it('scales targets with the intensity setting, within limits', () => {
    const { world, ride } = rig([step(60, 1.0)])
    ride.start()
    ride.adjustIntensity(0.05)
    ride.adjustIntensity(0.05)
    expect(ride.getView().intensity).toBe(1.1)
    expect(world.targets).toEqual([200, 210, 220])
    for (let i = 0; i < 30; i++) ride.adjustIntensity(-0.05)
    expect(ride.getView().intensity).toBe(0.5)
  })

  it('gives countdown cues before a step change and one at the change', () => {
    const { world, ride, run } = rig([step(10, 0.5), step(10, 1.0)])
    ride.start()
    run(10)
    expect(world.cues).toEqual(['countdown', 'countdown', 'countdown', 'change'])
    run(10)
    expect(world.cues.slice(-1)).toEqual(['finish'])
  })

  it('treats a long gap between ticks as a pause, not as riding time', () => {
    const { world, ride, run } = rig([step(600, 0.5)])
    ride.start()
    run(5)
    world.now += 120_000 // laptop slept
    ride.tick()
    run(5)
    expect(ride.getView().activeS).toBe(10)
  })

  it('catches up whole seconds after a short stall', () => {
    const { world, ride } = rig([step(600, 0.5)])
    ride.start()
    world.now += 3200
    ride.tick()
    expect(ride.samples.map((s) => s.t)).toEqual([1, 2, 3])
    expect(ride.samples.map((s) => s.ts - ride.startTs)).toEqual([1000, 2000, 3000])
  })

  it('resumes from a snapshot, paused, with averages intact', () => {
    const first = rig([step(30, 0.5), step(30, 1.0)])
    first.ride.start()
    first.run(35)
    first.ride.adjustIntensity(0.1)
    const saved = JSON.parse(JSON.stringify(first.ride.snapshot()))

    const second = rig([])
    const restored = RideSession.restore(saved, second.io, { autoPause: true })
    const view = restored.getView()
    expect(view).toMatchObject({ status: 'paused', positionS: 35, activeS: 35, intensity: 1.1, avgPowerW: 150, sampleCount: 35 })
    expect(view.segment?.index).toBe(1)
    restored.resume()
    expect(second.world.targets).toEqual([220])
    // `second.run` drives the rig's own ride, so tick the restored one directly.
    for (let i = 0; i < 100; i++) {
      second.world.now += 250
      restored.tick()
    }
    expect(restored.getView().status).toBe('finished')
    expect(restored.samples).toHaveLength(60)
    expect(restored.samples[59].distanceM).toBeGreaterThan(restored.samples[34].distanceM)
  })

  it('sends the target again on request, for a reconnected trainer', () => {
    const { world, ride } = rig([step(60, 1.0)])
    ride.start()
    ride.resendTarget()
    expect(world.targets).toEqual([200, 200])
  })
})
