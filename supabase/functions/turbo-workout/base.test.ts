import { describe, expect, it } from 'vitest'
import { BUILTIN_WORKOUTS } from '../../../src/domain/builtin.ts'
import { flatten, totalDuration } from '../../../src/domain/workout.ts'
import { describeBase, readBase, totalSeconds } from './base.ts'

const step = (over: Record<string, unknown> = {}) => ({ type: 'step', kind: 'steady', durationS: 600, power: 0.65, ...over })

describe('readBase', () => {
  it('accepts every built-in workout and keeps its length', () => {
    for (const w of BUILTIN_WORKOUTS) {
      const base = readBase(w)
      expect(base, w.name).not.toBeNull()
      expect(totalSeconds(base!.blocks)).toBe(totalDuration(flatten(w.blocks)))
      expect(base!.name).toBe(w.name)
    }
  })

  it('keeps the first request and earlier changes, and drops unknown fields', () => {
    const base = readBase({
      name: ' Easy hour ',
      description: 'Steady riding.',
      prompt: '60 min easy',
      changes: ['shorter warm-up', 7, ''],
      blocks: [step({ label: ' Easy spin ', cadence: 90, secret: 'x', powerEnd: 0.65 })],
      id: 'w-1',
    })
    expect(base).toEqual({
      name: 'Easy hour',
      description: 'Steady riding.',
      prompt: '60 min easy',
      changes: ['shorter warm-up'],
      blocks: [{ type: 'step', kind: 'steady', durationS: 600, power: 0.65, label: 'Easy spin', cadence: 90 }],
    })
  })

  it('rejects what is not a usable workout', () => {
    const bad: unknown[] = [
      null,
      'text',
      {},
      { blocks: [] },
      { blocks: [step({ kind: 'sprint' })] },
      { blocks: [step({ durationS: 2 })] },
      { blocks: [step({ power: 4 })] },
      { blocks: [step({ powerEnd: 'high' })] },
      { blocks: [{ type: 'repeat', count: 0, blocks: [step()] }] },
      { blocks: [{ type: 'repeat', count: 2.5, blocks: [step()] }] },
      { blocks: [{ type: 'repeat', count: 2, blocks: [] }] },
      { blocks: Array.from({ length: 401 }, () => step()) },
    ]
    for (const raw of bad) expect(readBase(raw), JSON.stringify(raw)?.slice(0, 80)).toBeNull()
    // Four levels of repeats is one too many
    const nest = (depth: number): unknown => (depth === 0 ? step() : { type: 'repeat', count: 2, blocks: [nest(depth - 1)] })
    expect(readBase({ blocks: [nest(3)] })).not.toBeNull()
    expect(readBase({ blocks: [nest(4)] })).toBeNull()
  })
})

describe('describeBase', () => {
  it('writes the workout out in the field names of the answer', () => {
    const base = readBase({
      name: 'VO2 max 2 x 3 x 30/30',
      description: 'Two short sets.',
      prompt: '2x3x 30/30',
      changes: ['one more set', 'easier recoveries'],
      blocks: [
        { type: 'step', kind: 'warmup', durationS: 600, power: 0.5, powerEnd: 0.755, label: 'Warm-up' },
        {
          type: 'repeat',
          count: 2,
          blocks: [
            {
              type: 'repeat',
              count: 3,
              blocks: [
                { type: 'step', kind: 'work', durationS: 30, power: 1.2, label: 'VO2 max', cadence: 100 },
                { type: 'step', kind: 'recovery', durationS: 30, power: 0.5 },
              ],
            },
            { type: 'step', kind: 'recovery', durationS: 185, power: 0.5 },
          ],
        },
      ],
    })!
    const out = describeBase(base)
    expect(out).toContain('Name: VO2 max 2 x 3 x 30/30')
    expect(out).toContain('First requested as: 2x3x 30/30')
    expect(out).toContain('Changes already made:\n1. one more set\n2. easier recoveries')
    // 600 + 2 x (3 x 60 + 185) = 1330 s
    expect(out).toContain('Total length: 22 min 10 s')
    const steps = JSON.parse(out.slice(out.indexOf('[\n')))
    expect(steps).toEqual([
      { kind: 'warmup', duration_s: 600, power_pct: 50, power_end_pct: 75.5, label: 'Warm-up', cadence_rpm: null },
      {
        repeat: 2,
        steps: [
          {
            repeat: 3,
            steps: [
              { kind: 'work', duration_s: 30, power_pct: 120, power_end_pct: null, label: 'VO2 max', cadence_rpm: 100 },
              { kind: 'recovery', duration_s: 30, power_pct: 50, power_end_pct: null, label: null, cadence_rpm: null },
            ],
          },
          { kind: 'recovery', duration_s: 185, power_pct: 50, power_end_pct: null, label: null, cadence_rpm: null },
        ],
      },
    ])
  })

  it('leaves out what the workout does not have', () => {
    const out = describeBase(readBase({ name: 'Plain', blocks: [step()] })!)
    expect(out).not.toContain('Description:')
    expect(out).not.toContain('First requested as')
    expect(out).not.toContain('Changes already made')
    expect(out).toContain('Total length: 10 min')
  })
})
