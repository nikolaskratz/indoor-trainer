import { useEffect, useState } from 'react'
import { sessionStore } from '../lib/cloud.ts'
import { href } from '../lib/router.ts'
import { useStore } from '../lib/store.ts'
import { requestSync, switchBrowserToThisAccount, syncStore, type SyncState } from '../lib/sync.ts'
import { Button, Card } from './ui.tsx'

const DOT: Record<SyncState['status'], string> = {
  off: 'bg-stone-400',
  idle: 'bg-teal-600',
  syncing: 'bg-amber-500',
  error: 'bg-red-600',
  noaccess: 'bg-amber-500',
  otheraccount: 'bg-red-600',
}

function label(sync: SyncState): string {
  switch (sync.status) {
    case 'off':
      return 'This browser only'
    case 'syncing':
      return sync.lastSyncedAt === null ? 'Saving to your account…' : 'Saving…'
    case 'error':
      return 'Not saved to your account'
    case 'noaccess':
      return 'No access yet'
    case 'otheraccount':
      return 'Another account’s data'
    default:
      return 'Saved to your account'
  }
}

function hint(sync: SyncState): string {
  switch (sync.status) {
    case 'off':
      return 'Sign in on the start page to save your profile, workouts and rides to your account.'
    case 'noaccess':
      return 'Your account has not been given access yet, so nothing is saved to it.'
    case 'otheraccount':
      return 'This browser holds the data of another account. Open the profile page to decide what to do.'
    default:
      return sync.error ?? sync.progress ?? 'Profile, workouts and rides are saved to your account.'
  }
}

/** Small status in the navigation: is the data in the account or only in this browser? */
export function SyncBadge() {
  const sync = useStore(syncStore)
  const session = useStore(sessionStore)
  if (session === undefined) return null
  return (
    <a
      href={href(session ? 'profile' : '')}
      title={hint(sync)}
      className="flex items-center gap-1.5 text-xs text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
      data-testid="sync-badge"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${DOT[sync.status]}`} />
      {label(sync)}
    </a>
  )
}

/** Shown to an account the owner has not let in yet. */
export function NoAccessNote({ email }: { email: string | undefined }) {
  return (
    <div className="space-y-3 text-sm" data-testid="no-access">
      <p>
        Your account <span className="font-medium">{email}</span> has no access yet. Ask the person who runs this app to
        add this email address, then check again.
      </p>
      <p className="text-stone-600 dark:text-stone-400">
        Until then everything else works: the built-in workouts, riding and your ride history, stored in this browser.
      </p>
      <Button kind="quiet" onClick={() => requestSync(0)}>
        Check again
      </Button>
    </div>
  )
}

/** This browser holds another account's data: keep the two apart until the user decides. */
function OtherAccount({ email }: { email: string | undefined }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <div className="space-y-3 text-sm" data-testid="other-account">
      <p>
        This browser holds the profile, workouts and rides of another account. To keep the two apart, nothing is saved
        to or loaded from <span className="font-medium">{email}</span> here.
      </p>
      <p className="text-stone-600 dark:text-stone-400">
        Sign in with the other account again to carry on with its data. Or use this browser for {email} from now on:
        that removes the other account’s data from this browser. It stays in that account, except for changes made
        here that were not saved to it yet.
      </p>
      <div className="flex flex-wrap gap-2">
        {confirming ? (
          <>
            <Button
              kind="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void switchBrowserToThisAccount().finally(() => setBusy(false))
              }}
            >
              Remove the other account’s data here
            </Button>
            <Button kind="quiet" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button kind="quiet" onClick={() => setConfirming(true)}>
            Use this browser for {email}
          </Button>
        )}
      </div>
    </div>
  )
}

/** Profile page: where the data lives, when it was last saved, and a button to sync now. */
export function SyncCard() {
  const sync = useStore(syncStore)
  const session = useStore(sessionStore)
  // Re-render once a minute so "x minutes ago" stays right.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  if (session === undefined) return null
  const time = sync.lastSyncedAt === null ? null : new Date(sync.lastSyncedAt).toLocaleTimeString('en-GB', { timeStyle: 'short' })
  return (
    <Card title="Your data">
      {session === null ? (
        <p className="text-sm text-stone-600 dark:text-stone-400">
          Profile, workouts and rides are stored in this browser only.{' '}
          <a href={href('')} className="text-teal-700 underline dark:text-teal-400">
            Sign in on the start page
          </a>{' '}
          to save them to your account, so they survive a cleared browser and show up on another computer.
        </p>
      ) : sync.status === 'noaccess' ? (
        <NoAccessNote email={session.user.email} />
      ) : sync.status === 'otheraccount' ? (
        <OtherAccount email={session.user.email} />
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="flex items-center gap-2" data-testid="sync-status">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[sync.status]}`} />
            {sync.status === 'error'
              ? 'Could not save to your account. Your data is safe in this browser and will be sent again.'
              : sync.status === 'syncing' || sync.status === 'off'
                ? (sync.progress ?? 'Saving to your account…')
                : `Profile, workouts and rides are saved to your account${time ? ` (last checked ${time})` : ''}.`}
          </span>
          <span className="ml-auto">
            <Button kind="quiet" onClick={() => requestSync(0)} disabled={sync.status === 'syncing'}>
              Sync now
            </Button>
          </span>
          {sync.status === 'error' && sync.error && (
            <p className="w-full text-xs text-red-700 dark:text-red-400">Reason: {sync.error}</p>
          )}
        </div>
      )}
    </Card>
  )
}
