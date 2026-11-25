// The Claude call behind turbo-workout, kept separate so it can be tried locally.

import Anthropic from 'npm:@anthropic-ai/sdk@1.1.0'
import { betaZodOutputFormat } from 'npm:@anthropic-ai/sdk@1.1.0/helpers/beta/zod'
import * as z from 'npm:zod@4.6.7/v4'
import { describeBase, type BaseWorkout, type OutBlock, type OutStep } from './base.ts'

export { Anthropic }

const MODEL = 'claude-opus-5-5'
const MAX_TOKENS = 8000

export type Profile = {
  ftp: number
  weightKg: number | null
  maxHr: number | null
  thresholdHr: number | null
}

// Two fixed levels of repetition instead of a recursive schema: a workout is a list of
// blocks, a block repeats a list of groups, a group repeats a list of steps. That covers
// "3 x (10 x 30/30 + set recovery)" and keeps the output schema simple.
const Step = z.object({
  kind: z.enum(['warmup', 'work', 'recovery', 'steady', 'cooldown']),
  duration_s: z.number().int().describe('Length of the step in seconds'),
  power_pct: z.number().describe('Target at the start of the step, in percent of FTP (e.g. 65)'),
  power_end_pct: z
    .number()
    .nullable()
    .describe('Only for ramps: target at the end of the step in percent of FTP. null for a constant target'),
  label: z.string().describe('Two or three words shown to the rider, e.g. "VO2 max", "Easy spin"'),
  cadence_rpm: z.number().int().nullable().describe('Suggested cadence, or null when it does not matter'),
})

const Group = z.object({
  repeat: z.number().int().describe('How many times these steps run in a row; 1 for no repetition'),
  steps: z.array(Step),
})

const Block = z.object({
  repeat: z.number().int().describe('How many times this whole block runs; 1 for no repetition'),
  groups: z.array(Group),
})

const Result = z.object({
  name: z.string().describe('Short title, e.g. "VO2 max 3 x 10 x 30/30"'),
  description: z
    .string()
    .describe('One or two sentences: what the session is and any assumption you made where the request was open'),
  blocks: z.array(Block),
})

const SYSTEM = `You design structured indoor cycling workouts for one rider. The workout runs on a smart \
trainer in ERG mode: the trainer holds the target power of each step, whatever cadence or gear the \
rider uses. An app turns your output into the session, so the structure has to be exact.

Targets are percentages of the rider's FTP. Use the usual zones: recovery under 55, endurance 56 to 75, \
tempo 76 to 90, threshold and sweet spot 88 to 105, VO2 max 106 to 120, anaerobic 121 to 150. When the \
request names a zone or a kind of session, pick targets inside that range rather than at its edge, \
unless the rider asks for a specific number.

How to read requests:
- A stated total duration is the length of the whole session, warm-up and cool-down included. Make the \
steps add up to it exactly.
- Interval shorthand reads outside in: "3x10x 30/30" is 3 sets of 10 repetitions of 30 seconds hard and \
30 seconds easy. Put a few minutes of easy riding between sets. "4x8 min" is four 8-minute efforts with \
recoveries in between.
- When no duration is given for an interval session, add a warm-up of about 10 minutes and a cool-down \
of about 5 around the main set. Before hard efforts (VO2 max and above) include two or three short \
openers at the end of the warm-up.
- "With some variations" on an easy ride means small changes inside the same zone every few minutes \
(a few percent of FTP, a cadence change), not hard efforts.
- Keep an easy session easy. Do not add intensity the rider did not ask for.
- If the request leaves something open, choose what a sensible coach would and say so in the description.

How to build the structure:
- Warm-ups and cool-downs are ramps: set power_pct and power_end_pct. Every other step has a constant \
target with power_end_pct null.
- Recoveries between hard efforts sit at 45 to 55 percent.
- Use repeat counts instead of writing the same steps out several times.
- Steps last at least 10 seconds. The trainer needs a few seconds to change resistance, so avoid \
efforts shorter than 15 seconds unless the rider asks for sprints.
- Labels are two or three plain words. Give a cadence only where it is part of the point of the step.

Changing an existing workout:
When the message contains a current workout and a change request, return the whole workout with that \
change applied.
- Change only what the request is about. Every other step keeps its duration, target, label, cadence \
and place in the order, exactly as given.
- Do not make up for the change elsewhere. A shorter warm-up makes the session shorter. Keep the total \
length only when the rider asks for it, and then take or add the time in the main part of the session.
- When the request is relative ("shorter", "a bit harder", "more recovery"), make a clear but moderate \
change: about a third more or less time, or about 5 percent of FTP. Keep durations at round values.
- The rules above still apply to the parts you change: a shortened warm-up is still a ramp, and it \
keeps its openers unless the request removes them.
- If the request can be read in more than one way, choose the most sensible reading.
- Keep the name unless it no longer fits, for example because it states a length that changed.
- The description describes the session as it now is, in one or two sentences, and says what you changed.`

