// Virtual speed on a flat road from power. A trainer's own speed depends on the
// gear in ERG mode, so distance comes from this model instead.

export interface BikeModel {
  /** Rider plus bike, kg. */
  massKg: number
  /** Rolling resistance coefficient. */
  crr: number
  /** Drag area in m², hands on the hoods. */
  cda: number
  /** Air density, kg/m³. */
  rho: number
  /** Share of pedal power that reaches the wheel. */
  drivetrain: number
}

export const DEFAULT_BIKE_KG = 9

export const bikeModel = (riderKg: number, bikeKg = DEFAULT_BIKE_KG): BikeModel => ({
  massKg: riderKg + bikeKg,
  crr: 0.004,
  cda: 0.32,
  rho: 1.225,
  drivetrain: 0.975,
})

const G = 9.8067

/** Force holding the bike back at speed v (m/s) on the flat. */
const resistance = (m: BikeModel, v: number): number => m.crr * m.massKg * G + 0.5 * m.rho * m.cda * v * v

/**
 * Speed (m/s) after `dt` seconds of riding at `powerW`, starting from `v`.
 * Includes inertia, so speed builds and coasts down like on the road.
 */
export function stepSpeed(m: BikeModel, v: number, powerW: number, dt: number): number {
  // Integrate in small steps: the drive force P/v is steep near standstill.
  const steps = Math.max(1, Math.ceil(dt / 0.1))
  const h = dt / steps
  let speed = Math.max(0, v)
  for (let i = 0; i < steps; i++) {
    const drive = (Math.max(0, powerW) * m.drivetrain) / Math.max(speed, 1)
    const a = (drive - resistance(m, speed)) / m.massKg
    speed = Math.max(0, speed + a * h)
  }
  return speed
}

/** Speed (m/s) the model settles at for a constant power. */
export function steadySpeed(m: BikeModel, powerW: number): number {
  if (powerW <= 0) return 0
  let lo = 0
  let hi = 40
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (resistance(m, mid) * mid < powerW * m.drivetrain) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
