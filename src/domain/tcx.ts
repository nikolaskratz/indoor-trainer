// Writes a ride as a TCX file, the format Strava accepts for uploads with power.
// One lap per workout step, so intervals show up as laps.

import type { RideSample } from './ride.ts'
import type { Segment } from './workout.ts'

export interface TcxInput {
  name: string
  notes: string
  startTs: number
  samples: RideSample[]
  segments: Segment[]
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const iso = (ts: number): string => new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z')

function trackpoint(s: RideSample): string {
  const parts = [`<Time>${iso(s.ts)}</Time>`, `<DistanceMeters>${s.distanceM.toFixed(1)}</DistanceMeters>`]
  if (s.hrBpm !== null) parts.push(`<HeartRateBpm><Value>${s.hrBpm}</Value></HeartRateBpm>`)
  if (s.cadenceRpm !== null) parts.push(`<Cadence>${Math.min(254, s.cadenceRpm)}</Cadence>`)
  const ext = [`<ns3:Speed>${(s.speedKph / 3.6).toFixed(2)}</ns3:Speed>`]
  if (s.powerW !== null) ext.push(`<ns3:Watts>${Math.max(0, s.powerW)}</ns3:Watts>`)
  parts.push(`<Extensions><ns3:TPX>${ext.join('')}</ns3:TPX></Extensions>`)
  return `<Trackpoint>${parts.join('')}</Trackpoint>`
}

function lap(samples: RideSample[], distanceBefore: number, segment: Segment | undefined): string {
  const power = samples.map((s) => s.powerW).filter((p): p is number => p !== null)
  const hr = samples.map((s) => s.hrBpm).filter((h): h is number => h !== null)
  const cadence = samples.map((s) => s.cadenceRpm).filter((c): c is number => c !== null && c > 0)
  const avg = (v: number[]) => Math.round(v.reduce((a, b) => a + b, 0) / v.length)
  const kJ = power.reduce((a, b) => a + b, 0) / 1000
  const distance = samples[samples.length - 1].distanceM - distanceBefore
  const maxSpeed = Math.max(...samples.map((s) => s.speedKph)) / 3.6
  const parts = [
    `<TotalTimeSeconds>${samples.length}</TotalTimeSeconds>`,
    `<DistanceMeters>${distance.toFixed(1)}</DistanceMeters>`,
    `<MaximumSpeed>${maxSpeed.toFixed(2)}</MaximumSpeed>`,
    // Work in kJ is close to kcal burned at typical cycling efficiency.
    `<Calories>${Math.round(kJ)}</Calories>`,
  ]
  if (hr.length) {
    parts.push(`<AverageHeartRateBpm><Value>${avg(hr)}</Value></AverageHeartRateBpm>`)
    parts.push(`<MaximumHeartRateBpm><Value>${Math.max(...hr)}</Value></MaximumHeartRateBpm>`)
  }
  parts.push(`<Intensity>${segment?.kind === 'recovery' ? 'Resting' : 'Active'}</Intensity>`)
  if (cadence.length) parts.push(`<Cadence>${Math.min(254, avg(cadence))}</Cadence>`)
  parts.push('<TriggerMethod>Manual</TriggerMethod>')
  parts.push(`<Track>${samples.map(trackpoint).join('')}</Track>`)
  if (segment) parts.push(`<Notes>${esc(segment.rep ? `${segment.label} ${segment.rep}` : segment.label)}</Notes>`)
  if (power.length) {
    parts.push(`<Extensions><ns3:LX><ns3:AvgWatts>${avg(power)}</ns3:AvgWatts></ns3:LX></Extensions>`)
  }
  return `<Lap StartTime="${iso(samples[0].ts)}">${parts.join('')}</Lap>`
}

export function buildTcx(input: TcxInput): string {
  const { samples } = input
  if (samples.length === 0) throw new Error('The ride has no recorded data.')
  // Group consecutive samples of the same workout step into laps.
  const laps: string[] = []
  let from = 0
  let distanceBefore = 0
  for (let i = 1; i <= samples.length; i++) {
    if (i === samples.length || samples[i].segment !== samples[from].segment) {
      const group = samples.slice(from, i)
      laps.push(lap(group, distanceBefore, input.segments[group[0].segment]))
      distanceBefore = group[group.length - 1].distanceM
      from = i
    }
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"' +
      ' xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '<Activities>',
    '<Activity Sport="Biking">',
    `<Id>${iso(input.startTs)}</Id>`,
    ...laps,
    `<Notes>${esc(input.notes)}</Notes>`,
    `<Training VirtualPartner="false"><Plan Type="Workout" IntervalWorkout="true"><Name>${esc(input.name.slice(0, 15))}</Name></Plan></Training>`,
    '<Creator xsi:type="Device_t"><Name>Indoor Trainer</Name><UnitId>0</UnitId><ProductID>0</ProductID>' +
      '<Version><VersionMajor>0</VersionMajor><VersionMinor>1</VersionMinor></Version></Creator>',
    '</Activity>',
    '</Activities>',
    '</TrainingCenterDatabase>',
  ].join('\n')
}

export function rideFileName(name: string, startTs: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ride'
  return `${new Date(startTs).toISOString().slice(0, 10)}-${slug}.tcx`
}
