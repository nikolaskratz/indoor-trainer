// End-to-end check of the hardware page against the simulated trainer and strap.
// Usage: npm run build && npm run e2e   (needs Google Chrome and `npm i --no-save playwright-core`)
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const PORT = 4179
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

try {
  const url = `http://localhost:${PORT}/?sim=1&step=6`
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(url)).ok) break
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  const browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width: 1200, height: 1400 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(url)

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
    if (!log.includes(needle)) fail(`log misses "${needle}"`)
  }
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`)

  await page.screenshot({ path: process.env.SHOT ?? 'e2e/hardware-check.png', fullPage: true })
  await browser.close()
  if (!process.exitCode) console.log('OK')
} finally {
  server.kill()
}
