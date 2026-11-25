import { useState, type FormEvent } from 'react'
import { generateWorkout, sessionStore, signIn, signOut } from '../lib/cloud.ts'
import { href, navigate } from '../lib/router.ts'
import { profileStore, riderProfile, saveWorkout } from '../lib/storage.ts'
import { useStore } from '../lib/store.ts'
import { Button, Card } from './ui.tsx'

const EXAMPLES = ['45 min easy Z2 with some variations', '3x10x 30sec/30sec VO2 max workout', '60 min with 3x12 min sweet spot']

const INPUT =
  'w-full rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900'

function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setError(await signIn(email, password))
    setBusy(false)
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <p className="text-sm text-stone-600 dark:text-stone-400">
        Sign in to create workouts from a description. Use the same account as Tri Coach.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          type="email"
          required
          autoComplete="username"
          placeholder="Email"
          aria-label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={INPUT}
        />
        <input
          type="password"
          required
          autoComplete="current-password"
          placeholder="Password"
          aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={INPUT}
        />
      </div>
      {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

/** Describe a workout in words and get a structured one back. */
export function PromptCard() {
  const session = useStore(sessionStore)
  const profile = riderProfile(useStore(profileStore))
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    if (!profile || !prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const workout = await generateWorkout(prompt.trim(), profile)
      saveWorkout(workout)
      setPrompt('')
      navigate(`workout/${workout.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Create a workout"
      action={
        session ? (
          <button type="button" onClick={() => void signOut()} className="text-xs text-stone-500 underline">
            Sign out {session.user.email}
          </button>
        ) : undefined
      }
    >
      {session === undefined ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : session === null ? (
        <SignIn />
      ) : (
        <div className="space-y-3">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void create()
            }}
            rows={2}
            maxLength={1500}
            placeholder="Describe the session, e.g. 45 min easy Z2 with some variations"
            aria-label="Workout description"
            className={INPUT}
          />
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setPrompt(example)}
                className="rounded-full border border-stone-300 px-3 py-1 text-xs text-stone-700 hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
              >
                {example}
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void create()} disabled={busy || !prompt.trim() || !profile}>
              {busy ? 'Creating… (up to a minute)' : 'Create workout'}
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
          </div>
        </div>
      )}
    </Card>
  )
}
