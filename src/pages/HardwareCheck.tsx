import { useEffect, useRef, useState } from 'react'
import {
  bluetooth,
  connection,
  connectHr,
  connectTrainer,
  deviceLog,
  addLog,
  disconnectHr,
  disconnectTrainer,
  live,
  onPower,
  releaseTarget,
  setTarget,
  SIM,
} from '../ble/devices.ts'
import { SERVICE, SERVICE_LABEL } from '../ble/uuids.ts'
import { PowerChart, type ChartPoint } from '../components/PowerChart.tsx'
import { Button, Card, Stat } from '../components/ui.tsx'
import { evaluateErgStep, type ErgStepResult } from '../ergTest.ts'
import { activeRide } from '../lib/activeRide.ts'
import { useStore } from '../lib/store.ts'

/** Seconds per ERG test step; shortened by the automated test. */
const STEP_SECONDS = Math.max(4, Number(new URLSearchParams(location.search).get('step')) || 20)

type Check = 'pass' | 'fail' | 'pending'

interface ErgRun {
  state: 'idle' | 'running' | 'done' | 'aborted'
  message: string
  results: ErgStepResult[]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const tri = (value: boolean | null): Check => (value === null ? 'pending' : value ? 'pass' : 'fail')

export function HardwareCheck() {
  const { trainer, hr } = useStore(connection)
  const l = useStore(live)
  const log = useStore(deviceLog)
  const ride = useStore(activeRide)

  const [sawPower, setSawPower] = useState(false)
  const [sawCadence, setSawCadence] = useState(false)
  const [sawHr, setSawHr] = useState(false)
  const [targetInput, setTargetInput] = useState('150')
  const [lowW, setLowW] = useState('120')
  const [highW, setHighW] = useState('180')
  const [erg, setErg] = useState<ErgRun>({ state: 'idle', message: '', results: [] })
  const [copied, setCopied] = useState(false)
  const [chart, setChart] = useState<ChartPoint[]>([])
  const [now, setNow] = useState(() => Date.now())
  const pointsRef = useRef<ChartPoint[]>([])
  const abortRef = useRef(false)

  if (l.powerW !== null && !sawPower) setSawPower(true)
  if (l.cadenceRpm !== null && !sawCadence) setSawCadence(true)
  if (l.hrBpm !== null && !sawHr) setSawHr(true)

  // Collect power readings for the chart and the ERG test.
  useEffect(
    () =>
      onPower((reading) => {
        pointsRef.current.push({ ...reading, targetW: connection.get().trainer.targetW })
        if (pointsRef.current.length > 4000) pointsRef.current.splice(0, 1000)
      }),
    [],
  )
  const connected = trainer.status === 'connected'
  useEffect(() => {
    if (!connected) return
    const id = setInterval(() => {
      const t = Date.now()
      setNow(t)
      setChart(pointsRef.current.filter((p) => p.t >= t - 95_000))
    }, 500)
    return () => clearInterval(id)
  }, [connected])
  useEffect(
    () => () => {
      abortRef.current = true
    },
    [],
  )

  // Keep the newest log line in view.
  const logRef = useRef<HTMLPreElement | null>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const runErgTest = async () => {
    const low = Number(lowW)
    const high = Number(highW)
    if (!(low > 0 && high > low)) {
      setErg({ state: 'idle', message: 'Enter a low and a higher wattage first.', results: [] })
      return
    }
    abortRef.current = false
    const results: ErgStepResult[] = []
    setErg({ state: 'running', message: 'Taking control of the trainer', results })
    addLog(`[test] ERG test started: ${low} W, ${high} W, ${low} W, ${STEP_SECONDS} s each`)
    for (const [i, target] of [low, high, low].entries()) {
      if (abortRef.current) break
      if (!(await setTarget(target))) {
        setErg({ state: 'done', message: `The trainer rejected the ${target} W target.`, results: [...results] })
        addLog(`[test] Aborted: target ${target} W rejected`)
        return
      }
      const start = Date.now()
      for (let left = STEP_SECONDS; left > 0 && !abortRef.current; left--) {
        setErg({
          state: 'running',
          message: `Step ${i + 1} of 3: hold a steady cadence at ${target} W (${left} s)`,
          results: [...results],
        })
        await sleep(1000)
      }
      if (abortRef.current) break
      const result = evaluateErgStep(pointsRef.current, target, start, Date.now())
      results.push(result)
      addLog(
        `[test] Step ${i + 1}: target ${target} W, held ${result.meanW ?? '?'} W, settled in ${result.settleS ?? '?'} s: ${result.pass ? 'pass' : 'FAIL'}`,
      )
    }
    if (abortRef.current) {
      setErg({ state: 'aborted', message: 'Test stopped.', results: [...results] })
      return
    }
    const passed = results.every((r) => r.pass)
    setErg({
      state: 'done',
      message: passed ? 'ERG mode works: the trainer held every target.' : 'The trainer did not hold every target.',
      results: [...results],
    })
  }

  const info = trainer.info
  const hasFtms = info?.services.includes(SERVICE.FTMS) ?? false
  const ergCheck: Check =
    erg.state === 'done' && erg.results.length === 3 ? (erg.results.every((r) => r.pass) ? 'pass' : 'fail') : 'pending'
  const checks: { label: string; state: Check; detail?: string }[] = [
    { label: 'Browser supports Web Bluetooth', state: bluetooth ? 'pass' : 'fail' },
    { label: 'Trainer connected', state: info ? 'pass' : 'pending', detail: info?.name },
    { label: 'Trainer speaks the standard control protocol (FTMS)', state: info ? (hasFtms ? 'pass' : 'fail') : 'pending' },
    { label: 'Power readings arrive', state: sawPower ? 'pass' : 'pending' },
    { label: 'Cadence readings arrive', state: sawCadence ? 'pass' : 'pending' },
    { label: 'Trainer grants control', state: tri(trainer.control) },
    { label: 'Trainer accepts a target power', state: tri(trainer.targetAccepted) },
    { label: 'ERG mode holds the target (automatic test)', state: ergCheck },
    { label: 'Heart rate monitor connected', state: hr.name ? 'pass' : 'pending', detail: hr.name ?? undefined },
    { label: 'Heart rate readings arrive', state: sawHr ? 'pass' : 'pending' },
  ]

  const buildReport = (): string => {
    const f = info?.features
    return [
      'Indoor Trainer hardware check',
      `Date: ${new Date().toISOString()}`,
      `Browser: ${navigator.userAgent}`,
      SIM ? 'Mode: SIMULATED devices' : 'Mode: real devices',
      '',
      'Checklist:',
      ...checks.map((c) => `  [${c.state}] ${c.label}${c.detail ? ` (${c.detail})` : ''}`),
      '',
      'Trainer:',
      info
        ? [
            `  name: ${info.name}`,
            `  manufacturer/model: ${info.manufacturer ?? '?'} / ${info.model ?? '?'}`,
            `  firmware/hardware: ${info.firmware ?? '?'} / ${info.hardware ?? '?'}`,
            `  services: ${info.services.map((s) => SERVICE_LABEL[s] ?? s).join(', ') || 'none'}`,
            `  control point: ${info.hasControlPoint}`,
            f
              ? `  features: machine 0x${f.machineBits.toString(16)}, targets 0x${f.targetBits.toString(16)} (power target ${f.powerTarget}, cadence ${f.cadence}, simulation ${f.simulation})`
              : '  features: not read',
            info.powerRange
              ? `  power range: ${info.powerRange.minW}-${info.powerRange.maxW} W, step ${info.powerRange.stepW} W`
              : '  power range: not read',
          ].join('\n')
        : '  not connected',
      '',
      'ERG test:',
      erg.results.length
        ? erg.results
            .map(
              (r, i) =>
                `  step ${i + 1}: target ${r.targetW} W, held ${r.meanW ?? '?'} W (tolerance ${r.toleranceW} W), settled in ${r.settleS ?? '?'} s, ${r.pass ? 'pass' : `FAIL${r.reason ? `: ${r.reason}` : ''}`}`,
            )
            .join('\n')
        : '  not run',
      '',
      `Heart rate monitor: ${hr.name ?? 'not connected'}${hr.battery !== null ? `, battery ${hr.battery} %` : ''}${l.hrBpm !== null ? `, last ${l.hrBpm} bpm, beat intervals ${l.hrHasRr}` : ''}`,
      '',
      'Log:',
      ...log,
    ].join('\n')
  }

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(buildReport())
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      addLog('[page] Clipboard blocked: select the log text manually')
    }
  }

  const testing = erg.state === 'running'
  const busy = testing || ride !== null

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Hardware check</h1>
        <p className="mt-1 max-w-3xl text-sm text-stone-600 dark:text-stone-400">
          Checks that this browser can read and control your trainer and read your heart rate strap. Work through the
          steps, then copy the report.
        </p>
      </header>

      {!bluetooth && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          This browser has no Web Bluetooth. Open this page in Google Chrome on your Mac.
        </div>
      )}
      {ride && (
        <div className="rounded-lg border border-amber-500 bg-amber-50 p-4 text-sm text-amber-950">
          A ride is open, so the controls here are disabled: they would fight the ride over the trainer.
        </div>
      )}

      <Card title="Before you start">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Plug in the trainer and spin the pedals so it wakes up.</li>
          <li>Close MyWhoosh, Zwift and any other app connected to the trainer by Bluetooth, on every device.</li>
          <li>Put on the chest strap (it only switches on with skin contact).</li>
          <li>
            If Chrome asks for Bluetooth permission, allow it. If no devices appear, check System Settings, Privacy and
            Security, Bluetooth, and enable Google Chrome.
          </li>
        </ol>
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        <Card title="1. Trainer">
          <div className="flex flex-wrap items-center gap-2">
            {trainer.status !== 'idle' ? (
              <Button onClick={disconnectTrainer} kind="quiet" disabled={ride !== null}>
                Disconnect
              </Button>
            ) : (
              <>
                <Button onClick={() => void connectTrainer(false)} disabled={!bluetooth}>
                  Connect trainer
                </Button>
                <Button onClick={() => void connectTrainer(true)} disabled={!bluetooth} kind="quiet">
                  Not listed? Show all devices
                </Button>
              </>
            )}
            {(trainer.status === 'connecting' || trainer.status === 'reconnecting') && (
              <span className="text-sm text-stone-500">{trainer.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>
            )}
          </div>
          {trainer.error && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{trainer.error}</p>}
          {connected && info && (
            <>
              <p className="mt-3 text-sm" data-testid="trainer-name">
                <span className="font-medium">{info.name}</span>
                {info.firmware && <span className="text-stone-500"> · firmware {info.firmware}</span>}
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Stat label="Power" value={l.powerW} unit="W" testId="power" />
                <Stat label="Cadence" value={l.cadenceRpm} unit="rpm" testId="cadence" />
                <Stat label="Speed" value={l.speedKph} unit="km/h" digits={1} />
              </div>
              <p className="mt-2 text-xs text-stone-500">
                Power by source: trainer protocol {l.ftmsPowerW ?? 'none'} W, power service {l.cpsPowerW ?? 'none'} W
              </p>
            </>
          )}
        </Card>

        <Card title="2. Heart rate strap">
          <div className="flex flex-wrap items-center gap-2">
            {hr.status !== 'idle' ? (
              <Button onClick={disconnectHr} kind="quiet">
                Disconnect
              </Button>
            ) : (
              <Button onClick={() => void connectHr()} disabled={!bluetooth}>
                Connect heart rate strap
              </Button>
            )}
            {(hr.status === 'connecting' || hr.status === 'reconnecting') && (
              <span className="text-sm text-stone-500">{hr.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>
            )}
          </div>
          {hr.error && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{hr.error}</p>}
          {hr.status === 'connected' && (
            <>
              <p className="mt-3 text-sm">
                <span className="font-medium">{hr.name}</span>
                {hr.battery !== null && <span className="text-stone-500"> · battery {hr.battery} %</span>}
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Stat label="Heart rate" value={l.hrBpm} unit="bpm" testId="hr" />
              </div>
              {l.hrContact === false && <p className="mt-2 text-xs text-amber-700">The strap reports no skin contact.</p>}
            </>
          )}
        </Card>
      </div>

      <Card title="3. Control the trainer">
        {!connected ? (
          <p className="text-sm text-stone-500">Connect the trainer first.</p>
        ) : (
          <>
            <p className="text-sm text-stone-600 dark:text-stone-400">
              Pedal at a steady cadence. Set a target and you should feel the resistance change within a few seconds.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {[100, 150, 200].map((w) => (
                <Button key={w} onClick={() => void setTarget(w)} disabled={busy} kind="quiet">
                  {w} W
                </Button>
              ))}
              <input
                type="number"
                min="0"
                max="2000"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                aria-label="Target power in watts"
                className="w-24 rounded border border-stone-300 bg-white px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-900"
              />
              <Button onClick={() => void setTarget(Number(targetInput))} disabled={busy || !(Number(targetInput) > 0)}>
                Set target
              </Button>
              <Button onClick={() => void releaseTarget()} disabled={busy} kind="quiet">
                Release control
              </Button>
              <span className="text-sm text-stone-600 dark:text-stone-400" data-testid="target">
                Target: {trainer.targetW === null ? 'none' : `${trainer.targetW} W`}
              </span>
            </div>
            <div className="mt-3">
              <PowerChart points={chart} now={now} />
              <p className="text-xs text-stone-500">Solid line: measured power. Dashed line: target. Last 90 seconds.</p>
            </div>

            <div className="mt-5 border-t border-stone-200 pt-4 dark:border-stone-800">
              <h3 className="text-sm font-semibold">Automatic ERG test (about {STEP_SECONDS * 3} seconds)</h3>
              <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
                Sets three targets in a row and checks that your measured power follows. Pick two wattages you can hold
                comfortably and keep pedalling throughout.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-1">
                  Low
                  <input
                    type="number"
                    value={lowW}
                    onChange={(e) => setLowW(e.target.value)}
                    disabled={testing}
                    className="w-20 rounded border border-stone-300 bg-white px-2 py-1.5 dark:border-stone-700 dark:bg-stone-900"
                  />
                  W
                </label>
                <label className="flex items-center gap-1">
                  High
                  <input
                    type="number"
                    value={highW}
                    onChange={(e) => setHighW(e.target.value)}
                    disabled={testing}
                    className="w-20 rounded border border-stone-300 bg-white px-2 py-1.5 dark:border-stone-700 dark:bg-stone-900"
                  />
                  W
                </label>
                {testing ? (
                  <Button onClick={() => (abortRef.current = true)} kind="quiet">
                    Stop test
                  </Button>
                ) : (
                  <Button onClick={() => void runErgTest()} disabled={busy}>
                    Run ERG test
                  </Button>
                )}
              </div>
              {erg.message && (
                <p className="mt-3 text-sm font-medium" data-testid="erg-message">
                  {erg.message}
                </p>
              )}
              {erg.results.length > 0 && (
                <table className="mt-2 w-full max-w-xl text-left text-sm">
                  <thead className="text-xs text-stone-500">
                    <tr>
                      <th className="py-1 font-normal">Step</th>
                      <th className="font-normal">Target</th>
                      <th className="font-normal">Held</th>
                      <th className="font-normal">Settled after</th>
                      <th className="font-normal">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {erg.results.map((r, i) => (
                      <tr key={i} className="border-t border-stone-200 dark:border-stone-800">
                        <td className="py-1">{i + 1}</td>
                        <td>{r.targetW} W</td>
                        <td>{r.meanW === null ? 'no data' : `${r.meanW} W`}</td>
                        <td>{r.settleS === null ? 'never' : `${r.settleS} s`}</td>
                        <td className={r.pass ? 'text-teal-700 dark:text-teal-400' : 'text-red-700 dark:text-red-400'}>
                          {r.pass ? 'pass' : (r.reason ?? 'fail')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </Card>

      <Card title="Results">
        <ul className="space-y-1 text-sm" data-testid="checklist">
          {checks.map((c) => (
            <li key={c.label} className="flex items-baseline gap-2" data-state={c.state}>
              <span
                className={
                  c.state === 'pass'
                    ? 'w-4 font-bold text-teal-700 dark:text-teal-400'
                    : c.state === 'fail'
                      ? 'w-4 font-bold text-red-700 dark:text-red-400'
                      : 'w-4 text-stone-400'
                }
              >
                {c.state === 'pass' ? '✓' : c.state === 'fail' ? '✗' : '·'}
              </span>
              <span>
                {c.label}
                {c.detail && <span className="text-stone-500"> ({c.detail})</span>}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={() => void copyReport()}>{copied ? 'Copied' : 'Copy report'}</Button>
          <span className="text-xs text-stone-500">
            Copies the checklist, device details and the log below, to paste back to Claude.
          </span>
        </div>
      </Card>

      <Card title="Log">
        <pre
          ref={logRef}
          className="max-h-72 overflow-auto rounded bg-stone-900 p-3 font-mono text-xs leading-relaxed text-stone-200"
          data-testid="log"
        >
          {log.length ? log.join('\n') : 'Nothing yet.'}
        </pre>
      </Card>
    </div>
  )
}
