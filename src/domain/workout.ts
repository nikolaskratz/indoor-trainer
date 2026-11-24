// The workout model. Power is always a fraction of FTP (0.75 = 75 % of FTP), so a
// workout stays valid when FTP changes.

export type StepKind = 'warmup' | 'work' | 'recovery' | 'steady' | 'cooldown'

export interface Step {
  type: 'step'
  kind: StepKind
  durationS: number
  /** Target as a fraction of FTP at the start of the step. */
  power: number
  /** Set for ramps: the target at the end of the step. */
  powerEnd?: number
  label?: string
  /** Suggested cadence in rpm, shown only. */
  cadence?: number
}

export interface Repeat {
  type: 'repeat'
  count: number
  blocks: Block[]
}

export type Block = Step | Repeat

export interface Workout {
  id: string
  name: string
  description: string
  blocks: Block[]
  source: 'builtin' | 'prompt'
  prompt?: string
  createdAt: string
}

/** One step of the expanded workout, with its place on the timeline. */
export interface Segment {
  index: number
  startS: number
  endS: number
  durationS: number
  power: number
  powerEnd: number
  kind: StepKind
  label: string
  /** Position inside repeats, outermost first, e.g. "2/3 · 4/10". Empty outside repeats. */
  rep: string
  cadence?: number
}

const KIND_LABEL: Record<StepKind, string> = {
  warmup: 'Warm-up',
  work: 'Work',
  recovery: 'Recovery',
  steady: 'Steady',
  cooldown: 'Cool-down',
}

/** Expands repeats into the flat list of segments the player runs through. */
export function flatten(blocks: Block[]): Segment[] {
  const out: Segment[] = []
  let t = 0
  const walk = (list: Block[], reps: string[]) => {
    for (const block of list) {
      if (block.type === 'repeat') {
        for (let i = 1; i <= block.count; i++) walk(block.blocks, [...reps, `${i}/${block.count}`])
        continue
      }
      const durationS = Math.round(block.durationS)
      if (durationS <= 0) continue
      out.push({
        index: out.length,
        startS: t,
        endS: t + durationS,
        durationS,
        power: block.power,
        powerEnd: block.powerEnd ?? block.power,
        kind: block.kind,
        label: block.label?.trim() || KIND_LABEL[block.kind],
        rep: reps.join(' · '),
        cadence: block.cadence,
      })
      t += durationS
    }
  }
  walk(blocks, [])
  return out
}

export const totalDuration = (segments: Segment[]): number =>
  segments.length ? segments[segments.length - 1].endS : 0

/** The segment covering workout position `t` seconds; null once the workout is over. */
export function segmentAt(segments: Segment[], t: number): Segment | null {
  if (t < 0) return segments[0] ?? null
  let lo = 0
  let hi = segments.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segments[mid]
    if (t < s.startS) hi = mid - 1
    else if (t >= s.endS) lo = mid + 1
    else return s
  }
  return null
}

/** Target as a fraction of FTP at workout position `t` inside `segment` (ramps interpolate). */
export function powerAt(segment: Segment, t: number): number {
  if (segment.powerEnd === segment.power) return segment.power
  const f = Math.min(1, Math.max(0, (t - segment.startS) / segment.durationS))
  return segment.power + (segment.powerEnd - segment.power) * f
}

export interface WorkoutStats {
  durationS: number
  /** Planned intensity factor: normalized power as a fraction of FTP. */
  intensityFactor: number
  /** Planned training stress score. */
  tss: number
  avgPower: number
  /** Planned work in kJ per watt of FTP: multiply by FTP. */
  workPerFtpKJ: number
}

/** What the workout adds up to if ridden exactly as planned. */
export function workoutStats(segments: Segment[]): WorkoutStats {
  const durationS = totalDuration(segments)
  if (durationS === 0) return { durationS: 0, intensityFactor: 0, tss: 0, avgPower: 0, workPerFtpKJ: 0 }
  const perSecond: number[] = []
  for (const s of segments) {
    for (let t = s.startS; t < s.endS; t++) perSecond.push(powerAt(s, t + 0.5))
  }
  const sum = perSecond.reduce((a, b) => a + b, 0)
  const intensityFactor = normalized(perSecond)
  return {
    durationS,
    intensityFactor,
    tss: (durationS / 3600) * intensityFactor * intensityFactor * 100,
    avgPower: sum / durationS,
    workPerFtpKJ: sum / 1000,
  }
}

/** Normalized power: 30 s rolling mean, raised to the 4th, averaged, 4th root. */
export function normalized(perSecond: number[]): number {
  const n = perSecond.length
  if (n === 0) return 0
  if (n < 30) return perSecond.reduce((a, b) => a + b, 0) / n
  let window = 0
  let acc = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    window += perSecond[i]
    if (i >= 30) window -= perSecond[i - 30]
    if (i >= 29) {
      acc += (window / 30) ** 4
      count++
    }
  }
  return (acc / count) ** 0.25
}

const MAX_DURATION_S = 6 * 3600
const MAX_SEGMENTS = 400

/** Problems that make a workout unsafe or pointless to ride. Empty when it is fine. */
export function validateWorkout(blocks: Block[]): string[] {
  const errors: string[] = []
  const check = (list: Block[], depth: number) => {
    for (const b of list) {
      if (b.type === 'repeat') {
        if (depth >= 3) errors.push('Repeats are nested too deeply.')
        if (!Number.isInteger(b.count) || b.count < 1 || b.count > 60) errors.push(`Repeat count ${b.count} is out of range.`)
        if (b.blocks.length === 0) errors.push('A repeat has no steps.')
        else check(b.blocks, depth + 1)
        continue
      }
      if (!(b.durationS >= 5)) errors.push(`A step lasts ${b.durationS} s; the minimum is 5 s.`)
      for (const p of [b.power, b.powerEnd ?? b.power]) {
        if (!(p >= 0.3 && p <= 2.5)) errors.push(`A target of ${Math.round(p * 100)} % of FTP is out of range (30-250 %).`)
      }
    }
  }
  check(blocks, 0)
  if (errors.length) return [...new Set(errors)]
  const segments = flatten(blocks)
  if (segments.length === 0) errors.push('The workout has no steps.')
  if (segments.length > MAX_SEGMENTS) errors.push(`The workout has ${segments.length} steps; the maximum is ${MAX_SEGMENTS}.`)
  if (totalDuration(segments) > MAX_DURATION_S) errors.push('The workout is longer than 6 hours.')
  return errors
}

export function formatDuration(totalS: number): string {
  const s = Math.max(0, Math.round(totalS))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}
