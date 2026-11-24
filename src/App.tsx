import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { HeartRateMonitor, requestHeartRateDevice } from './ble/hrm.ts'
import type { HeartRateSample } from './ble/sensors.ts'
import { simBluetooth } from './ble/sim.ts'
import { requestTrainerDevice, Trainer, type TrainerInfo, type TrainerSample } from './ble/trainer.ts'
import { SERVICE, SERVICE_LABEL } from './ble/uuids.ts'
import { PowerChart, type ChartPoint } from './components/PowerChart.tsx'
import { evaluateErgStep, type ErgStepResult } from './ergTest.ts'

const params = new URLSearchParams(location.search)
const SIM = params.has('sim')
/** Seconds per ERG test step; shortened by the automated test. */
const STEP_SECONDS = Math.max(4, Number(params.get('step')) || 20)

const bluetooth: Bluetooth | null = SIM ? simBluetooth : (navigator.bluetooth ?? null)

type Conn = 'idle' | 'connecting' | 'connected'
type Check = 'pass' | 'fail' | 'pending'

interface Live {
  ftmsPower: number | null
  cpsPower: number | null
  cadence: number | null
  speed: number | null
}

interface ErgRun {
  state: 'idle' | 'running' | 'done' | 'aborted'
  message: string
  results: ErgStepResult[]
}

const emptyLive: Live = { ftmsPower: null, cpsPower: null, cadence: null, speed: null }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const clock = () => new Date().toLocaleTimeString('en-GB', { hour12: false })

function errorText(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotFoundError') return 'No device was chosen.'
  return e instanceof Error ? e.message : String(e)
}

