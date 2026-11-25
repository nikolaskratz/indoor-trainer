// End-to-end check of the FTP test and the floating window against the simulated trainer:
// ride the ramp, watch the floating window, go to the cool-down, read the estimate on the
// summary and take it over into the profile. The ride clock runs 20 times faster.
import { check, fail, until, withApp } from './lib.mjs'

const shots = process.env.SHOTS ?? 'e2e'
const mmss = (text) => {
  const [m, s] = text.split(':').map(Number)
  return m * 60 + s
}

await withApp(4184, async ({ page, base }) => {
  const url = (route) => `${base}?sim=1&speed=20#/${route}`
  await page.goto(url('profile'))
  await page.getByLabel('FTP').fill('200')
  await page.getByLabel('Weight').fill('75')
  await page.getByLabel('Max heart rate').fill('120')

  // The profile points to the test; its page explains it instead of showing planned stress
  await page.getByRole('link', { name: 'FTP test', exact: true }).click()
  await page.getByRole('heading', { name: 'FTP test (ramp)' }).waitFor()
  await page.getByText('it starts at 92 W and rises by 12 W every minute').waitFor()
  check((await page.getByText('Training stress (TSS)').count()) === 0, 'planned stress is shown for the open-ended test')
  check((await page.getByText('Change this workout').count()) === 0, 'the test can be changed by prompt')
  await page.screenshot({ path: `${shots}/ftp-test.png`, fullPage: true })

  await page.getByRole('button', { name: 'Connect trainer' }).click()
  await page.getByRole('button', { name: 'Connect heart rate' }).click()
  await page.getByRole('button', { name: 'Start this workout' }).click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.getByText('FTP test: the target rises every minute').waitFor()
  check((await page.getByRole('button', { name: 'Skip step' }).count()) === 0, 'the test offers to skip steps')

  // Floating window: opens from a click, shows the live numbers, and its pause button works
  const supported = await page.evaluate(() => 'documentPictureInPicture' in window)
  if (!supported) {
    fail('this browser has no floating window support, so that part could not be checked')
  } else {
    await page.getByRole('button', { name: 'Floating window' }).click()
    await page.getByRole('button', { name: 'Close floating window' }).waitFor()
    const mini = (id) =>
      page.evaluate((testId) => window.documentPictureInPicture.window?.document.querySelector(`[data-testid=${testId}]`)?.textContent ?? null, id)
    await until(async () => /^\d+$/.test((await mini('mini-power')) ?? ''), 'the floating window shows no power')
    check(/^Target \d+ W · Z\d$/.test(await mini('mini-target')), `floating window target: ${await mini('mini-target')}`)
    check((await mini('mini-step'))?.startsWith('Warm-up') || (await mini('mini-step'))?.startsWith('Ramp minute'), `floating window step: ${await mini('mini-step')}`)
    const styled = await page.evaluate(() => {
      const w = window.documentPictureInPicture.window
      const el = w.document.querySelector('[data-testid=mini-ride]')
      return {
        display: w.getComputedStyle(el).display,
        sheets: w.document.styleSheets.length,
        copies: w.document.querySelectorAll('[data-testid=mini-ride]').length,
        fits: w.document.documentElement.scrollHeight <= w.innerHeight,
      }
    })
    check(styled.display === 'flex' && styled.sheets > 0, `the floating window is unstyled: ${JSON.stringify(styled)}`)
    check(styled.copies === 1 && styled.fits, `the floating window's contents are doubled or do not fit: ${JSON.stringify(styled)}`)
    // Its numbers move with the ride
    const first = mmss(await mini('mini-remaining'))
    await until(async () => mmss(await mini('mini-remaining')) !== first, 'the floating window does not update')
    // Pause and resume from the floating window
    await page.evaluate(() => window.documentPictureInPicture.window.document.querySelector('button').click())
    await page.getByTestId('ride-status').getByText('Paused').waitFor()
    await page.evaluate(() => window.documentPictureInPicture.window.document.querySelector('button').click())
    await page.getByTestId('ride-status').getByText('Riding').waitFor()
    await page.getByRole('button', { name: 'Close floating window' }).click()
    await until(() => page.evaluate(() => window.documentPictureInPicture.window === null), 'the floating window did not close')
    await page.getByRole('button', { name: 'Floating window' }).waitFor()
  }

  // Ride the 5-minute warm-up and 15 minutes of the ramp, then stop
  await page.waitForFunction(
    () => {
      const [m, sec] = (document.querySelector('[data-testid=ride-elapsed]')?.textContent ?? '0:00').split(':').map(Number)
      return m * 60 + sec >= 20 * 60
    },
    null,
    { timeout: 120000 },
  )
  await page.screenshot({ path: `${shots}/ftp-ride.png`, fullPage: true })
  await page.getByRole('button', { name: 'Done: cool down' }).click()
  await page.getByText('Cool-down', { exact: true }).first().waitFor()
  check((await page.getByRole('button', { name: 'Done: cool down' }).count()) === 0, 'the cool-down button is still shown in the cool-down')
  await page.getByText(/Target 80 W/).waitFor()
  await page.getByRole('button', { name: 'End ride' }).click()
  await page.getByRole('button', { name: 'End and save' }).click()

  // Result: the 15th ramp minute is 136 % of 200 W = 272 W, so about 204 W (the simulated
  // trainer lags a little behind the fast clock)
  await page.getByText('FTP test result').waitFor()
  const estimate = Number((await page.getByTestId('ftp-estimate').textContent()).replace(' W', ''))
  check(estimate >= 185 && estimate <= 210, `estimated FTP ${estimate} W is not near 204 W`)
  check((await page.getByTestId('ftp-current').textContent()) === '200 W', 'the current FTP is not shown')
  check((await page.getByText('probably cut short').count()) === 0, 'a full test is flagged as cut short')
  await page.screenshot({ path: `${shots}/ftp-result.png`, fullPage: true })

  if (estimate !== 200) {
    await page.getByRole('button', { name: `Set my FTP to ${estimate} W` }).click()
    await page.getByTestId('ftp-applied').waitFor()
  }
  // The simulated heart rate went above the 120 bpm entered as maximum
  const hrButton = page.getByRole('button', { name: /Set max heart rate to \d+ bpm/ })
  if (await hrButton.count()) {
    await hrButton.click()
    check((await hrButton.count()) === 0, 'the heart rate button stays after use')
  }
  await page.getByRole('link', { name: 'Open profile' }).click()
  check((await page.getByLabel('FTP').inputValue()) === String(estimate), 'the profile did not take over the estimate')

  // The result is still there when the ride is opened again
  await page.getByRole('link', { name: 'Rides', exact: true }).click()
  await page.getByRole('link', { name: 'FTP test (ramp)' }).click()
  await page.getByTestId('ftp-applied').waitFor()
})
