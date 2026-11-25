// End-to-end check of saving to the account, with the server replaced by an in-memory
// stand-in: one browser enters a profile, creates a workout and rides; a second, empty
// browser signs in and gets all of it; changes and deletions travel both ways.
import { check, emptyCloud, mockCloud, mockSignIn, until, withApp } from './lib.mjs'

const generated = {
  name: 'Mock tempo',
  description: 'Twenty minutes of tempo.',
  blocks: [
    { type: 'step', kind: 'warmup', durationS: 300, power: 0.5, powerEnd: 0.75 },
    { type: 'step', kind: 'steady', durationS: 1200, power: 0.8, label: 'Tempo' },
    { type: 'step', kind: 'cooldown', durationS: 300, power: 0.55, powerEnd: 0.4 },
  ],
}

await withApp(4183, async ({ page: a, base, otherBrowser, errors }) => {
  const db = emptyCloud()
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
  const setUp = async (page) => {
    await mockSignIn(page)
    await mockCloud(page, db)
    await page.route('**/functions/v1/turbo-strava', (route) =>
      route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers: cors })
        : route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ configured: false, connected: false }) }),
    )
    await page.route('**/functions/v1/turbo-workout', (route) =>
      route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers: cors })
        : route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ workout: generated }) }),
    )
  }
  const signIn = async (page) => {
    await page.getByLabel('Email').fill('rider@example.com')
    await page.getByLabel('Password').fill('secret')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByText('Sign out rider@example.com').waitFor()
  }
  const saved = (page) => page.getByTestId('sync-badge').getByText('Saved to your account').waitFor()
  const url = (route) => `${base}?sim=1&speed=20#/${route}`

  // Browser A: a profile entered before signing in stays local
  await setUp(a)
  await a.goto(url('profile'))
  await a.getByLabel('FTP').fill('250')
  await a.getByLabel('Weight').fill('75')
  await a.getByTestId('sync-badge').getByText('This browser only').waitFor()
  await a.getByText('stored in this browser only').waitFor()
  check(db.turbo_profile.length === 0, 'data was sent before signing in')

  // Signing in uploads it
  await a.getByRole('link', { name: 'Workouts', exact: true }).click()
  await signIn(a)
  await saved(a)
  check(db.turbo_profile[0]?.data.profile.ftp === 250 && db.turbo_profile[0].data.profile.weightKg === 75, 'the profile was not saved to the account')
  check(db.turbo_profile[0].data.settings.sound === true, 'the settings were not saved with the profile')

  // A generated workout
  await a.getByLabel('Workout description').fill('20 min tempo')
  await a.getByRole('button', { name: 'Create workout' }).click()
  await a.getByRole('heading', { name: 'Mock tempo' }).waitFor()
  await until(() => db.turbo_workouts.length === 1, 'the workout was not saved to the account')
  const workoutRow = db.turbo_workouts[0]
  check(workoutRow?.data.name === 'Mock tempo' && workoutRow.deleted === false && workoutRow.data.blocks.length === 3, 'the workout row is wrong')

  // A short ride
  await a.getByRole('link', { name: 'Workouts', exact: true }).click()
  await a.getByRole('button', { name: 'Connect trainer' }).click()
  await a.getByRole('link', { name: /Quick check/ }).click()
  await a.getByRole('button', { name: 'Start this workout' }).click()
  await a.getByRole('button', { name: 'Start', exact: true }).click()
  await a.waitForFunction(() => document.querySelector('[data-testid=ride-elapsed]')?.textContent >= '1:30')
  await a.getByRole('button', { name: 'End ride' }).click()
  await a.getByRole('button', { name: 'End and save' }).click()
  await a.getByTestId('summary-title').waitFor()
  await until(() => db.turbo_rides.length === 1, 'the ride was not saved to the account')
  const rideRow = db.turbo_rides[0]
  if (rideRow) {
    check(/^ride-\d+$/.test(rideRow.id) && !Number.isNaN(Date.parse(rideRow.start_ts)), 'the ride row has no id or start time')
    check(rideRow.data.workout.name === 'Quick check (8 min)' && rideRow.data.summary.durationS >= 90, 'the ride row lacks workout or summary')
    check(!('samples' in rideRow.data), 'the samples were stored twice')
    check(rideRow.samples.t.length === rideRow.data.summary.durationS && rideRow.samples.powerW.length === rideRow.samples.t.length, 'the samples are not stored column by column')
  }
  await saved(a)

  // Browser B: empty, signs in, and has everything
  const b = await otherBrowser()
  await setUp(b)
  await b.goto(url(''))
  await b.getByText('Enter your FTP and weight first').waitFor()
  await signIn(b)
  await saved(b)
  await b.getByRole('link', { name: /Mock tempo/ }).waitFor()
  check((await b.getByText('Enter your FTP and weight first').count()) === 0, 'the profile did not arrive in the second browser')
  await b.getByRole('link', { name: 'Profile', exact: true }).click()
  check((await b.getByLabel('FTP').inputValue()) === '250' && (await b.getByLabel('Weight').inputValue()) === '75', 'wrong profile in the second browser')
  await b.getByTestId('sync-status').getByText('saved to your account').waitFor()
  await b.getByRole('link', { name: 'Rides', exact: true }).click()
  await b.getByRole('link', { name: 'Quick check (8 min)' }).click()
  await b.getByTestId('summary-title').waitFor()
  const stats = await b.getByTestId('summary-stats').textContent()
  check(/Riding time1:[3-5]\d/.test(stats) && /Average power\d+ W/.test(stats), `the ride arrived without its numbers: ${stats}`)
  check((await b.locator('svg path').count()) > 0, 'the ride arrived without its power line')
  await b.screenshot({ path: `${process.env.SHOTS ?? 'e2e'}/synced-ride.png`, fullPage: true })

  // B changes the FTP, deletes the workout and the ride
  await b.getByRole('link', { name: 'Profile', exact: true }).click()
  await b.getByLabel('FTP').fill('260')
  await until(() => db.turbo_profile[0].data.profile.ftp === 260, 'the changed FTP was not saved to the account')
  await b.getByRole('link', { name: 'Workouts', exact: true }).click()
  await b.getByRole('link', { name: /Mock tempo/ }).click()
  await b.getByRole('button', { name: 'Delete this workout' }).click()
  await until(() => db.turbo_workouts[0].deleted === true && db.turbo_workouts[0].data === null, 'the deletion of the workout was not saved')
  await b.getByRole('link', { name: 'Rides', exact: true }).click()
  await b.getByRole('link', { name: 'Quick check (8 min)' }).click()
  await b.getByRole('button', { name: 'Delete ride' }).click()
  await b.getByRole('button', { name: 'Delete for good' }).click()
  await until(() => db.turbo_rides[0].deleted === true && db.turbo_rides[0].samples === null, 'the deletion of the ride was not saved')
  await saved(b)

  // Back in A: the changes arrive on the next load
  await a.goto(url('profile'))
  await a.reload()
  await saved(a)
  await until(async () => (await a.getByLabel('FTP').inputValue()) === '260', 'the FTP changed elsewhere did not arrive')
  await a.getByRole('link', { name: 'Workouts', exact: true }).click()
  await a.getByRole('link', { name: /Quick check/ }).waitFor()
  check((await a.getByRole('link', { name: /Mock tempo/ }).count()) === 0, 'the workout deleted elsewhere is still here')
  await a.getByRole('link', { name: 'Rides', exact: true }).click()
  await a.getByText('No rides yet').waitFor()

  // Nothing bounces back: the account still holds the deletions and the newer FTP
  await a.reload()
  await saved(a)
  check(db.turbo_workouts.length === 1 && db.turbo_workouts[0].deleted && db.turbo_rides.length === 1 && db.turbo_rides[0].deleted, 'deleted items came back')
  check(db.turbo_profile.length === 1 && db.turbo_profile[0].data.profile.ftp === 260, 'the profile was overwritten with an old value')

  // A failing server is reported, and local data stays
  check(errors.length === 0, `page errors before the outage: ${errors.join(' | ')}`)
  await a.unroute('**/rest/v1/**')
  await a.route('**/rest/v1/**', (route) => route.fulfill({ status: 500, headers: cors, contentType: 'application/json', body: JSON.stringify({ message: 'mock outage' }) }))
  await a.getByRole('link', { name: 'Profile', exact: true }).click()
  await a.getByLabel('FTP').fill('265')
  await a.getByTestId('sync-status').getByText('Could not save to your account').waitFor()
  await a.getByText('Reason: mock outage').waitFor()
  errors.length = 0 // the browser logs the mocked failures; those are expected
  await a.unroute('**/rest/v1/**')
  await mockCloud(a, db)
  await a.getByRole('button', { name: 'Sync now' }).click()
  await until(() => db.turbo_profile[0].data.profile.ftp === 265, 'the change made during the outage was not sent afterwards')

  check(db.problems.length === 0, `unexpected database calls: ${db.problems.join(' | ')}`)
})
