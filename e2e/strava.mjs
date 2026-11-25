// End-to-end check of the Strava flow with Strava and the backend mocked:
// ride, connect (redirect to Strava and back), upload, link to the activity, disconnect.
// Nothing is sent to the real Strava or the real server function.
import { check, mockCloud, withApp } from './lib.mjs'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'rider@example.com' }
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, exp, role: 'authenticated' })}.sig`

await withApp(4182, async ({ page, base }) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
  const reply = (route, body, status = 200) =>
    route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) })
  const strava = { connected: false, uploads: [], checks: 0, exchangedCode: null, authorizeUrl: null }
  // Signing in also starts the account sync; keep it away from the real server.
  const db = await mockCloud(page)

  await page.route('**/auth/v1/**', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (route.request().url().includes('/token')) {
      return reply(route, { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r', user })
    }
    return reply(route, user)
  })
  await page.route('**/functions/v1/turbo-strava', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const body = route.request().postDataJSON()
    switch (body.action) {
      case 'status':
        return reply(route, { configured: true, clientId: '12345', connected: strava.connected, athlete: strava.connected ? 'Test Rider' : null })
      case 'exchange':
        strava.exchangedCode = body.code
        strava.connected = true
        return reply(route, { connected: true, athlete: 'Test Rider' })
      case 'upload':
        strava.uploads.push(body)
        return reply(route, { uploadId: '777', status: 'Your activity is still being processed.', error: null })
      case 'check':
        strava.checks++
        return reply(
          route,
          strava.checks < 2
            ? { status: 'Your activity is still being processed.', error: null, activityId: null }
            : { status: 'Your activity is ready.', error: null, activityId: 424242 },
        )
      case 'disconnect':
        strava.connected = false
        return reply(route, { connected: false })
      default:
        return reply(route, { error: 'Unknown action.' }, 400)
    }
  })
  // Strava's permission page: approve at once and send the browser back.
  await page.route('https://www.strava.com/oauth/authorize**', (route) => {
    const url = new URL(route.request().url())
    strava.authorizeUrl = url
    const back = new URL(url.searchParams.get('redirect_uri'))
    back.searchParams.set('state', url.searchParams.get('state'))
    back.searchParams.set('code', 'mock-code')
    back.searchParams.set('scope', 'read,activity:write')
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(back.href)})</script>` })
  })

  const url = (route) => `${base}?sim=1&speed=20#/${route}`
  await page.goto(url('profile'))
  await page.getByLabel('FTP').fill('250')
  await page.getByLabel('Weight').fill('75')
  await page.getByText('Sign in on the start page to connect Strava').waitFor()

  await page.getByRole('link', { name: 'Workouts', exact: true }).click()
  await page.getByLabel('Email').fill('rider@example.com')
  await page.getByLabel('Password').fill('secret')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByText('Sign out rider@example.com').waitFor()

  // A short ride to have something to upload
  await page.getByRole('button', { name: 'Connect trainer' }).click()
  await page.getByRole('link', { name: /Quick check/ }).click()
  await page.getByRole('button', { name: 'Start this workout' }).click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-testid=ride-elapsed]')?.textContent >= '1:30')
  await page.getByRole('button', { name: 'End ride' }).click()
  await page.getByRole('button', { name: 'End and save' }).click()
  await page.getByTestId('summary-title').waitFor()
  const summaryUrl = page.url()

  // Connect: off to Strava and back to the same summary
  await page.getByRole('button', { name: 'Connect Strava to upload' }).click()
  await page.getByText('Strava connected as Test Rider.').waitFor()
  check(strava.exchangedCode === 'mock-code', 'the code from Strava was not exchanged')
  const q = strava.authorizeUrl.searchParams
  check(q.get('client_id') === '12345' && q.get('scope') === 'activity:write' && q.get('response_type') === 'code', 'wrong authorize parameters')
  check(q.get('redirect_uri') === base, `redirect_uri should be the app address, got ${q.get('redirect_uri')}`)
  await page.getByTestId('summary-title').waitFor()
  check(!page.url().includes('code='), 'the Strava code is still in the address')
  check(page.url().split('#')[1] === summaryUrl.split('#')[1], 'did not return to the ride summary')

  // Upload and link
  await page.getByRole('button', { name: 'Upload to Strava' }).click()
  const link = page.getByRole('link', { name: 'On Strava: view activity' })
  await link.waitFor()
  check((await link.getAttribute('href')) === 'https://www.strava.com/activities/424242', 'wrong activity link')
  const sent = strava.uploads[0]
  check(strava.uploads.length === 1, 'expected exactly one upload')
  check(sent.name === 'Quick check (8 min)', `unexpected activity name ${sent.name}`)
  check(/^ride-\d+$/.test(sent.externalId), `unexpected external id ${sent.externalId}`)
  check(sent.tcx.includes('<TrainingCenterDatabase') && (sent.tcx.match(/<Trackpoint>/g) ?? []).length > 60, 'the ride file is missing or short')
  check(sent.description.includes('Ridden with Indoor Trainer') && /NP \d+ W/.test(sent.description), 'description lacks the ride facts')
  await page.screenshot({ path: `${process.env.SHOTS ?? 'e2e'}/strava.png`, fullPage: true })

  // The link survives a reload, and there is no second upload button
  await page.reload()
  await page.getByRole('link', { name: 'On Strava: view activity' }).waitFor()
  check((await page.getByRole('button', { name: 'Upload to Strava' }).count()) === 0, 'upload offered twice')

  // Disconnect from the profile
  await page.getByRole('link', { name: 'Profile' }).click()
  await page.getByText('Connected as Test Rider').waitFor()
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await page.getByRole('button', { name: 'Connect Strava' }).waitFor()
  check(db.problems.length === 0, `unexpected database calls: ${db.problems.join(' | ')}`)
})
