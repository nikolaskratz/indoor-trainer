import { useState } from 'react'
import { href } from '../lib/router.ts'
import type { SavedRide } from '../lib/storage.ts'
import { useStore } from '../lib/store.ts'
import { disconnectStrava, startStravaConnect, stravaNotice, stravaStore, uploadRide } from '../lib/strava.ts'
import { Button, Card } from './ui.tsx'

/** One-off message after coming back from Strava's permission page. */
export function StravaNotice() {
  const notice = useStore(stravaNotice)
  if (!notice) return null
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border p-3 text-sm ${
        notice.ok
          ? 'border-teal-600 bg-teal-50 text-teal-950 dark:bg-teal-950 dark:text-teal-100'
          : 'border-red-400 bg-red-50 text-red-950 dark:bg-red-950 dark:text-red-100'
      }`}
    >
      <span>{notice.text}</span>
      <button type="button" className="ml-auto text-xs underline" onClick={() => stravaNotice.set(null)}>
        Dismiss
      </button>
    </div>
  )
}

/** Connection status with connect and disconnect, for the profile page. */
export function StravaCard() {
  const strava = useStore(stravaStore)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Card title="Strava">
      {strava.kind === 'unknown' && <p className="text-sm text-stone-500">Checking…</p>}
      {strava.kind === 'signed-out' && (
        <p className="text-sm text-stone-600 dark:text-stone-400">
          Sign in on the{' '}
          <a href={href('')} className="underline">
            start page
          </a>{' '}
          to connect Strava.
        </p>
      )}
      {strava.kind === 'unavailable' && (
        <p className="text-sm text-stone-600 dark:text-stone-400">Strava upload is not set up on the server yet.</p>
      )}
      {strava.kind === 'disconnected' && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => startStravaConnect(strava.clientId)}>Connect Strava</Button>
          <span className="text-sm text-stone-600 dark:text-stone-400">
            Opens Strava to ask for permission to upload your rides.
          </span>
        </div>
      )}
      {strava.kind === 'connected' && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">
            Connected{strava.athlete ? ` as ${strava.athlete}` : ''}. Finished rides can be uploaded from their summary.
          </span>
          <Button
            kind="quiet"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              setError(null)
              disconnectStrava()
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false))
            }}
          >
            Disconnect
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
    </Card>
  )
}

const activityUrl = (id: number) => `https://www.strava.com/activities/${id}`

/** Upload button and result for one ride, for the summary page. */
export function StravaUpload({ ride, onUploaded }: { ride: SavedRide; onUploaded: (activityId: number) => void }) {
  const strava = useStore(stravaStore)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (ride.stravaActivityId) {
    return (
      <a
        href={activityUrl(ride.stravaActivityId)}
        target="_blank"
        rel="noreferrer"
        className="text-sm font-medium text-teal-700 underline dark:text-teal-400"
      >
        On Strava: view activity
      </a>
    )
  }
  if (strava.kind === 'unknown') return null
  if (strava.kind === 'signed-out') {
    return (
      <span className="text-sm text-stone-600 dark:text-stone-400">
        Sign in on the{' '}
        <a href={href('')} className="underline">
          start page
        </a>{' '}
        to upload to Strava.
      </span>
    )
  }
  if (strava.kind === 'unavailable') {
    return (
      <span className="text-sm text-stone-600 dark:text-stone-400">
        Strava upload is not set up yet; the file can be uploaded on strava.com by hand.
      </span>
    )
  }
  if (strava.kind === 'disconnected') {
    return (
      <Button kind="quiet" onClick={() => startStravaConnect(strava.clientId)}>
        Connect Strava to upload
      </Button>
    )
  }
  const upload = () => {
    setError(null)
    uploadRide(ride, setProgress)
      .then(onUploaded)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setProgress(null))
  }
  return (
    <span className="flex flex-wrap items-center gap-3">
      <Button onClick={upload} disabled={progress !== null}>
        {progress ?? 'Upload to Strava'}
      </Button>
      {error && <span className="text-sm text-red-700 dark:text-red-400">{error}</span>}
    </span>
  )
}
