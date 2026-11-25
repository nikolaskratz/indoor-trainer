import { useEffect, useState } from 'react'
import { sessionStore } from '../lib/cloud.ts'
import { href } from '../lib/router.ts'
import { useStore } from '../lib/store.ts'
import { requestSync, syncStore, type SyncState } from '../lib/sync.ts'
import { Button, Card } from './ui.tsx'

const DOT: Record<SyncState['status'], string> = {
  off: 'bg-stone-400',
  idle: 'bg-teal-600',
  syncing: 'bg-amber-500',
  error: 'bg-red-600',
}

function label(sync: SyncState): string {
  switch (sync.status) {
    case 'off':
      return 'This browser only'
    case 'syncing':
      return sync.lastSyncedAt === null ? 'Saving to your account…' : 'Saving…'
    case 'error':
      return 'Not saved to your account'
    default:
      return 'Saved to your account'
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
      title={
        sync.status === 'off'
          ? 'Sign in on the start page to save your profile, workouts and rides to your account.'
          : (sync.error ?? sync.progress ?? 'Profile, workouts and rides are saved to your account.')
      }
      className="flex items-center gap-1.5 text-xs text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
      data-testid="sync-badge"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${DOT[sync.status]}`} />
      {label(sync)}
    </a>
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
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="flex items-center gap-2" data-testid="sync-status">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[sync.status]}`} />
            {sync.status === 'error'
              ? 'Could not save to your account. Your data is safe in this browser and will be sent again.'
              : sync.status === 'syncing'
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
