// End-to-end check of "create a workout from a description" with the backend mocked:
// sign in, send a prompt, land on the generated workout, change it with a second prompt,
// undo, change a built-in workout (saved as a copy), see them in the list, delete.
// The real server function is not called.
import { check, mockCloud, withApp } from './lib.mjs'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'rider@example.com' }
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, exp, role: 'authenticated' })}.sig`

const generated = {
  name: 'Mock 2 x 3 x 30/30',
  description: 'Two sets of three short efforts.',
  blocks: [
    { type: 'step', kind: 'warmup', durationS: 300, power: 0.5, powerEnd: 0.75 },
    {
      type: 'repeat',
      count: 2,
      blocks: [
        {
          type: 'repeat',
          count: 3,
          blocks: [
            { type: 'step', kind: 'work', durationS: 30, power: 1.2, label: 'VO2 max' },
            { type: 'step', kind: 'recovery', durationS: 30, power: 0.5 },
          ],
        },
        { type: 'step', kind: 'recovery', durationS: 180, power: 0.5, label: 'Set recovery' },
      ],
    },
    { type: 'step', kind: 'cooldown', durationS: 300, power: 0.55, powerEnd: 0.4 },
  ],
}

// What the mocked generator answers to a change request: the same workout with a 3-minute warm-up.
const revised = {
  name: 'Mock 2 x 3 x 30/30',
  description: 'Two sets of three short efforts, now with a 3-minute warm-up.',
  blocks: [{ ...generated.blocks[0], durationS: 180 }, ...generated.blocks.slice(1)],
}

await withApp(4181, async ({ page, base, errors }) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
  let calls = 0
  let sentBody = null
  // The server's answer once an account has reached its limit
  let limited = false
  const LIMIT_TEXT = 'That is the limit of 10 workout requests per hour. Try again in about 13 minutes.'
  // Signing in also starts the account sync; keep it away from the real server.
  const db = await mockCloud(page)
  await page.route('**/auth/v1/token**', (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({
          status: 200,
          headers: cors,
          contentType: 'application/json',
          body: JSON.stringify({ access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r', user }),
        }),
  )
  await page.route('**/auth/v1/logout**', (route) => route.fulfill({ status: 204, headers: cors }))
  // Strava is asked for its status after sign-in; keep that away from the real server too.
  await page.route('**/functions/v1/turbo-strava', (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ configured: false, connected: false }) }),
  )
  await page.route('**/functions/v1/turbo-workout', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    calls++
    sentBody = route.request().postDataJSON()
    if (calls === 1) {
      return route.fulfill({ status: 502, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: 'Mock failure: try again.' }) })
    }
    if (limited) {
      return route.fulfill({ status: 429, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: LIMIT_TEXT }) })
    }
    const workout = sentBody.base ? { ...revised, name: sentBody.base.name } : generated
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ workout }) })
  })

  await page.goto(`${base}?sim=1#/profile`)
  await page.getByLabel('FTP').fill('250')
  await page.getByLabel('Weight').fill('75')
  await page.getByRole('link', { name: 'Workouts', exact: true }).click()

  await page.getByText('Sign in to create workouts').waitFor()
  await page.getByLabel('Email').fill('rider@example.com')
  await page.getByLabel('Password').fill('secret')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByText('Sign out rider@example.com').waitFor()

  await page.getByRole('button', { name: '3x10x 30sec/30sec VO2 max workout' }).click()
  await page.getByRole('button', { name: 'Create workout' }).click()
  // The first (mocked) answer is an error: it is shown and the text stays for a retry
  await page.getByText('Mock failure: try again.').waitFor()
  errors.length = 0 // the browser logs the mocked 502; that one is expected
  await page.getByRole('button', { name: 'Create workout' }).click()

  await page.getByRole('heading', { name: 'Mock 2 x 3 x 30/30' }).waitFor()
  check(sentBody.prompt === '3x10x 30sec/30sec VO2 max workout', 'the prompt was not sent as typed')
  check(sentBody.profile.ftp === 250 && sentBody.profile.weightKg === 75, 'the profile was not sent')
  await page.getByText('Created from: "3x10x 30sec/30sec VO2 max workout"').waitFor()
  // 5 + 2 x (3 + 3) + 5 minutes
  await page.getByText('22:00').first().waitFor()
  await page.getByText('300 W').first().waitFor()
  await page.screenshot({ path: `${process.env.SHOTS ?? 'e2e'}/generated.png`, fullPage: true })
  check(sentBody.base === undefined, 'a new workout was sent as a change')

  // Change it with a second prompt: same workout, new steps, and an undo
  const generatedUrl = page.url()
  await page.getByRole('button', { name: 'Make the warm-up shorter' }).click()
  await page.getByRole('button', { name: 'Change workout' }).click()
  await page.getByTestId('change-done').waitFor()
  check(sentBody.prompt === 'Make the warm-up shorter', 'the change request was not sent as typed')
  check(sentBody.base.name === 'Mock 2 x 3 x 30/30' && sentBody.base.blocks.length === 3, 'the current workout was not sent with the change')
  check(sentBody.base.prompt === '3x10x 30sec/30sec VO2 max workout', 'the first request was not sent with the change')
  check(sentBody.base.blocks[0].durationS === 300 && sentBody.base.blocks[1].blocks[0].count === 3, 'the steps were not sent as they are')
  check(page.url() === generatedUrl, 'changing an own workout should stay on the same workout')
  const done = await page.getByTestId('change-done').textContent()
  check(done.includes('"Make the warm-up shorter"') && done.includes('22:00 → 20:00'), `unexpected change note: ${done}`)
  await page.getByText('now with a 3-minute warm-up').waitFor()
  check((await page.getByTestId('workout-changes').textContent()) === 'Changed: "Make the warm-up shorter"', 'the change is not listed under the title')
  check((await page.getByLabel('Change description').inputValue()) === '', 'the change text was not cleared')
  await page.screenshot({ path: `${process.env.SHOTS ?? 'e2e'}/changed.png`, fullPage: true })

  // The change is saved, and a second one carries the first along
  await page.reload()
  await page.getByText('now with a 3-minute warm-up').waitFor()
  await page.getByLabel('Change description').fill('one more set')
  await page.getByRole('button', { name: 'Change workout' }).click()
  await page.getByTestId('change-done').waitFor()
  check(JSON.stringify(sentBody.base.changes) === '["Make the warm-up shorter"]', 'earlier changes were not sent')
  check(sentBody.base.blocks[0].durationS === 180, 'the second change did not start from the changed workout')
  check(
    (await page.getByTestId('workout-changes').textContent()) === 'Changed: "Make the warm-up shorter", then "one more set"',
    'the second change is not listed',
  )
  await page.getByRole('button', { name: 'Undo' }).click()
  check((await page.getByTestId('workout-changes').textContent()) === 'Changed: "Make the warm-up shorter"', 'undo did not take the last change back')
  check((await page.getByTestId('change-done').count()) === 0, 'the change note is still shown after undo')

  // A built-in workout is not touched: the changed version becomes a new workout
  await page.getByRole('link', { name: 'Workouts', exact: true }).click()
  await page.getByRole('link', { name: /Quick check/ }).click()
  await page.getByText('the changed version is saved as a new workout').waitFor()
  await page.getByLabel('Change description').fill('shorter warm-up')
  await page.getByRole('button', { name: 'Change workout' }).click()
  await page.getByText('Based on: Quick check (8 min)').waitFor()
  check(sentBody.base.name === 'Quick check (8 min)', 'the built-in workout was not sent')
  check(/#\/workout\/w-/.test(page.url()), 'the changed built-in was not opened as a new workout')
  await page.getByRole('button', { name: 'Delete this workout' }).click()
  await page.getByRole('link', { name: /Quick check/ }).click()
  await page.getByRole('heading', { name: 'Quick check (8 min)' }).waitFor()
  check((await page.getByText('Based on:').count()) === 0, 'the built-in workout itself was changed')

  await page.getByRole('link', { name: 'Workouts', exact: true }).click()
  await page.getByRole('link', { name: /Mock 2 x 3 x 30\/30/ }).waitFor()
  await page.reload()
  await page.getByRole('link', { name: /Mock 2 x 3 x 30\/30/ }).click()
  await page.getByRole('button', { name: 'Delete this workout' }).click()
  await page.getByRole('link', { name: /Quick check/ }).waitFor()
  check((await page.getByRole('link', { name: /Mock 2 x 3/ }).count()) === 0, 'the deleted workout is still listed')

  // At the limit the server refuses: its message is shown, the text stays, nothing is created
  check(errors.length === 0, `page errors: ${errors.join(' | ')}`)
  limited = true
  await page.getByLabel('Workout description').fill('60 min endurance')
  await page.getByRole('button', { name: 'Create workout' }).click()
  await page.getByText(LIMIT_TEXT).waitFor()
  errors.length = 0 // the browser logs the mocked 429; that one is expected
  check((await page.getByLabel('Workout description').inputValue()) === '60 min endurance', 'the description was lost at the limit')
  check((await page.getByRole('link', { name: /Mock/ }).count()) === 0, 'a workout was created although the limit was reached')
  check(db.problems.length === 0, `unexpected database calls: ${db.problems.join(' | ')}`)
})
