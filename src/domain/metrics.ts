import type { RideSample } from './ride.ts'
import { normalized } from './workout.ts'

export interface RideSummary {
  /** Riding time in seconds, pauses excluded. */
  durationS: number
  distanceM: number
  /** Always 0 for now: rides are on a virtual flat road. */
  elevationM: number
  avgPowerW: number | null
  maxPowerW: number | null
  normalizedPowerW: number | null
  intensityFactor: number | null
  tss: number | null
  workKJ: number
  avgHrBpm: number | null
  maxHrBpm: number | null
  avgCadenceRpm: number | null
  avgSpeedKph: number
}

const mean = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null

export function summarize(samples: RideSample[], ftp: number): RideSummary {
  const durationS = samples.length
  const power = samples.map((s) => s.powerW).filter((p): p is number => p !== null)
  const hr = samples.map((s) => s.hrBpm).filter((h): h is number => h !== null)
  // Average cadence counts only seconds spent pedalling, as bike computers do.
  const cadence = samples.map((s) => s.cadenceRpm).filter((c): c is number => c !== null && c > 0)
  const distanceM = samples.length ? samples[samples.length - 1].distanceM : 0
  const avgPower = mean(power)
  const np = power.length ? normalized(samples.map((s) => s.powerW ?? 0)) : null
  const intensityFactor = np !== null && ftp > 0 ? np / ftp : null
  const round = (v: number | null) => (v === null ? null : Math.round(v))
  return {
    durationS,
    distanceM,
    elevationM: 0,
    avgPowerW: round(avgPower),
    maxPowerW: power.length ? Math.max(...power) : null,
    normalizedPowerW: round(np),
    intensityFactor: intensityFactor === null ? null : Math.round(intensityFactor * 100) / 100,
    tss: intensityFactor === null ? null : Math.round((durationS / 3600) * intensityFactor ** 2 * 100),
    workKJ: Math.round(power.reduce((a, b) => a + b, 0) / 1000),
    avgHrBpm: round(mean(hr)),
    maxHrBpm: hr.length ? Math.max(...hr) : null,
    avgCadenceRpm: round(mean(cadence)),
    avgSpeedKph: durationS ? Math.round((distanceM / durationS) * 36) / 10 : 0,
  }
}
