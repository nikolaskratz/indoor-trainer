import type { ReactNode } from 'react'

export function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

const BUTTON_STYLE = {
  primary: 'bg-teal-700 text-white hover:bg-teal-800',
  quiet:
    'border border-stone-300 bg-white text-stone-800 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800',
  danger: 'bg-red-700 text-white hover:bg-red-800',
}

export function Button({
  children,
  onClick,
  disabled,
  kind = 'primary',
  size = 'md',
  title,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  kind?: keyof typeof BUTTON_STYLE
  size?: 'md' | 'lg'
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        size === 'lg' ? 'px-5 py-3 text-base' : 'px-3 py-1.5 text-sm'
      } ${BUTTON_STYLE[kind]}`}
    >
      {children}
    </button>
  )
}

export function Stat({
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

export function StatusDot({ status }: { status: 'idle' | 'connecting' | 'connected' | 'reconnecting' }) {
  const color =
    status === 'connected'
      ? 'bg-teal-500'
      : status === 'idle'
        ? 'bg-stone-400'
        : 'animate-pulse bg-amber-500'
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} aria-hidden="true" />
}
