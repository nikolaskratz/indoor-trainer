// Power zones after Coggan (fractions of FTP) and heart rate zones after Friel
// (fractions of threshold heart rate).

export interface Zone {
  zone: number
  name: string
  /** Fill colour that reads on light and dark backgrounds. */
  color: string
}

const POWER_ZONES: (Zone & { upTo: number })[] = [
  { zone: 1, name: 'Recovery', color: '#9ca3af', upTo: 0.55 },
  { zone: 2, name: 'Endurance', color: '#3b82f6', upTo: 0.75 },
  { zone: 3, name: 'Tempo', color: '#22c55e', upTo: 0.9 },
  { zone: 4, name: 'Threshold', color: '#eab308', upTo: 1.05 },
  { zone: 5, name: 'VO2 max', color: '#f97316', upTo: 1.2 },
  { zone: 6, name: 'Anaerobic', color: '#ef4444', upTo: 1.5 },
  { zone: 7, name: 'Sprint', color: '#a855f7', upTo: Infinity },
]

/** Zone for a power given as a fraction of FTP. */
export function powerZone(fraction: number): Zone {
  return POWER_ZONES.find((z) => fraction <= z.upTo) ?? POWER_ZONES[POWER_ZONES.length - 1]
}

/** Watt ranges of all power zones for an FTP, for the profile page. */
export function powerZoneTable(ftp: number): { zone: Zone; fromW: number; toW: number | null }[] {
  let from = 0
  return POWER_ZONES.map((z) => {
    const row = {
      zone: z as Zone,
      fromW: from,
      toW: Number.isFinite(z.upTo) ? Math.round(ftp * z.upTo) : null,
    }
    from = row.toW === null ? from : row.toW + 1
    return row
  })
}

const HR_ZONES: (Zone & { upTo: number })[] = [
  { zone: 1, name: 'Recovery', color: '#9ca3af', upTo: 0.81 },
  { zone: 2, name: 'Aerobic', color: '#3b82f6', upTo: 0.89 },
  { zone: 3, name: 'Tempo', color: '#22c55e', upTo: 0.93 },
  { zone: 4, name: 'Sub-threshold', color: '#eab308', upTo: 0.99 },
  { zone: 5, name: 'Above threshold', color: '#ef4444', upTo: Infinity },
]

/**
 * Heart rate zone from threshold heart rate. Without one, threshold is
 * estimated as 90 % of maximum heart rate. Null when neither is known.
 */
export function hrZone(bpm: number, thresholdHr: number | null, maxHr: number | null): Zone | null {
  const threshold = thresholdHr ?? (maxHr ? maxHr * 0.9 : null)
  if (!threshold) return null
  const f = bpm / threshold
  return HR_ZONES.find((z) => f <= z.upTo) ?? HR_ZONES[HR_ZONES.length - 1]
}
