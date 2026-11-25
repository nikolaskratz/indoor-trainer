// The workout a change request starts from: checks what the app sent and writes it
// out for Claude. No imports, so it can be unit-tested outside Deno.

export type Kind = 'warmup' | 'work' | 'recovery' | 'steady' | 'cooldown'

export type OutStep = {
  type: 'step'
  kind: Kind
  durationS: number
  power: number
  powerEnd?: number
  label?: string
  cadence?: number
}
export type OutBlock = OutStep | { type: 'repeat'; count: number; blocks: OutBlock[] }

export type BaseWorkout = {
  name: string
  description: string
  blocks: OutBlock[]
  /** The description the workout was first created from, if any. */
  prompt: string | null
  /** Change requests already applied, oldest first. */
  changes: string[]
}

const KINDS: readonly string[] = ['warmup', 'work', 'recovery', 'steady', 'cooldown']
const MAX_NODES = 400
const MAX_DEPTH = 3
const MAX_CHANGES = 10

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const within = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

/** The workout as sent by the app, reduced to what is known and valid; null if it is not a usable workout. */
export function readBase(raw: unknown): BaseWorkout | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  let nodes = 0
  const readBlocks = (list: unknown, depth: number): OutBlock[] | null => {
    if (!Array.isArray(list) || list.length === 0 || depth > MAX_DEPTH) return null
    const out: OutBlock[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object' || ++nodes > MAX_NODES) return null
      const b = item as Record<string, unknown>
      if (b.type === 'repeat') {
        if (!within(b.count, 1, 60) || !Number.isInteger(b.count)) return null
        const blocks = readBlocks(b.blocks, depth + 1)
        if (!blocks) return null
        out.push({ type: 'repeat', count: b.count, blocks })
        continue
      }
      if (b.type !== 'step' || typeof b.kind !== 'string' || !KINDS.includes(b.kind)) return null
      if (!within(b.durationS, 5, 6 * 3600) || !within(b.power, 0.3, 2.5)) return null
      const ramp = b.powerEnd !== undefined && b.powerEnd !== null
      if (ramp && !within(b.powerEnd, 0.3, 2.5)) return null
      const label = text(b.label, 40)
      out.push({
        type: 'step',
        kind: b.kind as Kind,
        durationS: Math.round(b.durationS),
        power: b.power,
        ...(ramp && b.powerEnd !== b.power ? { powerEnd: b.powerEnd as number } : {}),
        ...(label ? { label } : {}),
        ...(within(b.cadence, 40, 140) ? { cadence: Math.round(b.cadence) } : {}),
      })
    }
    return out
  }
  const blocks = readBlocks(w.blocks, 0)
  if (!blocks) return null
  return {
    name: text(w.name, 80) || 'Workout',
    description: text(w.description, 400),
    blocks,
    prompt: text(w.prompt, 1500) || null,
    changes: (Array.isArray(w.changes) ? w.changes : [])
      .map((c) => text(c, 1500))
      .filter(Boolean)
      .slice(-MAX_CHANGES),
  }
}

export function totalSeconds(blocks: OutBlock[]): number {
  return blocks.reduce((sum, b) => sum + (b.type === 'repeat' ? b.count * totalSeconds(b.blocks) : b.durationS), 0)
}

/** Percent of FTP with at most one decimal: 0.675 -> 67.5 */
const pct = (fraction: number) => Math.round(fraction * 1000) / 10

/** The blocks in the field names Claude answers in, so input and output read alike. */
function forModel(blocks: OutBlock[]): unknown[] {
  return blocks.map((b) =>
    b.type === 'repeat'
      ? { repeat: b.count, steps: forModel(b.blocks) }
      : {
          kind: b.kind,
          duration_s: b.durationS,
          power_pct: pct(b.power),
          power_end_pct: b.powerEnd === undefined ? null : pct(b.powerEnd),
          label: b.label ?? null,
          cadence_rpm: b.cadence ?? null,
        },
  )
}

/** The current workout as the part of the message Claude reads before the change request. */
export function describeBase(base: BaseWorkout): string {
  const total = totalSeconds(base.blocks)
  const length = total % 60 === 0 ? `${total / 60} min` : `${Math.floor(total / 60)} min ${total % 60} s`
  return [
    'Current workout:',
    `Name: ${base.name}`,
    base.description && `Description: ${base.description}`,
    base.prompt && `First requested as: ${base.prompt}`,
    base.changes.length > 0 && `Changes already made:\n${base.changes.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    `Total length: ${length}`,
    'Steps in order, as JSON. Targets are percent of FTP. An entry with "repeat" runs its steps that many times in a row.',
    `[\n${forModel(base.blocks)
      .map((b) => JSON.stringify(b))
      .join(',\n')}\n]`,
  ]
    .filter(Boolean)
    .join('\n')
}
