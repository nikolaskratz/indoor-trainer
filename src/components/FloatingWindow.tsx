// A small always-on-top window with the ride's key numbers, for riding while
// something else fills the screen. Uses Chrome's Document Picture-in-Picture: the
// window belongs to this page, so it shows live data and its buttons work.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { RideSession } from '../domain/ride.ts'
import { formatDuration, powerAt } from '../domain/workout.ts'
import { hrZone, powerZone } from '../domain/zones.ts'
import { enableCues } from '../lib/activeRide.ts'

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
}
const api = (): DocumentPictureInPicture | undefined =>
  (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture

/** The floating window needs the app's styles: copy every stylesheet into it. */
function copyStyles(target: Document): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement('style')
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n')
      target.head.appendChild(style)
    } catch {
      // A stylesheet from another origin cannot be read: link to it instead.
      if (sheet.href) {
        const link = target.createElement('link')
        link.rel = 'stylesheet'
        link.href = sheet.href
        target.head.appendChild(link)
      }
    }
  }
}

export function useFloatingWindow(): {
  supported: boolean
  win: Window | null
  open: () => Promise<void>
  close: () => void
} {
  const [win, setWin] = useState<Window | null>(null)

  const open = useCallback(async () => {
    const pip = api()
    if (!pip) return
    try {
      const opened = await pip.requestWindow({ width: 380, height: 300 })
      copyStyles(opened.document)
      opened.document.title = 'Indoor Trainer'
      opened.document.body.style.margin = '0'
      opened.addEventListener('pagehide', () => setWin(null))
      setWin(opened)
    } catch {
      // The browser refused (for example no click preceded the call): stay as we are.
    }
  }, [])

  const close = useCallback(() => {
    win?.close()
    setWin(null)
  }, [win])

  // Leaving the ride page closes the window with it.
  useEffect(() => () => win?.close(), [win])

  return { supported: api() !== undefined, win, open, close }
}

const STATUS: Record<string, string> = {
  ready: 'Ready',
  paused: 'Paused',
  autopaused: 'Paused: pedal to continue',
  finished: 'Finished',
}

/** The contents of the floating window. Sizes follow the window, which the user can resize. */
function MiniRide({ session }: { session: RideSession }) {
  const view = useSyncExternalStore(session.subscribe, session.getView)
  const { ftp, maxHr, thresholdHr } = session.profile
  const segment = view.segment
  const running = view.status === 'running'
  const paused = view.status === 'paused' || view.status === 'autopaused'
  const power = view.status === 'ready' ? view.live.powerW : (view.power3s ?? view.live.powerW)
  const zone = segment ? powerZone(powerAt(segment, view.positionS) * view.intensity) : null
  const hrBpm = view.live.hrBpm
  const hz = hrBpm === null ? null : hrZone(hrBpm, thresholdHr, maxHr)
  const next = view.next
  const nextW = next ? Math.round(next.power * ftp * view.intensity) : null
  const stepDone = segment ? 1 - view.segmentRemainingS / segment.durationS : 0
  const allDone = view.totalS ? view.positionS / view.totalS : 0
  // The FTP test ends when the rider stops, not when the plan runs out.
  const openEnded = session.workout.test === 'ramp' && (segment?.index ?? 0) < session.segments.length - 1

  return (
    <div
      className="flex h-screen flex-col gap-2 bg-stone-100 p-3 text-stone-900 dark:bg-stone-950 dark:text-stone-100"
      data-testid="mini-ride"
    >
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-medium" data-testid="mini-step">
          {segment ? `${segment.label}${segment.rep ? ` ${segment.rep}` : ''}` : session.workout.name}
        </span>
        {!running && <span className="shrink-0 rounded-full bg-amber-200 px-2 py-0.5 text-amber-950">{STATUS[view.status]}</span>}
      </div>

      <div className="grid flex-1 grid-cols-2 gap-2">
        <div className="flex flex-col justify-center rounded-lg bg-white px-3 py-2 dark:bg-stone-900">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-stone-500">
            {zone && <span className="inline-block h-2 w-2 rounded-full" style={{ background: zone.color }} />}
            Power
          </div>
          <div className="font-semibold tabular-nums leading-none" style={{ fontSize: 'clamp(2rem, 17vw, 7rem)' }} data-testid="mini-power">
            {power === null ? '–' : Math.round(power)}
          </div>
          <div className="mt-1 truncate text-xs text-stone-600 dark:text-stone-400" data-testid="mini-target">
            {view.targetW === null ? 'No target' : `Target ${view.targetW} W${zone ? ` · Z${zone.zone}` : ''}`}
          </div>
        </div>
        <div className="flex flex-col justify-center rounded-lg bg-white px-3 py-2 dark:bg-stone-900">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">Step ends in</div>
          <div className="font-semibold tabular-nums leading-none" style={{ fontSize: 'clamp(2rem, 17vw, 7rem)' }} data-testid="mini-remaining">
            {formatDuration(view.segmentRemainingS)}
          </div>
          <div className="mt-1 truncate text-xs text-stone-600 dark:text-stone-400">
            {next ? `Next: ${next.label} ${formatDuration(next.durationS)} at ${nextW} W` : 'Last step'}
          </div>
        </div>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-stone-300 dark:bg-stone-800" title="This step">
        <div className="h-full bg-teal-600" style={{ width: `${Math.min(100, Math.max(0, stepDone * 100))}%` }} />
      </div>

      <div className="grid grid-cols-3 gap-2 text-center text-sm tabular-nums">
        <div className="rounded-lg bg-white px-2 py-1 dark:bg-stone-900">
          <div className="text-[10px] uppercase tracking-wide text-stone-500">Heart rate</div>
          <div className="flex items-center justify-center gap-1 font-semibold" data-testid="mini-hr">
            {hz && <span className="inline-block h-2 w-2 rounded-full" style={{ background: hz.color }} />}
            {hrBpm === null ? '–' : hrBpm}
          </div>
        </div>
        <div className="rounded-lg bg-white px-2 py-1 dark:bg-stone-900">
          <div className="text-[10px] uppercase tracking-wide text-stone-500">Cadence</div>
          <div className="font-semibold">{view.live.cadenceRpm === null ? '–' : Math.round(view.live.cadenceRpm)}</div>
        </div>
        <div className="rounded-lg bg-white px-2 py-1 dark:bg-stone-900">
          <div className="text-[10px] uppercase tracking-wide text-stone-500">Time left</div>
          <div className="font-semibold">{openEnded ? 'open' : formatDuration(view.totalS - view.positionS)}</div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-stone-300 dark:bg-stone-800" title="Whole workout">
          {!openEnded && <div className="h-full bg-stone-500" style={{ width: `${Math.min(100, allDone * 100)}%` }} />}
        </div>
        {(running || paused) && (
          <button
            type="button"
            onClick={() => {
              if (running) session.pause()
              else {
                enableCues()
                session.resume()
              }
            }}
            className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium dark:border-stone-700 dark:bg-stone-900"
          >
            {running ? 'Pause' : 'Resume'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Renders the ride into the floating window while it is open. */
export function FloatingRide({ win, session }: { win: Window | null; session: RideSession }) {
  return win ? createPortal(<MiniRide session={session} />, win.document.body) : null
}
