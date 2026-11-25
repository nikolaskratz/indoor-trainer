import { rampTestWorkout } from './ftpTest.ts'
import type { Block, Step, StepKind, Workout } from './workout.ts'

const step = (kind: StepKind, minutes: number, power: number, extra: Partial<Step> = {}): Step => ({
  type: 'step',
  kind,
  durationS: Math.round(minutes * 60),
  power,
  ...extra,
})
const repeat = (count: number, blocks: Block[]): Block => ({ type: 'repeat', count, blocks })

const builtin = (id: string, name: string, description: string, blocks: Block[]): Workout => ({
  id: `builtin-${id}`,
  name,
  description,
  blocks,
  source: 'builtin',
  createdAt: '2026-11-24T00:00:00.000Z',
})

/** Ready-made workouts, available before any are generated. */
export const BUILTIN_WORKOUTS: Workout[] = [
  builtin('quick-check', 'Quick check (8 min)', 'A short ride with a few steps and one ramp, to try the trainer control.', [
    step('warmup', 2, 0.5, { powerEnd: 0.7 }),
    step('steady', 1.5, 0.75),
    repeat(2, [step('work', 0.5, 1.05), step('recovery', 0.5, 0.55)]),
    step('steady', 1.5, 0.8),
    step('cooldown', 1, 0.6, { powerEnd: 0.45 }),
  ]),
  builtin('z2-45', 'Easy Z2 with variations (45 min)', 'Endurance riding between 62 and 74 % of FTP with small changes to keep it interesting.', [
    step('warmup', 6, 0.5, { powerEnd: 0.65 }),
    repeat(3, [
      step('steady', 5, 0.66, { label: 'Endurance' }),
      step('steady', 3, 0.72, { label: 'Upper endurance' }),
      step('steady', 2, 0.62, { label: 'Easy spin', cadence: 95 }),
      step('steady', 1, 0.74, { label: 'Lift' }),
    ]),
    step('cooldown', 6, 0.6, { powerEnd: 0.45 }),
  ]),
  builtin('vo2-30-30', 'VO2 max 3 x 10 x 30/30', 'Three sets of ten 30-second efforts at 120 % of FTP with 30 seconds easy, 5 minutes between sets.', [
    step('warmup', 10, 0.5, { powerEnd: 0.75 }),
    repeat(2, [step('work', 0.5, 1.1, { label: 'Opener' }), step('recovery', 1, 0.5)]),
    step('recovery', 2, 0.5),
    repeat(3, [
      repeat(10, [step('work', 0.5, 1.2, { label: 'VO2 max' }), step('recovery', 0.5, 0.5, { label: 'Easy' })]),
      step('recovery', 5, 0.5, { label: 'Set recovery' }),
    ]),
    step('cooldown', 5, 0.55, { powerEnd: 0.4 }),
  ]),
  builtin('sweet-spot', 'Sweet spot 3 x 12', 'Three 12-minute blocks at 90 % of FTP with 4 minutes easy in between.', [
    step('warmup', 10, 0.5, { powerEnd: 0.75 }),
    repeat(3, [step('work', 12, 0.9, { label: 'Sweet spot' }), step('recovery', 4, 0.55)]),
    step('cooldown', 6, 0.55, { powerEnd: 0.4 }),
  ]),
  rampTestWorkout(),
]
