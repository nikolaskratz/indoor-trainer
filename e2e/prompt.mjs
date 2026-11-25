// End-to-end check of "create a workout from a description" with the backend mocked:
// sign in, send a prompt, land on the generated workout, see it in the list, delete it.
// The real server function is not called.
import { check, withApp } from './lib.mjs'

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

await withApp(4181, async ({ page, base, errors }) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
  let calls = 0
  let sentBody = null
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
    return calls === 1
      ? route.fulfill({ status: 502, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: 'Mock failure: try again.' }) })
      : route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ workout: generated }) })
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

  await page.getByRole('link', { name: 'Workouts', exact: true }).click()
  await page.getByRole('link', { name: /Mock 2 x 3 x 30\/30/ }).waitFor()
  await page.reload()
  await page.getByRole('link', { name: /Mock 2 x 3 x 30\/30/ }).click()
  await page.getByRole('button', { name: 'Delete this workout' }).click()
  await page.getByRole('link', { name: /Quick check/ }).waitFor()
  check((await page.getByRole('link', { name: /Mock 2 x 3/ }).count()) === 0, 'the deleted workout is still listed')
})
