export interface ChartPoint {
  t: number
  powerW: number
  targetW: number | null
}

const WINDOW_MS = 90_000
const W = 600
const H = 140

/** Last 90 seconds of measured power against the target, to see ERG mode respond. */
export function PowerChart({ points, now }: { points: ChartPoint[]; now: number }) {
  const visible = points.filter((p) => p.t >= now - WINDOW_MS)
  const peak = Math.max(200, ...visible.map((p) => Math.max(p.powerW, p.targetW ?? 0)))
  const top = Math.ceil((peak * 1.15) / 50) * 50
  const x = (t: number) => W - ((now - t) / WINDOW_MS) * W
  const y = (w: number) => H - (Math.max(0, w) / top) * H
  const line = (value: (p: ChartPoint) => number | null) => {
    let d = ''
    let pen = false
    for (const p of visible) {
      const v = value(p)
      if (v === null) {
        pen = false
        continue
      }
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`
      pen = true
    }
    return d
  }
  const grid = [0.25, 0.5, 0.75].map((f) => Math.round(top * f))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Power over the last 90 seconds">
      {grid.map((w) => (
        <g key={w}>
          <line x1="0" x2={W} y1={y(w)} y2={y(w)} className="stroke-stone-200 dark:stroke-stone-800" />
          <text x="4" y={y(w) - 3} className="fill-stone-400 text-[10px]">
            {w} W
          </text>
        </g>
      ))}
      <path d={line((p) => p.targetW)} fill="none" strokeWidth="2" strokeDasharray="5 4" className="stroke-amber-500" />
      <path d={line((p) => p.powerW)} fill="none" strokeWidth="2" className="stroke-teal-600 dark:stroke-teal-400" />
    </svg>
  )
}
