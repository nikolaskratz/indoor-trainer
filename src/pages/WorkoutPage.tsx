import { connection } from '../ble/devices.ts'
import { ChangeCard } from '../components/ChangeCard.tsx'
import { DevicesPanel } from '../components/DevicesPanel.tsx'
import { Button, Card } from '../components/ui.tsx'
import { WorkoutGraph } from '../components/WorkoutGraph.tsx'
import { BUILTIN_WORKOUTS } from '../domain/builtin.ts'
import { RAMP_TYPICAL_MINUTES } from '../domain/ftpTest.ts'
import { flatten, formatDuration, workoutStats, type Block, type Workout } from '../domain/workout.ts'
import { powerZone } from '../domain/zones.ts'
import { activeRide, prepareRide } from '../lib/activeRide.ts'
import { href, navigate } from '../lib/router.ts'
import { profileStore, removeWorkout, riderProfile, workoutStore } from '../lib/storage.ts'
import { useStore } from '../lib/store.ts'

export function findWorkout(id: string, saved: Workout[]): Workout | undefined {
  return saved.find((w) => w.id === id) ?? BUILTIN_WORKOUTS.find((w) => w.id === id)
}

const pct = (f: number) => `${Math.round(f * 100)} %`

function Steps({ blocks, ftp, depth = 0 }: { blocks: Block[]; ftp: number | null; depth?: number }) {
  const watts = (f: number) => (ftp ? ` · ${Math.round(f * ftp)} W` : '')
  return (
    <ul className={depth ? 'ml-4 border-l border-stone-200 pl-3 dark:border-stone-700' : ''}>
      {blocks.map((b, i) =>
        b.type === 'repeat' ? (
          <li key={i} className="py-1">
            <span className="text-sm font-medium">{b.count} ×</span>
            <Steps blocks={b.blocks} ftp={ftp} depth={depth + 1} />
          </li>
        ) : (
          <li key={i} className="flex items-baseline gap-2 py-0.5 text-sm">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: powerZone((b.power + (b.powerEnd ?? b.power)) / 2).color }}
            />
            <span className="w-14 shrink-0 tabular-nums text-stone-500">{formatDuration(b.durationS)}</span>
            <span>
              {b.label ?? b.kind}
              <span className="text-stone-500">
                {' '}
                {b.powerEnd !== undefined && b.powerEnd !== b.power
                  ? `${pct(b.power)} to ${pct(b.powerEnd)}${ftp ? ` · ${Math.round(b.power * ftp)} to ${Math.round(b.powerEnd * ftp)} W` : ''}`
                  : `${pct(b.power)}${watts(b.power)}`}
                {b.cadence ? ` · ${b.cadence} rpm` : ''}
              </span>
            </span>
          </li>
        ),
      )}
    </ul>
  )
}

export function WorkoutPage({ id }: { id: string }) {
  const saved = useStore(workoutStore)
  const profileForm = useStore(profileStore)
  const { trainer } = useStore(connection)
  const ride = useStore(activeRide)
  const workout = findWorkout(id, saved)
  if (!workout) {
    return (
      <Card title="Workout not found">
        <a href={href('')} className="text-sm text-teal-700 underline dark:text-teal-400">
          Back to the workouts
        </a>
      </Card>
    )
  }
  const profile = riderProfile(profileForm)
  const segments = flatten(workout.blocks)
  const stats = workoutStats(segments)
  const ftp = profile?.ftp ?? null

  const start = () => {
    if (!profile) return
    prepareRide(workout, profile)
    navigate('ride')
  }

  return (
    <div className="space-y-5">
      <div>
        <a href={href('')} className="text-sm text-teal-700 underline dark:text-teal-400">
          ← Workouts
        </a>
        <h1 className="mt-2 text-2xl font-semibold">{workout.name}</h1>
        <p className="mt-1 max-w-3xl text-sm text-stone-600 dark:text-stone-400">{workout.description}</p>
        {workout.prompt && (
          <p className="mt-1 max-w-3xl text-xs text-stone-500">Created from: "{workout.prompt}"</p>
        )}
        {workout.basedOn && <p className="mt-1 max-w-3xl text-xs text-stone-500">Based on: {workout.basedOn}</p>}
        {workout.changes && workout.changes.length > 0 && (
          <p className="mt-1 max-w-3xl text-xs text-stone-500" data-testid="workout-changes">
            Changed: {workout.changes.map((c) => `"${c}"`).join(', then ')}
          </p>
        )}
      </div>

      {workout.test === 'ramp' ? (
        <Card>
          <WorkoutGraph segments={segments} />
          <ul className="mt-4 max-w-3xl list-disc space-y-1 pl-5 text-sm text-stone-700 dark:text-stone-300">
            <li>
              The plan runs far past what anyone can ride. You stop when you cannot hold the target any more, press
              "Done: cool down", and spin easy for a few minutes. Most riders need {RAMP_TYPICAL_MINUTES} minutes in all.
            </li>
            <li>
              Targets are scaled to the FTP in your profile{ftp ? ` (${ftp} W)` : ''}: it starts at{' '}
              {ftp ? `${Math.round(0.46 * ftp)} W` : '46 %'} and rises by {ftp ? `${Math.round(0.06 * ftp)} W` : '6 %'} every minute. A
              rough FTP is enough to start.
            </li>
            <li>Stay seated and keep a steady cadence. Ride it fresh: no hard session the day before.</li>
            <li>Afterwards the ride summary shows your estimated FTP (75 % of your best minute) and lets you take it over.</li>
          </ul>
        </Card>
      ) : (
        <Card>
          <WorkoutGraph segments={segments} />
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            {[
              ['Duration', formatDuration(stats.durationS)],
              ['Intensity (IF)', stats.intensityFactor.toFixed(2)],
              ['Training stress (TSS)', String(Math.round(stats.tss))],
              ['Average target', ftp ? `${Math.round(stats.avgPower * ftp)} W` : pct(stats.avgPower)],
              ['Work', ftp ? `${Math.round(stats.workPerFtpKJ * ftp)} kJ` : 'needs FTP'],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-stone-500">{label}</dt>
                <dd className="text-lg font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      <DevicesPanel />

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={start} size="lg" disabled={!profile || ride !== null}>
          Start this workout
        </Button>
        {!profile && (
          <span className="text-sm text-amber-700 dark:text-amber-400">
            Enter your FTP and weight in the{' '}
            <a href={href('profile')} className="underline">
              profile
            </a>{' '}
            first.
          </span>
        )}
        {profile && ride !== null && (
          <span className="text-sm text-amber-700 dark:text-amber-400">
            Another ride is open.{' '}
            <a href={href('ride')} className="underline">
              Go to it
            </a>
          </span>
        )}
        {profile && ride === null && trainer.status !== 'connected' && (
          <span className="text-sm text-stone-600 dark:text-stone-400">
            No trainer connected: you can still start, but targets are only shown and no power is recorded.
          </span>
        )}
      </div>

      {!workout.test && <ChangeCard key={workout.id} workout={workout} />}

      {!workout.test && (
        <Card title="Steps">
          <Steps blocks={workout.blocks} ftp={ftp} />
        </Card>
      )}

      {workout.source === 'prompt' && (
        <div>
          <Button
            kind="quiet"
            onClick={() => {
              removeWorkout(workout.id)
              navigate('')
            }}
          >
            Delete this workout
          </Button>
        </div>
      )}
    </div>
  )
}
