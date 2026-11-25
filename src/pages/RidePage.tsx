import { useEffect, useState, useSyncExternalStore } from 'react'
import { connection } from '../ble/devices.ts'
import { FloatingRide, useFloatingWindow } from '../components/FloatingWindow.tsx'
import { Button, Card, StatusDot } from '../components/ui.tsx'
import { WorkoutGraph } from '../components/WorkoutGraph.tsx'
import { rampCooldownIndex } from '../domain/ftpTest.ts'
import type { RideSession, RideView } from '../domain/ride.ts'
import { formatDuration, powerAt, type Segment } from '../domain/workout.ts'
import { hrZone, powerZone } from '../domain/zones.ts'
import { activeRide, beginRide, completeRide, discardRide, enableCues, finishedRideId } from '../lib/activeRide.ts'
import { href, navigate } from '../lib/router.ts'
import { useStore } from '../lib/store.ts'

const STATUS_TEXT: Record<RideView['status'], string> = {
  ready: 'Ready',
  running: 'Riding',
  paused: 'Paused',
  autopaused: 'Paused: start pedalling',
  finished: 'Finished',
}

function describe(segment: Segment, ftp: number, intensity: number): string {
  const w = (f: number) => Math.round(f * ftp * intensity)
  const target =
    segment.powerEnd !== segment.power ? `${w(segment.power)} to ${w(segment.powerEnd)} W` : `${w(segment.power)} W`
  return `${segment.label}${segment.rep ? ` ${segment.rep}` : ''} · ${formatDuration(segment.durationS)} at ${target}`
}

function Big({
  label,
  value,
  unit,
  sub,
  color,
  testId,
}: {
  label: string
  value: string
  unit?: string
  sub?: string
  color?: string
  testId?: string
}) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-stone-500">
        {color && <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />}
        {label}
      </div>
      <div className="mt-1 text-6xl font-semibold tabular-nums leading-none md:text-7xl" data-testid={testId}>
        {value}
        {unit && <span className="ml-1 text-lg font-normal text-stone-500">{unit}</span>}
      </div>
      <div className="mt-2 h-5 text-sm text-stone-600 dark:text-stone-400">{sub}</div>
    </div>
  )
}

function Small({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-lg bg-stone-100 px-3 py-2 dark:bg-stone-800">
      <div className="text-[11px] uppercase tracking-wide text-stone-500">{label}</div>
      <div className="text-xl font-semibold tabular-nums" data-testid={testId}>
        {value}
      </div>
    </div>
  )
}