function prompt(request: string, p: Profile, base?: BaseWorkout): string {
  const facts = [
    `FTP: ${Math.round(p.ftp)} W`,
    p.weightKg && `Weight: ${p.weightKg} kg`,
    p.thresholdHr && `Threshold heart rate: ${p.thresholdHr} bpm`,
    p.maxHr && `Max heart rate: ${p.maxHr} bpm`,
  ].filter(Boolean)
  const rider = `Rider:\n${facts.join('\n')}`
  if (!base) return `${rider}\n\nRequest:\n${request}`
  return `${rider}\n\n${describeBase(base)}\n\nChange requested:\n${request}`
}

/** Converts the model's two-level structure into the app's nested blocks; null with a reason if unusable. */
function toBlocks(result: z.infer<typeof Result>): { blocks: OutBlock[] } | { problem: string } {
  const out: OutBlock[] = []
  let total = 0
  let count = 0
  for (const block of result.blocks) {
    const groups: OutBlock[] = []
    let blockSeconds = 0
    let blockSteps = 0
    for (const group of block.groups) {
      const steps: OutStep[] = []
      for (const s of group.steps) {
        const power = s.power_pct / 100
        const powerEnd = s.power_end_pct === null ? undefined : s.power_end_pct / 100
        for (const p of [power, powerEnd ?? power]) {
          if (!(p >= 0.3 && p <= 2.5)) return { problem: 'The generated workout had a target outside 30 to 250 % of FTP.' }
        }
        if (!(s.duration_s >= 5)) return { problem: 'The generated workout had a step shorter than 5 seconds.' }
        steps.push({
          type: 'step',
          kind: s.kind,
          durationS: Math.round(s.duration_s),
          power,
          ...(powerEnd !== undefined && powerEnd !== power ? { powerEnd } : {}),
          ...(s.label.trim() ? { label: s.label.trim().slice(0, 40) } : {}),
          ...(s.cadence_rpm && s.cadence_rpm >= 40 && s.cadence_rpm <= 140 ? { cadence: s.cadence_rpm } : {}),
        })
      }
      if (steps.length === 0) continue
      if (!(group.repeat >= 1 && group.repeat <= 60)) return { problem: 'The generated workout had an unusable repeat count.' }
      const seconds = steps.reduce((a, s) => a + s.durationS, 0)
      blockSeconds += seconds * group.repeat
      blockSteps += steps.length * group.repeat
      if (group.repeat === 1) groups.push(...steps)
      else groups.push({ type: 'repeat', count: group.repeat, blocks: steps })
    }
    if (groups.length === 0) continue
    if (!(block.repeat >= 1 && block.repeat <= 60)) return { problem: 'The generated workout had an unusable repeat count.' }
    total += blockSeconds * block.repeat
    count += blockSteps * block.repeat
    if (block.repeat === 1) out.push(...groups)
    else out.push({ type: 'repeat', count: block.repeat, blocks: groups })
  }
  if (out.length === 0) return { problem: 'The generated workout had no steps.' }
  if (total > 6 * 3600) return { problem: 'The generated workout was longer than 6 hours.' }
  if (count > 400) return { problem: 'The generated workout had too many steps.' }
  return { blocks: out }
}

/**
 * Builds a workout from a description, or, when `base` is given, applies a change request to it.
 * `workout` is null when Claude gave no usable answer; `problem` then says why in plain words.
 */
export async function generateWorkout(apiKey: string, request: string, profile: Profile, base?: BaseWorkout) {
  const client = new Anthropic({ apiKey })
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: betaZodOutputFormat(Result) },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt(request, profile, base) }],
  })
  const spent = { model: response.model, usage: response.usage }
  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    console.error('turbo-workout: no result', response.stop_reason, response.stop_details?.category)
    return { workout: null, problem: null, ...spent }
  }
  const result = response.parsed_output
  const converted = toBlocks(result)
  if ('problem' in converted) return { workout: null, problem: converted.problem, ...spent }
  return {
    workout: {
      name: result.name.trim().slice(0, 80) || 'Workout',
      description: result.description.trim().slice(0, 400),
      blocks: converted.blocks,
    },
    problem: null,
    ...spent,
  }
}
