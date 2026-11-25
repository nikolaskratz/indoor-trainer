// End-to-end check of several people using the app, with the server replaced by in-memory
// stand-ins: a friend creates an account and waits for access, the owner manages the list
// of people with access, and two accounts in one browser do not get each other's data.
import { check, emptyCloud, mockCloud, mockSignIn, until, withApp } from './lib.mjs'

await withApp(4185, async ({ page: f, base, otherBrowser, errors }) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
  let functionCalls = 0
  const setUp = async (page, db) => {
    await mockSignIn(page)
    await mockCloud(page, db)
    await page.route('**/functions/v1/**', (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      functionCalls++
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ configured: false, connected: false }) })
    })
  }
  const badge = (page, text) => page.getByTestId('sync-badge').getByText(text).waitFor()
  const url = (route) => `${base}?sim=1#/${route}`
  const quiet = () => new Promise((r) => setTimeout(r, 2500)) // longer than the sync's wait after a change

  // The friend: creates an account before the owner has added the address
  const friendDb = emptyCloud()
  friendDb.access = 'none'
  await setUp(f, friendDb)
  await f.goto(url(''))
  await f.getByRole('button', { name: 'New here? Create an account' }).click()
  await f.getByLabel('Email').fill('Friend@Example.com')
  await f.getByLabel('Password').fill('short')
  await f.getByRole('button', { name: 'Create account' }).click()
  check((await f.getByText('Sign out').count()) === 0, 'an account was created with a 5-character password')
  await f.getByLabel('Password').fill('long-enough-password')
  await f.getByRole('button', { name: 'Create account' }).click()
  await f.getByText('Sign out friend@example.com').waitFor()
  await f.getByTestId('no-access').getByText('friend@example.com').waitFor()
  await badge(f, 'No access yet')
  check((await f.getByLabel('Workout description').count()) === 0, 'an account without access can describe a workout')
  await f.getByRole('link', { name: /Quick check/ }).waitFor() // the built-in workouts are still there

  // Without access nothing leaves the browser
  await f.getByRole('link', { name: 'Profile', exact: true }).click()
  await f.getByLabel('FTP').fill('180')
  await f.getByLabel('Weight').fill('70')
  await f.getByTestId('no-access').waitFor()
  check((await f.getByText('People with access').count()) === 0, 'the access list is shown to someone who is not the owner')
  await quiet()
  check(friendDb.turbo_profile.length === 0 && friendDb.problems.length === 0, `data was sent without access: ${friendDb.problems.join(' | ')}`)
  check(functionCalls === 0, 'the server functions were called without access')
  await f.screenshot({ path: `${process.env.SHOTS ?? 'e2e'}/no-access.png`, fullPage: true })

  // The owner adds the address: "Check again" lets the friend in and saves what was entered
  friendDb.access = 'member'
  await f.getByRole('button', { name: 'Check again' }).click()
  await badge(f, 'Saved to your account')
  await until(() => friendDb.turbo_profile[0]?.data.profile.ftp === 180, 'the profile entered while waiting was not saved after access was given')
  check((await f.getByText('People with access').count()) === 0, 'the access list is shown to a member')
  await f.getByRole('link', { name: 'Workouts', exact: true }).click()
  await f.getByLabel('Workout description').waitFor()

  // The owner, on another computer: manages the list
  const ownerDb = emptyCloud()
  ownerDb.usage = [
    { email: 'owner@example.com', access: 'owner', requests: 9, cost_usd: 0.3051, month_usd: 20 },
    { email: 'friend@example.com', access: 'member', requests: 1, cost_usd: 0.0319, month_usd: 3 },
  ]
  const o = await otherBrowser()
  await setUp(o, ownerDb)
  await o.goto(url(''))
  await o.getByLabel('Email').fill('owner@example.com')
  await o.getByLabel('Password').fill('secret')
  await o.getByRole('button', { name: 'Sign in' }).click()
  await o.getByText('Sign out owner@example.com').waitFor()
  await o.getByRole('link', { name: 'Profile', exact: true }).click()
  await o.getByLabel('FTP').fill('250')
  await o.getByLabel('Weight').fill('75')
  await o.getByRole('heading', { name: 'People with access' }).waitFor()
  await o.getByText('Nobody else has access.').waitFor()
  const give = async (address) => {
    await o.getByLabel('Email address to give access').fill(address)
    await o.getByRole('button', { name: 'Give access' }).click()
    await until(async () => (await o.getByLabel('Email address to give access').inputValue()) === '', 'the address field was not cleared after adding')
  }
  await o.getByTestId('my-usage').getByText('You: 9 requests, $0.31 of $20.00 this month.').waitFor()
  await give('Friend@Example.com')
  await o.getByTestId('access-list').getByText('friend@example.com').waitFor()
  await o.getByTestId('access-list').getByText('1 request, $0.03 of $3.00 this month').waitFor()
  check(ownerDb.turbo_members.length === 1 && ownerDb.turbo_members[0].email === 'friend@example.com', 'the address was not stored in lower case')
  check(errors.length === 0, `page errors: ${errors.join(' | ')}`)
  await give('friend@example.com') // twice is fine and changes nothing
  check(ownerDb.turbo_members.length === 1 && (await o.getByText('duplicate key').count()) === 0, 'adding an address twice went wrong')
  errors.length = 0 // the server answers the duplicate with 409, which the browser logs
  await give('second@example.com')
  await o.getByTestId('access-list').getByText('second@example.com').waitFor()
  await o.getByTestId('access-list').getByText('no account yet').waitFor() // added, but has not signed up
  await o.screenshot({ path: `${process.env.SHOTS ?? 'e2e'}/access-list.png`, fullPage: true })
  await o.getByTestId('access-list').getByRole('listitem').filter({ hasText: 'second@example.com' }).getByRole('button', { name: 'Remove' }).click()
  await until(() => ownerDb.turbo_members.length === 1 && ownerDb.turbo_members[0].email === 'friend@example.com', 'removing an address removed the wrong one or none')
  await until(() => ownerDb.turbo_profile[0]?.data.profile.ftp === 250, "the owner's profile was not saved")
  await badge(o, 'Saved to your account')

  // The friend signs in on the owner's computer: the two accounts are kept apart
  await o.getByRole('link', { name: 'Workouts', exact: true }).click()
  await o.getByText('Sign out owner@example.com').click()
  await badge(o, 'This browser only')
  await o.unroute('**/rest/v1/**')
  await mockCloud(o, friendDb)
  await o.getByLabel('Email').fill('friend@example.com')
  await o.getByLabel('Password').fill('long-enough-password')
  await o.getByRole('button', { name: 'Sign in' }).click()
  await o.getByText('Sign out friend@example.com').waitFor()
  await badge(o, 'Another account’s data')
  await o.getByRole('link', { name: 'Profile', exact: true }).click()
  await o.getByTestId('other-account').waitFor()
  check((await o.getByLabel('FTP').inputValue()) === '250', "the owner's data in this browser was touched")
  await o.getByLabel('FTP').fill('255') // even a change made now stays here
  await quiet()
  check(friendDb.turbo_profile[0].data.profile.ftp === 180, "the owner's profile was written into the friend's account")
  check(ownerDb.turbo_profile[0].data.profile.ftp === 250, "the owner's account changed while the friend was signed in")
  await o.screenshot({ path: `${process.env.SHOTS ?? 'e2e'}/other-account.png`, fullPage: true })

  // Handing the browser to the friend loads the friend's data and leaves both accounts as they were
  await o.getByRole('button', { name: 'Use this browser for friend@example.com' }).click()
  await o.getByRole('button', { name: 'Remove the other account’s data here' }).click()
  await badge(o, 'Saved to your account')
  await until(async () => (await o.getByLabel('FTP').inputValue()) === '180', "the friend's profile was not loaded")
  check((await o.getByLabel('Weight').inputValue()) === '70', "the friend's weight was not loaded")
  await quiet()
  check(friendDb.turbo_profile.length === 1 && friendDb.turbo_profile[0].data.profile.ftp === 180, "the friend's account was changed by the switch")
  check(ownerDb.turbo_profile[0].data.profile.ftp === 250, "the owner's account was changed by the switch")

  check(friendDb.problems.length === 0 && ownerDb.problems.length === 0, `unexpected database calls: ${[...friendDb.problems, ...ownerDb.problems].join(' | ')}`)
})
