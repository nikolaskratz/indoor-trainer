// End-to-end check of a whole ride against the simulated trainer and strap:
// profile, connect, start, pause, intensity, auto-pause, trainer drop, reload and
// resume, finish, summary, ride file, history. The ride clock runs 20 times faster.
import { readFile } from 'node:fs/promises'
import { check, withApp } from './lib.mjs'

const shots = process.env.SHOTS ?? 'e2e'

await withApp(4180, async ({ page, base }) => {
  const url = (route) => `${base}?sim=1&speed=20#/${route}`
  const status = page.getByTestId('ride-status')
  page.on('dialog', (d) => d.accept())

  await page.goto(url(''))
  await page.getByText('Enter your FTP and weight first').waitFor()
  await page.getByRole('button', { name: 'Open profile' }).click()
  await page.getByLabel('FTP').fill('250')
  await page.getByLabel('Weight').fill('75')
  await page.getByLabel('Max heart rate').fill('185')
  await page.getByLabel('Threshold heart rate').fill('165')
  await page.getByText('139 to 188 W').waitFor()

  await page.getByRole('link', { name: 'Workouts' }).click()
  await page.getByRole('button', { name: 'Connect trainer' }).click()
  await page.getByTestId('dev-power').getByText(/\d+ W/).waitFor()
  await page.getByRole('button', { name: 'Connect heart rate' }).click()
  await page.getByTestId('dev-hr').getByText(/\d+ bpm/).waitFor()
  await page.screenshot({ path: `${shots}/home.png`, fullPage: true })

  await page.getByRole('link', { name: /Quick check/ }).click()
  await page.getByText('8:00').first().waitFor()
  await page.screenshot({ path: `${shots}/workout.png`, fullPage: true })
  await page.getByRole('button', { name: 'Start this workout' }).click()
  await status.getByText('Ready').waitFor()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await status.getByText('Riding').waitFor()
  await page.getByText(/Target \d+ W/).waitFor()

  // Manual pause and resume
  await page.getByRole('button', { name: 'Pause' }).click()
  await status.getByText('Paused').waitFor()
  const frozen = await page.getByTestId('ride-elapsed').textContent()
  await page.waitForTimeout(600)
  check((await page.getByTestId('ride-elapsed').textContent()) === frozen, 'the clock kept running while paused')
  await page.getByRole('button', { name: 'Resume' }).click()
  await status.getByText('Riding').waitFor()

  // Intensity
  await page.getByRole('button', { name: '+ 5 %' }).click()
  await page.getByTestId('ride-intensity').getByText('105 %').waitFor()
  await page.getByRole('button', { name: '− 5 %' }).click()
  await page.getByTestId('ride-intensity').getByText('100 %').waitFor()

  // The rider stops pedalling: the ride pauses by itself and continues afterwards
  await page.evaluate(() => window.__sim.setPedalling(false))
  await status.getByText('Paused: start pedalling').waitFor({ timeout: 20000 })
  await page.evaluate(() => window.__sim.setPedalling(true))
  await status.getByText('Riding').waitFor({ timeout: 20000 })

  // The trainer drops off: the app reconnects and sets the target again
  await page.evaluate(() => window.__sim.dropTrainer())
  await page.getByText('Trainer reconnecting…').waitFor()
  await page.getByText('Sim Trainer 0001').waitFor({ timeout: 10000 })
  await page.screenshot({ path: `${shots}/ride.png`, fullPage: true })

  // Reload mid-ride (after the periodic save), then resume
  await page.waitForTimeout(11000)
  const before = await page.getByTestId('ride-elapsed').textContent()
  await page.reload()
  await page.goto(url(''))
  await page.getByText('Unfinished ride:').waitFor()
  await page.getByRole('button', { name: 'Resume' }).click()
  await status.getByText('Paused').waitFor()
  const restored = await page.getByTestId('ride-elapsed').textContent()
  console.log(`elapsed before reload ${before}, restored ${restored}`)
  check(restored !== '0:00', 'the reload lost the ride')
  // Devices are gone after a reload: connect again, then continue
  await page.getByRole('link', { name: 'Workouts' }).click()
  await page.getByRole('button', { name: 'Connect trainer' }).click()
  await page.getByRole('button', { name: 'Connect heart rate' }).click()
  await page.getByRole('button', { name: 'Back to the ride' }).click()
  await page.getByRole('button', { name: 'Resume' }).click()
  await status.getByText('Riding').waitFor()
  await page.getByRole('button', { name: 'Skip step' }).click()

  // The workout runs to its end and the summary opens by itself
  await page.getByTestId('summary-title').waitFor({ timeout: 60000 })
  const stats = await page.getByTestId('summary-stats').textContent()
  console.log(stats)
  check(/Distance\s*\d+\.\d\d km/.test(stats), 'summary has no distance')
  check(/Average power\s*\d+ W/.test(stats), 'summary has no average power')
  check(/Average heart rate\s*\d+ bpm/.test(stats), 'summary has no heart rate')
  await page.screenshot({ path: `${shots}/summary.png`, fullPage: true })

  // The ride file is well-formed and complete
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download ride file (TCX)' }).click(),
  ])
  const fileName = download.suggestedFilename()
  check(/^\d{4}-\d\d-\d\d-quick-check-8-min\.tcx$/.test(fileName), `unexpected file name ${fileName}`)
  const tcx = await readFile(await download.path(), 'utf8')
  const parsed = await page.evaluate((xml) => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const points = [...doc.querySelectorAll('Trackpoint')]
    const times = points.map((p) => Date.parse(p.querySelector('Time').textContent))
    return {
      error: doc.querySelector('parsererror')?.textContent ?? null,
      laps: doc.querySelectorAll('Lap').length,
      points: points.length,
      withPower: points.filter((p) => p.getElementsByTagName('ns3:Watts').length).length,
      withHr: points.filter((p) => p.querySelector('HeartRateBpm')).length,
      increasing: times.every((t, i) => i === 0 || t > times[i - 1]),
      lastDistance: Number(points.at(-1).querySelector('DistanceMeters').textContent),
    }
  }, tcx)
  console.log(JSON.stringify(parsed))
  check(parsed.error === null, `ride file is not valid XML: ${parsed.error}`)
  check(parsed.points > 100, 'ride file has too few trackpoints')
  check(parsed.laps >= 5, 'ride file has too few laps')
  check(parsed.withPower > parsed.points * 0.8, 'most trackpoints should carry power')
  check(parsed.withHr > parsed.points * 0.5, 'most trackpoints should carry heart rate')
  check(parsed.increasing, 'trackpoint times are not strictly increasing')
  check(parsed.lastDistance > 500, 'ride file has no distance')

  await page.getByRole('link', { name: 'Rides', exact: true }).click()
  await page.getByRole('link', { name: /Quick check/ }).waitFor()
  check((await page.getByRole('row').count()) === 2, 'history should list exactly one ride')
})