export default function App() {
  const [log, setLog] = useState<string[]>([])
  const addLog = useCallback((message: string) => {
    setLog((lines) => [...lines.slice(-599), `${clock()}  ${message}`])
  }, [])

  // Trainer
  const trainerRef = useRef<Trainer | null>(null)
  const [trainerConn, setTrainerConn] = useState<Conn>('idle')
  const [trainerInfo, setTrainerInfo] = useState<TrainerInfo | null>(null)
  const [trainerError, setTrainerError] = useState<string | null>(null)
  const [live, setLive] = useState<Live>(emptyLive)
  const [sawPower, setSawPower] = useState(false)
  const [sawCadence, setSawCadence] = useState(false)
  const [control, setControl] = useState<Check>('pending')
  const [targetAccepted, setTargetAccepted] = useState<Check>('pending')
  const [targetW, setTargetW] = useState<number | null>(null)
  const [targetInput, setTargetInput] = useState('150')
  const targetRef = useRef<number | null>(null)
  const powerRef = useRef<ChartPoint[]>([])
  /** Mirrors `control` for code that runs across several awaits. */
  const hasControlRef = useRef(false)
  const lastFtmsPowerAt = useRef(0)
  const [chart, setChart] = useState<ChartPoint[]>([])
  const [now, setNow] = useState(() => Date.now())

  // Heart rate
  const hrmRef = useRef<HeartRateMonitor | null>(null)
  const [hrConn, setHrConn] = useState<Conn>('idle')
  const [hrName, setHrName] = useState<string | null>(null)
  const [hrBattery, setHrBattery] = useState<number | null>(null)
  const [hrError, setHrError] = useState<string | null>(null)
  const [hr, setHr] = useState<HeartRateSample | null>(null)

  // ERG test
  const [lowW, setLowW] = useState('120')
  const [highW, setHighW] = useState('180')
  const [erg, setErg] = useState<ErgRun>({ state: 'idle', message: '', results: [] })
  const abortRef = useRef(false)

  const [copied, setCopied] = useState(false)

  // Keep the newest log line in view.
  const logRef = useRef<HTMLPreElement | null>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  // Redraw the chart twice a second while a trainer is connected.
  useEffect(() => {
    if (trainerConn !== 'connected') return
    const id = setInterval(() => {
      const t = Date.now()
      setNow(t)
      setChart(powerRef.current.filter((p) => p.t >= t - 95_000))
    }, 500)
    return () => clearInterval(id)
  }, [trainerConn])

  const onTrainerSample = useCallback((s: TrainerSample) => {
    const t = Date.now()
    setLive((prev) => ({
      ftmsPower: s.source === 'ftms' && s.powerW !== undefined ? s.powerW : prev.ftmsPower,
      cpsPower: s.source === 'cps' && s.powerW !== undefined ? s.powerW : prev.cpsPower,
      cadence: s.cadenceRpm !== undefined ? s.cadenceRpm : prev.cadence,
      speed: s.speedKph !== undefined ? s.speedKph : prev.speed,
    }))
    if (s.cadenceRpm !== undefined) setSawCadence(true)
    if (s.powerW === undefined) return
    setSawPower(true)
    // Prefer the trainer's own FTMS power; fall back to the power service when FTMS sends none.
    if (s.source === 'ftms') lastFtmsPowerAt.current = t
    else if (t - lastFtmsPowerAt.current < 3000) return
    const point: ChartPoint = { t, powerW: s.powerW, targetW: targetRef.current }
    powerRef.current.push(point)
    if (powerRef.current.length > 4000) powerRef.current.splice(0, 1000)
  }, [])

  const resetTrainerState = useCallback(() => {
    trainerRef.current = null
    setTrainerConn('idle')
    setLive(emptyLive)
    setTargetW(null)
    targetRef.current = null
    hasControlRef.current = false
    abortRef.current = true
  }, [])

  const connectTrainer = async (acceptAll: boolean) => {
    if (!bluetooth) return
    setTrainerError(null)
    setTrainerConn('connecting')
    try {
      const device = await requestTrainerDevice(bluetooth, acceptAll)
      const trainer = await Trainer.open(device, {
        onSample: onTrainerSample,
        onStatus: () => undefined,
        onDisconnect: () => {
          resetTrainerState()
          setTrainerError('The trainer disconnected.')
        },
        log: (m) => addLog(`[trainer] ${m}`),
      })
      trainerRef.current = trainer
      setTrainerInfo({ ...trainer.info })
      setSawPower(false)
      setSawCadence(false)
      setControl('pending')
      hasControlRef.current = false
      setTargetAccepted('pending')
      powerRef.current = []
      setTrainerConn('connected')
    } catch (e) {
      addLog(`[trainer] Connect failed: ${String(e)}`)
      setTrainerError(errorText(e))
      setTrainerConn('idle')
    }
  }

  const disconnectTrainer = () => {
    trainerRef.current?.disconnect()
    resetTrainerState()
  }

  /** Request control and start, the handshake FTMS wants before any target. */
  const takeControl = async (): Promise<boolean> => {
    const trainer = trainerRef.current
    if (!trainer) return false
    const granted = await trainer.requestControl()
    if (!granted.ok) {
      setControl('fail')
      return false
    }
    // Some trainers answer "operation failed" to start when already started; that is harmless.
    await trainer.start()
    hasControlRef.current = true
    setControl('pass')
    return true
  }

  const applyTarget = async (watts: number): Promise<boolean> => {
    const trainer = trainerRef.current
    if (!trainer) return false
    if (!hasControlRef.current && !(await takeControl())) return false
    const r = await trainer.setTargetPower(watts)
    setTargetAccepted(r.ok ? 'pass' : 'fail')
    if (r.ok) {
      setTargetW(watts)
      targetRef.current = watts
    }
    return r.ok
  }

  const releaseControl = async () => {
    await trainerRef.current?.reset()
    setTargetW(null)
    targetRef.current = null
    hasControlRef.current = false
    setControl('pending')
  }

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
      const accepted = await applyTarget(target)
      if (!accepted) {
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
      const result = evaluateErgStep(powerRef.current, target, start, Date.now())
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

  const connectHr = async () => {
    if (!bluetooth) return
    setHrError(null)
    setHrConn('connecting')
    try {
      const device = await requestHeartRateDevice(bluetooth)
      const hrm = await HeartRateMonitor.open(device, {
        onSample: setHr,
        onDisconnect: () => {
          hrmRef.current = null
          setHrConn('idle')
          setHr(null)
          setHrError('The heart rate monitor disconnected.')
        },
        log: (m) => addLog(`[hr] ${m}`),
      })
      hrmRef.current = hrm
      setHrName(hrm.name)
      setHrBattery(hrm.batteryPercent)
      setHrConn('connected')
    } catch (e) {
      addLog(`[hr] Connect failed: ${String(e)}`)
      setHrError(errorText(e))
      setHrConn('idle')
    }
  }

  const disconnectHr = () => {
    hrmRef.current?.disconnect()
    hrmRef.current = null
    setHrConn('idle')
    setHr(null)
  }

  const hasFtms = trainerInfo?.services.includes(SERVICE.FTMS) ?? false
  const ergCheck: Check =
    erg.state === 'done' && erg.results.length === 3 ? (erg.results.every((r) => r.pass) ? 'pass' : 'fail') : 'pending'
  const checks: { label: string; state: Check; detail?: string }[] = [
    { label: 'Browser supports Web Bluetooth', state: bluetooth ? 'pass' : 'fail' },
    { label: 'Trainer connected', state: trainerInfo ? 'pass' : 'pending', detail: trainerInfo?.name },
    {
      label: 'Trainer speaks the standard control protocol (FTMS)',
      state: trainerInfo ? (hasFtms ? 'pass' : 'fail') : 'pending',
    },
    { label: 'Power readings arrive', state: sawPower ? 'pass' : 'pending' },
    { label: 'Cadence readings arrive', state: sawCadence ? 'pass' : 'pending' },
    { label: 'Trainer grants control', state: control },
    { label: 'Trainer accepts a target power', state: targetAccepted },
    { label: 'ERG mode holds the target (automatic test)', state: ergCheck },
    { label: 'Heart rate monitor connected', state: hrName ? 'pass' : 'pending', detail: hrName ?? undefined },
    { label: 'Heart rate readings arrive', state: hr ? 'pass' : 'pending' },
  ]

  const buildReport = (): string => {
    const f = trainerInfo?.features
    const lines = [
      'Indoor Trainer hardware check',
      `Date: ${new Date().toISOString()}`,
      `Browser: ${navigator.userAgent}`,
      SIM ? 'Mode: SIMULATED devices' : 'Mode: real devices',
      '',
      'Checklist:',
      ...checks.map((c) => `  [${c.state}] ${c.label}${c.detail ? ` (${c.detail})` : ''}`),
      '',
      'Trainer:',
      trainerInfo
        ? [
            `  name: ${trainerInfo.name}`,
            `  manufacturer/model: ${trainerInfo.manufacturer ?? '?'} / ${trainerInfo.model ?? '?'}`,
            `  firmware/hardware: ${trainerInfo.firmware ?? '?'} / ${trainerInfo.hardware ?? '?'}`,
            `  services: ${trainerInfo.services.map((s) => SERVICE_LABEL[s] ?? s).join(', ') || 'none'}`,
            `  control point: ${trainerInfo.hasControlPoint}`,
            f
              ? `  features: machine 0x${f.machineBits.toString(16)}, targets 0x${f.targetBits.toString(16)} (power target ${f.powerTarget}, cadence ${f.cadence}, simulation ${f.simulation})`
              : '  features: not read',
            trainerInfo.powerRange
              ? `  power range: ${trainerInfo.powerRange.minW}-${trainerInfo.powerRange.maxW} W, step ${trainerInfo.powerRange.stepW} W`
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
      `Heart rate monitor: ${hrName ?? 'not connected'}${hrBattery !== null ? `, battery ${hrBattery} %` : ''}${hr ? `, last ${hr.bpm} bpm, RR intervals ${hr.rrMs.length > 0}` : ''}`,
      '',
      'Log:',
      ...log,
    ]
    return lines.join('\n')
  }

  const copyReport = async () => {
    const text = buildReport()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      addLog('[page] Clipboard blocked: select the report text below manually')
    }
  }

  const power = live.ftmsPower ?? live.cpsPower
  const connected = trainerConn === 'connected'
  const testing = erg.state === 'running'

  return (
    <main className="mx-auto max-w-5xl space-y-5 p-5 pb-16">
      <header>
        <h1 className="text-2xl font-semibold">Indoor Trainer: hardware check</h1>
        <p className="mt-1 max-w-3xl text-sm text-stone-600 dark:text-stone-400">
          Checks that this browser can read and control your trainer and read your heart rate strap. Work through the
          steps, then copy the report.
        </p>
        {SIM && (
          <p className="mt-2 inline-block rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
            Simulated devices: no real Bluetooth is used.
          </p>
        )}
      </header>

      {!bluetooth && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          This browser has no Web Bluetooth. Open this page in Google Chrome on your Mac.
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
            {connected ? (
              <Button onClick={disconnectTrainer} kind="quiet">
                Disconnect
              </Button>
            ) : (
              <>
                <Button onClick={() => connectTrainer(false)} disabled={!bluetooth || trainerConn === 'connecting'}>
                  {trainerConn === 'connecting' ? 'Connecting…' : 'Connect trainer'}
                </Button>
                <Button
                  onClick={() => connectTrainer(true)}
                  disabled={!bluetooth || trainerConn === 'connecting'}
                  kind="quiet"
                >
                  Not listed? Show all devices
                </Button>
              </>
            )}
          </div>
          {trainerError && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{trainerError}</p>}
          {connected && trainerInfo && (
            <>
              <p className="mt-3 text-sm" data-testid="trainer-name">
                <span className="font-medium">{trainerInfo.name}</span>
                {trainerInfo.firmware && <span className="text-stone-500"> · firmware {trainerInfo.firmware}</span>}
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Stat label="Power" value={power} unit="W" testId="power" />
                <Stat label="Cadence" value={live.cadence} unit="rpm" testId="cadence" />
                <Stat label="Speed" value={live.speed} unit="km/h" digits={1} />
              </div>
              <p className="mt-2 text-xs text-stone-500">
                Power by source: trainer protocol {live.ftmsPower ?? 'none'} W, power service {live.cpsPower ?? 'none'}{' '}
                W
              </p>
            </>
          )}
        </Card>

        <Card title="2. Heart rate strap">
          <div className="flex flex-wrap items-center gap-2">
            {hrConn === 'connected' ? (
              <Button onClick={disconnectHr} kind="quiet">
                Disconnect
              </Button>
            ) : (
              <Button onClick={connectHr} disabled={!bluetooth || hrConn === 'connecting'}>
                {hrConn === 'connecting' ? 'Connecting…' : 'Connect heart rate strap'}
              </Button>
            )}
          </div>
          {hrError && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{hrError}</p>}
          {hrConn === 'connected' && (
            <>
              <p className="mt-3 text-sm">
                <span className="font-medium">{hrName}</span>
                {hrBattery !== null && <span className="text-stone-500"> · battery {hrBattery} %</span>}
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Stat label="Heart rate" value={hr?.bpm ?? null} unit="bpm" testId="hr" />
              </div>
              {hr?.contact === false && (
                <p className="mt-2 text-xs text-amber-700">The strap reports no skin contact.</p>
              )}
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
                <Button key={w} onClick={() => applyTarget(w)} disabled={testing} kind="quiet">
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
              <Button onClick={() => applyTarget(Number(targetInput))} disabled={testing || !(Number(targetInput) > 0)}>
                Set target
              </Button>
              <Button onClick={releaseControl} disabled={testing} kind="quiet">
                Release control
              </Button>
              <span className="text-sm text-stone-600 dark:text-stone-400" data-testid="target">
                Target: {targetW === null ? 'none' : `${targetW} W`}
              </span>
            </div>
            <div className="mt-3">
              <PowerChart points={chart} now={now} />
              <p className="text-xs text-stone-500">
                Solid line: measured power. Dashed line: target. Last 90 seconds.
              </p>
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
                  <Button onClick={runErgTest}>Run ERG test</Button>
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
          <Button onClick={copyReport}>{copied ? 'Copied' : 'Copy report'}</Button>
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
    </main>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Button({
  children,
  onClick,
  disabled,
  kind = 'primary',
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  kind?: 'primary' | 'quiet'
}) {
  const style =
    kind === 'primary'
      ? 'bg-teal-700 text-white hover:bg-teal-800'
      : 'border border-stone-300 bg-white text-stone-800 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${style}`}
    >
      {children}
    </button>
  )
}

function Stat({
  label,
  value,
  unit,
  digits = 0,
  testId,
}: {
  label: string
  value: number | null
  unit: string
  digits?: number
  testId?: string
}) {
  return (
    <div className="rounded-lg bg-stone-100 p-3 dark:bg-stone-800">
      <div className="text-xs text-stone-500">{label}</div>
      <div className="text-2xl font-semibold tabular-nums" data-testid={testId}>
        {value === null ? '–' : value.toFixed(digits)}
        <span className="ml-1 text-xs font-normal text-stone-500">{unit}</span>
      </div>
    </div>
  )
}
