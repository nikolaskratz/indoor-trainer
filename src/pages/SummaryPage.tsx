import { useEffect, useState } from 'react'
import { Button, Card } from '../components/ui.tsx'
import { WorkoutGraph } from '../components/WorkoutGraph.tsx'
import { buildTcx, rideFileName } from '../domain/tcx.ts'
import { flatten, formatDuration } from '../domain/workout.ts'
import { href, navigate } from '../lib/router.ts'
import { deleteRide, loadRide, type SavedRide } from '../lib/storage.ts'

export function downloadTcx(ride: SavedRide): void {
  const tcx = buildTcx({
    name: ride.workout.name,
    notes: `${ride.workout.name}. ${ride.workout.description}`,
    startTs: ride.startTs,
    samples: ride.samples,
    segments: flatten(ride.workout.blocks),
  })
  const url = URL.createObjectURL(new Blob([tcx], { type: 'application/vnd.garmin.tcx+xml' }))
  const a = document.createElement('a')
  a.href = url
  a.download = rideFileName(ride.workout.name, ride.startTs)
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

const dash = (v: number | null, unit: string) => (v === null ? '–' : `${v} ${unit}`)

export function SummaryPage({ id }: { id: string }) {
  const [ride, setRide] = useState<SavedRide | null | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadRide(id)
      .then((r) => !cancelled && setRide(r ?? null))
      .catch(() => !cancelled && setRide(null))
    return () => {
      cancelled = true
    }
  }, [id])

  if (ride === undefined) return <p className="text-sm text-stone-500">Loading…</p>
  if (ride === null) {
    return (
      <Card title="Ride not found">
        <a href={href('history')} className="text-sm text-teal-700 underline dark:text-teal-400">
          All rides
        </a>
      </Card>
    )
  }
  const s = ride.summary
  const stats: [string, string][] = [
    ['Riding time', formatDuration(s.durationS)],
    ['Distance', `${(s.distanceM / 1000).toFixed(2)} km`],
    ['Elevation', `${s.elevationM} m`],
    ['Average power', dash(s.avgPowerW, 'W')],
    ['Normalized power', dash(s.normalizedPowerW, 'W')],
    ['Max power', dash(s.maxPowerW, 'W')],
    ['Intensity (IF)', s.intensityFactor === null ? '–' : s.intensityFactor.toFixed(2)],
    ['Training stress (TSS)', s.tss === null ? '–' : String(s.tss)],
    ['Work', `${s.workKJ} kJ`],
    ['Average heart rate', dash(s.avgHrBpm, 'bpm')],
    ['Max heart rate', dash(s.maxHrBpm, 'bpm')],
    ['Average cadence', dash(s.avgCadenceRpm, 'rpm')],
    ['Average speed', `${s.avgSpeedKph.toFixed(1)} km/h`],
    ['FTP used', `${ride.profile.ftp} W`],
    ['Intensity setting', `${Math.round(ride.intensity * 100)} %`],
  ]
  return (
    <div className="space-y-5">
      <div>
        <a href={href('history')} className="text-sm text-teal-700 underline dark:text-teal-400">
          ← All rides
        </a>
        <h1 className="mt-2 text-2xl font-semibold" data-testid="summary-title">
          {ride.workout.name}
        </h1>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          {new Date(ride.startTs).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}
        </p>
      </div>
      <Card>
        <WorkoutGraph
          segments={flatten(ride.workout.blocks)}
          samples={ride.samples}
          ftp={ride.profile.ftp}
          maxHr={ride.profile.maxHr}
        />
        <p className="mt-1 text-xs text-stone-500">
          Blocks: planned power by zone. Dark line: your power. Red line: heart rate.
        </p>
      </Card>
      <Card>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 md:grid-cols-5" data-testid="summary-stats">
          {stats.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-stone-500">{label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => downloadTcx(ride)}>Download ride file (TCX)</Button>
        <span className="text-sm text-stone-600 dark:text-stone-400">
          Upload to Strava from the app is not built yet; the file can be uploaded on strava.com by hand.
        </span>
        <span className="ml-auto flex gap-2">
          {confirmDelete ? (
            <>
              <Button
                kind="danger"
                onClick={() => {
                  void deleteRide(ride.id).then(() => navigate('history'))
                }}
              >
                Delete for good
              </Button>
              <Button kind="quiet" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button kind="quiet" onClick={() => setConfirmDelete(true)}>
              Delete ride
            </Button>
          )}
        </span>
      </div>
    </div>
  )
}
