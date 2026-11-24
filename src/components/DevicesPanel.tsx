import {
  bluetooth,
  connection,
  connectHr,
  connectTrainer,
  disconnectHr,
  disconnectTrainer,
  live,
} from '../ble/devices.ts'
import { href } from '../lib/router.ts'
import { useStore } from '../lib/store.ts'
import { Button, Card, StatusDot } from './ui.tsx'

/** Connect and disconnect the trainer and the heart rate strap, with live readings. */
export function DevicesPanel() {
  const { trainer, hr } = useStore(connection)
  const l = useStore(live)
  if (!bluetooth) {
    return (
      <Card title="Devices">
        <p className="text-sm text-red-700 dark:text-red-400">
          This browser has no Web Bluetooth. Open the app in Google Chrome on your Mac.
        </p>
      </Card>
    )
  }
  return (
    <Card
      title="Devices"
      action={
        <a href={href('check')} className="text-xs text-teal-700 underline dark:text-teal-400">
          Hardware check
        </a>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <StatusDot status={trainer.status} />
          <span className="min-w-28 font-medium">{trainer.name ?? 'Trainer'}</span>
          {trainer.status === 'connected' && (
            <span className="tabular-nums text-stone-600 dark:text-stone-400" data-testid="dev-power">
              {l.powerW === null ? 'no power signal' : `${Math.round(l.powerW)} W`}
              {l.cadenceRpm !== null && ` · ${Math.round(l.cadenceRpm)} rpm`}
            </span>
          )}
          <span className="ml-auto flex gap-2">
            {trainer.status === 'idle' ? (
              <>
                <Button onClick={() => void connectTrainer(false)}>Connect trainer</Button>
                <Button onClick={() => void connectTrainer(true)} kind="quiet" title="Lists every nearby Bluetooth device">
                  Not listed?
                </Button>
              </>
            ) : (
              <Button onClick={disconnectTrainer} kind="quiet">
                Disconnect
              </Button>
            )}
          </span>
        </div>
        {trainer.error && <p className="text-xs text-red-700 dark:text-red-400">{trainer.error}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <StatusDot status={hr.status} />
          <span className="min-w-28 font-medium">{hr.name ?? 'Heart rate strap'}</span>
          {hr.status === 'connected' && (
            <span className="tabular-nums text-stone-600 dark:text-stone-400" data-testid="dev-hr">
              {l.hrBpm === null ? 'no signal' : `${l.hrBpm} bpm`}
              {hr.battery !== null && ` · battery ${hr.battery} %`}
            </span>
          )}
          <span className="ml-auto">
            {hr.status === 'idle' ? (
              <Button onClick={() => void connectHr()}>Connect heart rate</Button>
            ) : (
              <Button onClick={disconnectHr} kind="quiet">
                Disconnect
              </Button>
            )}
          </span>
        </div>
        {hr.error && <p className="text-xs text-red-700 dark:text-red-400">{hr.error}</p>}
      </div>
    </Card>
  )
}
