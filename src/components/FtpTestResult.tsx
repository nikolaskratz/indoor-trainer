import { rampTestResult } from '../domain/ftpTest.ts'
import { href } from '../lib/router.ts'
import { profileStore, type SavedRide } from '../lib/storage.ts'
import { useStore } from '../lib/store.ts'
import { Button, Card } from './ui.tsx'

/** Shown on the summary of an FTP test ride: the estimate, and a button to take it over. */
export function FtpTestResult({ ride }: { ride: SavedRide }) {
  const profile = useStore(profileStore)
  const result = rampTestResult(ride.samples, ride.profile.ftp)
  if (!result) {
    return (
      <Card title="FTP test result">
        <p className="text-sm text-stone-600 dark:text-stone-400">
          No result: the test needs at least one minute of recorded power. Check that the trainer was connected.
        </p>
      </Card>
    )
  }
  const current = profile.ftp
  const diff = current ? result.ftpW - current : null
  const applied = current === result.ftpW
  const newMaxHr = result.maxHrBpm !== null && (profile.maxHr === null || result.maxHrBpm > profile.maxHr) ? result.maxHrBpm : null

  return (
    <Card title="FTP test result">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className="text-xs text-stone-500">Estimated FTP</div>
          <div className="text-4xl font-semibold tabular-nums" data-testid="ftp-estimate">
            {result.ftpW} W
          </div>
        </div>
        <div>
          <div className="text-xs text-stone-500">Best minute</div>
          <div className="text-lg font-semibold tabular-nums">{result.bestMinuteW} W</div>
        </div>
        {result.maxHrBpm !== null && (
          <div>
            <div className="text-xs text-stone-500">Highest heart rate</div>
            <div className="text-lg font-semibold tabular-nums">{result.maxHrBpm} bpm</div>
          </div>
        )}
        <div>
          <div className="text-xs text-stone-500">FTP in your profile</div>
          <div className="text-lg font-semibold tabular-nums" data-testid="ftp-current">
            {current ? `${current} W` : 'not set'}
          </div>
        </div>
      </div>
      <p className="mt-3 max-w-3xl text-sm text-stone-600 dark:text-stone-400">
        The estimate is 75 % of your best minute, the usual rule for a ramp with one-minute steps.
        {diff !== null && !applied && ` That is ${Math.abs(diff)} W ${diff > 0 ? 'above' : 'below'} your current FTP.`}
      </p>
      {result.early && (
        <p className="mt-2 max-w-3xl text-sm text-amber-700 dark:text-amber-400">
          You stopped before the ramp reached the FTP this test was based on ({ride.profile.ftp} W), so the test was
          probably cut short and the estimate is too low. Only use it if you really rode to your limit.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {applied ? (
          <span className="text-sm font-medium text-teal-700 dark:text-teal-400" data-testid="ftp-applied">
            Your FTP is set to {result.ftpW} W. All workouts now use it.
          </span>
        ) : (
          <Button onClick={() => profileStore.set({ ...profileStore.get(), ftp: result.ftpW })}>
            Set my FTP to {result.ftpW} W
          </Button>
        )}
        {newMaxHr !== null && (
          <Button kind="quiet" onClick={() => profileStore.set({ ...profileStore.get(), maxHr: newMaxHr })}>
            Set max heart rate to {newMaxHr} bpm
          </Button>
        )}
        <a href={href('profile')} className="text-sm text-teal-700 underline dark:text-teal-400">
          Open profile
        </a>
      </div>
    </Card>
  )
}
