import { useEffect, useRef, useState } from 'react'
import { flatten, formatDuration, totalDuration, type Workout } from '../domain/workout.ts'
import { reviseWorkout, sessionStore } from '../lib/cloud.ts'
import { href, navigate } from '../lib/router.ts'
import { profileStore, riderProfile, workoutStore } from '../lib/storage.ts'
import { useStore } from '../lib/store.ts'
import { Button, Card } from './ui.tsx'

const EXAMPLES = ['Make the warm-up shorter', 'Make it 10 minutes longer', 'Make it a little easier']

const length = (w: Workout) => formatDuration(totalDuration(flatten(w.blocks)))

/**
 * Change a workout by describing the change. The user's own workouts change in place
 * (with an undo while the page stays open); a built-in one is saved as a changed copy.
 */
export function ChangeCard({ workout }: { workout: Workout }) {
  const session = useStore(sessionStore)
  const profile = riderProfile(useStore(profileStore))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The version before the last change, kept for the undo. */
  const [previous, setPrevious] = useState<Workout | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const own = workout.source === 'prompt'

  const apply = async () => {
    const change = text.trim()
    if (!profile || !change || busy) return
    setBusy(true)
    setError(null)
    try {
      const revised = await reviseWorkout(workout, change, profile)
      if (revised.id === workout.id) {
        workoutStore.set((list) => list.map((w) => (w.id === revised.id ? revised : w)))
        setPrevious(workout)
        setText('')
      } else {
        workoutStore.set((list) => [revised, ...list])
        if (mounted.current) navigate(`workout/${revised.id}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const undo = () => {
    if (!previous) return
    workoutStore.set((list) => list.map((w) => (w.id === previous.id ? previous : w)))
    setPrevious(null)
  }

  if (session === undefined) return null
  return (
    <Card title="Change this workout">
      {session === null ? (
        <p className="text-sm text-stone-600 dark:text-stone-400">
          <a href={href('')} className="text-teal-700 underline dark:text-teal-400">
            Sign in on the start page
          </a>{' '}
          to change a workout by describing the change.
        </p>
      ) : (
        <div className="space-y-3">
          {previous && (
            <p className="flex flex-wrap items-center gap-3 text-sm" data-testid="change-done">
              <span>
                Changed: "{workout.changes?.at(-1)}". Length {length(previous)} → {length(workout)}.
              </span>
              <Button kind="quiet" onClick={undo}>
                Undo
              </Button>
            </p>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void apply()
            }}
            rows={2}
            maxLength={1500}
            placeholder="Describe the change, e.g. make the warm-up shorter"
            aria-label="Change description"
            className="w-full rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
          />
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setText(example)}
                className="rounded-full border border-stone-300 px-3 py-1 text-xs text-stone-700 hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
              >
                {example}
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void apply()} disabled={busy || !text.trim() || !profile}>
              {busy ? 'Changing… (up to a minute)' : 'Change workout'}
            </Button>
            {!profile ? (
              <span className="text-sm text-amber-700 dark:text-amber-400">
                Enter your FTP and weight in the{' '}
                <a href={href('profile')} className="underline">
                  profile
                </a>{' '}
                first.
              </span>
            ) : (
              !own && (
                <span className="text-sm text-stone-600 dark:text-stone-400">
                  Built-in workouts stay as they are: the changed version is saved as a new workout.
                </span>
              )
            )}
          </div>
        </div>
      )}
    </Card>
  )
}