function Ride({ session }: { session: RideSession }) {
  const view = useSyncExternalStore(session.subscribe, session.getView)
  const { trainer, hr } = useStore(connection)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const floating = useFloatingWindow()
  const { ftp, maxHr, thresholdHr } = session.profile
  // The FTP test has no fixed end: the rider stops the ramp and goes to the cool-down.
  const rampTest = session.workout.test === 'ramp'
  const cooldownIndex = rampTest ? rampCooldownIndex(session.workout) : -1
  const segment = view.segment
  const running = view.status === 'running'
  const paused = view.status === 'paused' || view.status === 'autopaused'

  const end = async () => {
    const id = await completeRide()
    navigate(id ? `summary/${id}` : '')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'Space') {
        e.preventDefault()
        const status = session.getView().status
        if (status === 'running') session.pause()
        else if (status === 'paused' || status === 'autopaused') session.resume()
      } else if (e.code === 'ArrowUp') {
        e.preventDefault()
        session.adjustIntensity(0.05)
      } else if (e.code === 'ArrowDown') {
        e.preventDefault()
        session.adjustIntensity(-0.05)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session])

  const power = view.status === 'ready' ? view.live.powerW : (view.power3s ?? view.live.powerW)
  const targetFraction = segment ? powerAt(segment, view.positionS) * view.intensity : null
  const zone = targetFraction === null ? null : powerZone(targetFraction)
  const hrBpm = view.live.hrBpm
  const hz = hrBpm === null ? null : hrZone(hrBpm, thresholdHr, maxHr)
  const offTarget =
    running && power !== null && view.targetW !== null && Math.abs(power - view.targetW) > Math.max(15, view.targetW * 0.1)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold">{session.workout.name}</h1>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            running
              ? 'bg-teal-100 text-teal-900 dark:bg-teal-900 dark:text-teal-100'
              : 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100'
          }`}
          data-testid="ride-status"
        >
          {STATUS_TEXT[view.status]}
        </span>
        <span className="ml-auto flex items-center gap-4 text-xs text-stone-600 dark:text-stone-400">
          <span className="flex items-center gap-1.5">
            <StatusDot status={trainer.status} />
            {trainer.status === 'connected'
              ? (trainer.name ?? 'Trainer')
              : trainer.status === 'reconnecting'
                ? 'Trainer reconnecting…'
                : 'No trainer'}
          </span>
          <span className="flex items-center gap-1.5">
            <StatusDot status={hr.status} />
            {hr.status === 'connected'
              ? (hr.name ?? 'Heart rate')
              : hr.status === 'reconnecting'
                ? 'Heart rate reconnecting…'
                : 'No heart rate'}
          </span>
        </span>
      </div>

      {rampTest && view.status !== 'finished' && (view.segment?.index ?? 0) < cooldownIndex && (
        <p className="rounded-lg border border-teal-600 bg-teal-50 p-3 text-sm text-teal-950 dark:bg-teal-950 dark:text-teal-100">
          FTP test: the target rises every minute. Stay seated, keep your cadence steady, and ride until you cannot hold
          the target any more. Then press "Done: cool down". How long you last decides the result, not the plan.
        </p>
      )}

      {trainer.status === 'connected' && trainer.targetAccepted === false && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          The trainer rejected the last target. Check that no other app is connected to it.
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <Big
          label="Power"
          value={power === null ? '–' : String(Math.round(power))}
          unit="W"
          color={zone?.color}
          sub={
            view.targetW === null
              ? undefined
              : `Target ${view.targetW} W${zone ? ` · Z${zone.zone} ${zone.name}` : ''}${offTarget ? ' · off target' : ''}`
          }
          testId="ride-power"
        />
        <Big
          label={segment ? `${segment.label}${segment.rep ? ` ${segment.rep}` : ''}` : 'Step'}
          value={formatDuration(view.segmentRemainingS)}
          sub={view.next ? `Next: ${describe(view.next, ftp, view.intensity)}` : 'Last step'}
          testId="ride-step-remaining"
        />
        <Big
          label="Heart rate"
          value={hrBpm === null ? '–' : String(hrBpm)}
          unit="bpm"
          color={hz?.color}
          sub={hz ? `Z${hz.zone} ${hz.name}` : view.avgHrBpm !== null ? `Average ${view.avgHrBpm} bpm` : undefined}
          testId="ride-hr"
        />
      </div>

      <div className="grid grid-cols-3 gap-2 md:grid-cols-7">
        <Small label="Cadence" value={view.live.cadenceRpm === null ? '–' : `${Math.round(view.live.cadenceRpm)} rpm`} />
        <Small label="Speed" value={`${view.speedKph.toFixed(1)} km/h`} />
        <Small label="Distance" value={`${(view.distanceM / 1000).toFixed(2)} km`} testId="ride-distance" />
        <Small label="Elapsed" value={formatDuration(view.activeS)} testId="ride-elapsed" />
        <Small
          label="Remaining"
          value={rampTest && (view.segment?.index ?? 0) < cooldownIndex ? 'open' : formatDuration(view.totalS - view.positionS)}
        />
        <Small label="Avg power" value={view.avgPowerW === null ? '–' : `${view.avgPowerW} W`} />
        <Small label="Work" value={`${Math.round(view.workKJ)} kJ`} />
      </div>

      <Card>
        <WorkoutGraph
          segments={session.segments}
          samples={session.samples}
          ftp={ftp}
          positionS={view.positionS}
          maxHr={maxHr}
        />
        <p className="mt-1 text-xs text-stone-500">
          Blocks: planned power by zone. Dark line: your power. Red line: heart rate.
        </p>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        {view.status === 'ready' && (
          <Button onClick={beginRide} size="lg">
            Start
          </Button>
        )}
        {running && (
          <Button onClick={() => session.pause()} size="lg">
            Pause
          </Button>
        )}
        {paused && (
          <Button
            onClick={() => {
              enableCues()
              session.resume()
            }}
            size="lg"
          >
            Resume
          </Button>
        )}
        {view.status !== 'ready' && rampTest && (view.segment?.index ?? 0) < cooldownIndex && (
          <Button onClick={() => session.jumpTo(cooldownIndex)} size="lg">
            Done: cool down
          </Button>
        )}
        {view.status !== 'ready' && !rampTest && (
          <Button onClick={() => session.skip()} kind="quiet" size="lg">
            Skip step
          </Button>
        )}
        {floating.supported && (
          <Button onClick={() => (floating.win ? floating.close() : void floating.open())} kind="quiet" size="lg">
            {floating.win ? 'Close floating window' : 'Floating window'}
          </Button>
        )}
        <span className="flex items-center gap-2">
          <Button onClick={() => session.adjustIntensity(-0.05)} kind="quiet" size="lg" title="Arrow down">
            − 5 %
          </Button>
          <span className="w-28 whitespace-nowrap text-center text-sm tabular-nums" data-testid="ride-intensity">
            Intensity {Math.round(view.intensity * 100)} %
          </span>
          <Button onClick={() => session.adjustIntensity(0.05)} kind="quiet" size="lg" title="Arrow up">
            + 5 %
          </Button>
        </span>
        <span className="ml-auto flex items-center gap-2">
          {view.status === 'ready' ? (
            <Button
              onClick={() => {
                discardRide()
                navigate('')
              }}
              kind="quiet"
              size="lg"
            >
              Cancel
            </Button>
          ) : confirmEnd ? (
            <>
              <Button onClick={() => void end()} kind="danger" size="lg">
                End and save
              </Button>
              <Button onClick={() => setConfirmEnd(false)} kind="quiet" size="lg">
                Keep riding
              </Button>
            </>
          ) : (
            <Button onClick={() => setConfirmEnd(true)} kind="quiet" size="lg">
              End ride
            </Button>
          )}
        </span>
      </div>
      <p className="text-xs text-stone-500">
        Keys: space pauses and resumes, arrow up and down change the intensity. Keep this tab open while riding.
        {floating.supported &&
          ' The floating window stays on top of other windows and apps, so you can watch something else while you ride.'}
      </p>
      <FloatingRide win={floating.win} session={session} />
    </div>
  )
}

export function RidePage() {
  const session = useStore(activeRide)
  const finished = useStore(finishedRideId)

  // The workout ran to its end and was saved: show its summary.
  useEffect(() => {
    if (finished === null) return
    finishedRideId.set(null)
    navigate(finished === 'none' ? '' : `summary/${finished}`)
  }, [finished])

  if (!session) {
    return (
      <Card title="No ride in progress">
        <a href={href('')} className="text-sm text-teal-700 underline dark:text-teal-400">
          Choose a workout
        </a>
      </Card>
    )
  }
  return <Ride key={session.startTs || 'new'} session={session} />
}
