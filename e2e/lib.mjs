// Shared setup for the end-to-end checks: serves the built app and opens Google Chrome.
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

export async function withApp(port, run) {
  const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore' })
  const base = `http://localhost:${port}/`
  let browser
  try {
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(base)).ok) break
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    browser = await chromium.launch({ channel: 'chrome' })
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    await run({ page, base, errors })
    if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
    if (!process.exitCode) console.log('OK')
  } finally {
    await browser?.close()
    server.kill()
  }
}

export function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

export function check(condition, message) {
  if (!condition) fail(message)
}
