import { useState } from 'react'
import { DevicesPanel } from '../components/DevicesPanel.tsx'
import { PromptCard } from '../components/PromptCard.tsx'
import { Button } from '../components/ui.tsx'
import { WorkoutGraph } from '../components/WorkoutGraph.tsx'
import { BUILTIN_WORKOUTS } from '../domain/builtin.ts'
import { flatten, formatDuration, workoutStats, type Workout } from '../domain/workout.ts'
import { activeRide, discardRide, resumeRide, saveSnapshotAsRide } from '../lib/activeRide.ts'
import { href, navigate } from '../lib/router.ts'
import { loadActiveRide, profileStore, riderProfile, workoutStore } from '../lib/storage.ts'
import { useStore } from '../lib/store.ts'

function WorkoutCard({ workout }: { workout: Workout }) {
  const segments = flatten(workout.blocks)
  const stats = workoutStats(segments)
  return (
    <a
      href={href(`workout/${workout.id}`)}
      className="block rounded-xl border border-stone-200 bg-white p-4 shadow-sm transition-colors hover:border-teal-600 dark:border-stone-800 dark:bg-stone-900"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold">{workout.name}</h3>
        <span className="shrink-0 text-xs tabular-nums text-stone-500">
          {formatDuration(stats.durationS)} · IF {stats.intensityFactor.toFixed(2)} · TSS {Math.round(stats.tss)}
        </span>
      </div>
      <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">{workout.description}</p>
      <WorkoutGraph segments={segments} compact className="mt-3" />
    </a>
  )
}

export function Home() {
  const profile = useStore(profileStore)
  const saved = useStore(workoutStore)
  const ride = useStore(activeRide)
  const [interrupted, setInterrupted] = useState(() => (activeRide.get() ? null : loadActiveRide()))
  const ready = riderProfile(profile) !== null

  return (
    <div className="space-y-5">
      {ride && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-teal-600 bg-teal-50 p-4 text-sm dark:bg-teal-950">
          <span className="font-medium">A ride is open: {ride.workout.name}</span>
          <Button onClick={() => navigate('ride')}>Back to the ride</Button>
        </div>
      )}
      {!ride && interrupted && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
          <span>
            <span className="font-medium">Unfinished ride:</span> {interrupted.workout.name},{' '}
            {formatDuration(interrupted.activeS)} recorded on{' '}
            {new Date(interrupted.startTs).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.
          </span>
          <span className="ml-auto flex gap-2">
            <Button
              onClick={() => {
                resumeRide(interrupted)
                navigate('ride')
              }}
            >
              Resume
            </Button>
            <Button
              kind="quiet"
              onClick={() => {
                void saveSnapshotAsRide(interrupted).then((id) => {
                  setInterrupted(null)
                  if (id) navigate(`summary/${id}`)
                })
              }}
            >
              Save as it is
            </Button>
            <Button
              kind="quiet"
              onClick={() => {
                discardRide()
                setInterrupted(null)
              }}
            >
              Discard
            </Button>
          </span>
        </div>
      )}
      {!ready && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
          <span>Enter your FTP and weight first: every workout target is calculated from your FTP.</span>
          <Button onClick={() => navigate('profile')}>Open profile</Button>
        </div>
      )}

      <DevicesPanel />

      <PromptCard />

      <section>
        <h2 className="mb-3 text-base font-semibold">Workouts</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {[...saved, ...BUILTIN_WORKOUTS].map((w) => (
            <WorkoutCard key={w.id} workout={w} />
          ))}
        </div>
      </section>

    </div>
  )
}
