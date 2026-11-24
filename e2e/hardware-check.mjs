// End-to-end check of the hardware page against the simulated trainer and strap.
// Usage: npm run build && npm i --no-save playwright-core && npm run e2e
import { check, fail, withApp } from './lib.mjs'

await withApp(4179, async ({ page, base }) => {
  await page.goto(`${base}?sim=1&step=6#/check`)
  await page.getByRole('button', { name: 'Connect trainer' }).click()
  await page.getByTestId('trainer-name').waitFor()
  await page.waitForFunction(() => Number.parseInt(document.querySelector('[data-testid=power]').textContent) > 50)
  await page.getByRole('button', { name: 'Connect heart rate strap' }).click()
  await page.waitForFunction(() => Number.parseInt(document.querySelector('[data-testid=hr]')?.textContent) > 60)

  // Manual target, then check the simulated power follows it.
  await page.getByRole('button', { name: '200 W' }).click()
  await page.getByTestId('target').getByText('200 W').waitFor()
  await page.waitForFunction(
    () => Math.abs(Number.parseInt(document.querySelector('[data-testid=power]').textContent) - 200) < 20,
    null,
    { timeout: 15000 },
  )

  await page.getByRole('button', { name: 'Run ERG test' }).click()
  await page.getByText('ERG mode works').waitFor({ timeout: 40000 })

  const states = await page.$$eval('[data-testid=checklist] li', (items) =>
    items.map((li) => `${li.dataset.state}: ${li.textContent.trim()}`),
  )
  console.log(states.join('\n'))
  if (states.some((s) => !s.startsWith('pass'))) fail('not every checklist item passed')

  const log = await page.getByTestId('log').textContent()
  for (const needle of ['Request control: success', 'Set target 200 W: success', 'target power changed to 200 W']) {
    check(log.includes(needle), `log misses "${needle}"`)
  }
  await page.screenshot({ path: `${process.env.SHOTS ?? 'e2e'}/hardware-check.png`, fullPage: true })
})
