import type { RideSample } from '../domain/ride.ts'
import { formatDuration, totalDuration, type Segment } from '../domain/workout.ts'
import { powerZone } from '../domain/zones.ts'

const W = 1000
const H = 200

interface Props {
  segments: Segment[]
  /** Recorded samples to draw over the plan. */
  samples?: RideSample[]
  ftp?: number
  /** Workout position in seconds: draws the progress cursor. */
  positionS?: number
  /** Rider's maximum heart rate, for scaling the heart rate line. */
  maxHr?: number | null
  className?: string
  /** Hide the time axis on small previews. */
  compact?: boolean
}

/** Keeps at most `max` points, evenly spread, so long rides draw quickly. */
function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const step = items.length / max
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)])
}

/** The workout as blocks coloured by power zone, with the ride drawn on top. */
export function WorkoutGraph({ segments, samples, ftp, positionS, maxHr, className, compact }: Props) {
  const total = totalDuration(segments) || 1
  const peakPlan = Math.max(...segments.map((s) => Math.max(s.power, s.powerEnd)), 1)
  const peakRide = samples && ftp ? Math.max(0, ...samples.map((s) => (s.powerW ?? 0) / ftp)) : 0
  const top = Math.max(1.3, Math.min(3, Math.max(peakPlan, peakRide) * 1.12))
  const x = (t: number) => (t / total) * W
  const y = (fraction: number) => H - (Math.min(fraction, top) / top) * H

  const drawn = samples ? thin(samples, 800) : []
  const powerPath =
    ftp && drawn.length
      ? drawn
          .filter((s) => s.powerW !== null)
          .map((s, i) => `${i ? 'L' : 'M'}${x(s.pos).toFixed(1)},${y((s.powerW ?? 0) / ftp).toFixed(1)}`)
          .join('')
      : ''
  const hrTop = maxHr ?? 200
  const hrBottom = 60
  const hrPath = drawn
    .filter((s) => s.hrBpm !== null)
    .map((s, i) => {
      const f = Math.min(1, Math.max(0, ((s.hrBpm ?? 0) - hrBottom) / (hrTop - hrBottom)))
      return `${i ? 'L' : 'M'}${x(s.pos).toFixed(1)},${(H - f * H).toFixed(1)}`
    })
    .join('')

  const tickEvery = total > 5400 ? 1800 : total > 2400 ? 600 : total > 900 ? 300 : 120
  const ticks: number[] = []
  for (let t = tickEvery; t < total; t += tickEvery) ticks.push(t)

  return (
    <div className={className}>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className={`block w-full ${compact ? 'h-14' : 'h-40 md:h-52'}`}
          role="img"
          aria-label="Workout profile"
        >
          {segments.map((s) => (
            <polygon
              key={s.index}
              points={`${x(s.startS)},${H} ${x(s.startS)},${y(s.power)} ${x(s.endS)},${y(s.powerEnd)} ${x(s.endS)},${H}`}
              fill={powerZone((s.power + s.powerEnd) / 2).color}
              opacity={positionS !== undefined && s.endS <= positionS ? 0.35 : 0.8}
              stroke="rgba(0,0,0,0.25)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1="0"
            x2={W}
            y1={y(1)}
            y2={y(1)}
            className="stroke-stone-500"
            strokeDasharray="6 5"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          {hrPath && (
            <path d={hrPath} fill="none" stroke="#dc2626" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          )}
          {powerPath && (
            <path
              d={powerPath}
              fill="none"
              className="stroke-stone-900 dark:stroke-white"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {positionS !== undefined && (
            <line
              x1={x(positionS)}
              x2={x(positionS)}
              y1="0"
              y2={H}
              className="stroke-stone-900 dark:stroke-white"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {!compact && (
          <span
            className="pointer-events-none absolute right-1 text-[10px] text-stone-500"
            style={{ top: `calc(${(y(1) / H) * 100}% - 14px)` }}
          >
            FTP
          </span>
        )}
      </div>
      {!compact && (
        <div className="relative mt-1 h-4 text-[10px] text-stone-500">
          {ticks.map((t) => (
            <span key={t} className="absolute -translate-x-1/2" style={{ left: `${(t / total) * 100}%` }}>
              {formatDuration(t)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
