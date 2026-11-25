import { useEffect, useState } from 'react'
import { Card } from '../components/ui.tsx'
import { formatDuration } from '../domain/workout.ts'
import { href } from '../lib/router.ts'
import { listRides, ridesVersion, type SavedRide } from '../lib/storage.ts'
import { useStore } from '../lib/store.ts'

export function HistoryPage() {
  const [rides, setRides] = useState<SavedRide[] | null>(null)
  const [failed, setFailed] = useState(false)
  // Reload when rides arrive from the account or are deleted.
  const version = useStore(ridesVersion)

  useEffect(() => {
    let cancelled = false
    listRides()
      .then((r) => !cancelled && setRides(r))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [version])

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Rides</h1>
      {failed && <p className="text-sm text-red-700 dark:text-red-400">The rides stored in this browser could not be read.</p>}
      {rides === null && !failed && <p className="text-sm text-stone-500">Loading…</p>}
      {rides?.length === 0 && (
        <Card>
          <p className="text-sm text-stone-600 dark:text-stone-400">
            No rides yet. Finished rides are listed here.
          </p>
        </Card>
      )}
      {rides && rides.length > 0 && (
        <Card>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-stone-500">
              <tr>
                <th className="py-1 font-normal">Date</th>
                <th className="font-normal">Workout</th>
                <th className="text-right font-normal">Time</th>
                <th className="text-right font-normal">Distance</th>
                <th className="text-right font-normal">Avg power</th>
                <th className="text-right font-normal">TSS</th>
              </tr>
            </thead>
            <tbody>
              {rides.map((r) => (
                <tr key={r.id} className="border-t border-stone-200 dark:border-stone-800">
                  <td className="py-2">
                    {new Date(r.startTs).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                  </td>
                  <td>
                    <a href={href(`summary/${r.id}`)} className="text-teal-700 underline dark:text-teal-400">
                      {r.workout.name}
                    </a>
                  </td>
                  <td className="text-right tabular-nums">{formatDuration(r.summary.durationS)}</td>
                  <td className="text-right tabular-nums">{(r.summary.distanceM / 1000).toFixed(1)} km</td>
                  <td className="text-right tabular-nums">
                    {r.summary.avgPowerW === null ? '–' : `${r.summary.avgPowerW} W`}
                  </td>
                  <td className="text-right tabular-nums">{r.summary.tss ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
