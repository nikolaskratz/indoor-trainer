// Judges whether the trainer held a target power during one step of the ERG test.

export interface PowerPoint {
  /** Milliseconds, same clock as the step boundaries. */
  t: number
  powerW: number
}

export interface ErgStepResult {
  targetW: number
  /** Mean power over the final part of the step; null when no readings arrived. */
  meanW: number | null
  /** Seconds from the step start until power first stayed within tolerance; null if never. */
  settleS: number | null
  toleranceW: number
  pass: boolean
  /** Why the step failed, in plain words. */
  reason?: string
}

/** Allowed deviation: 10 W or 8 % of the target, whichever is larger. */
export const toleranceFor = (targetW: number): number => Math.max(10, Math.round(targetW * 0.08))

export function evaluateErgStep(
  samples: PowerPoint[],
  targetW: number,
  startMs: number,
  endMs: number,
): ErgStepResult {
  const toleranceW = toleranceFor(targetW)
  const inStep = samples.filter((s) => s.t >= startMs && s.t <= endMs)
  if (inStep.length === 0) {
    return { targetW, meanW: null, settleS: null, toleranceW, pass: false, reason: 'no power readings' }
  }
  // Judge the second half of the step (at most the last 8 s), after the trainer had time to adjust.
  const windowMs = Math.min(8000, (endMs - startMs) / 2)
  const tail = inStep.filter((s) => s.t >= endMs - windowMs)
  const judged = tail.length > 0 ? tail : inStep
  const meanW = judged.reduce((sum, s) => sum + s.powerW, 0) / judged.length

  // Settle time: first reading from which a 3 s moving average stays within tolerance.
  let settleS: number | null = null
  for (let i = 0; i < inStep.length; i++) {
    const from = inStep[i].t
    const win = inStep.filter((s) => s.t >= from && s.t < from + 3000)
    const span = win[win.length - 1].t - from
    if (span < 2000) break
    const avg = win.reduce((sum, s) => sum + s.powerW, 0) / win.length
    if (Math.abs(avg - targetW) <= toleranceW) {
      settleS = Math.round(((from - startMs) / 1000) * 10) / 10
      break
    }
  }

  const rounded = Math.round(meanW)
  if (meanW < 5) {
    return { targetW, meanW: rounded, settleS, toleranceW, pass: false, reason: 'no power: were you pedalling?' }
  }
  const pass = Math.abs(meanW - targetW) <= toleranceW
  return {
    targetW,
    meanW: rounded,
    settleS,
    toleranceW,
    pass,
    reason: pass ? undefined : `held ${rounded} W instead of ${targetW} W`,
  }
}
