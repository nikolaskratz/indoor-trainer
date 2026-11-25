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
    const errors = []
    const watch = (page) => {
      page.on('pageerror', (e) => errors.push(String(e)))
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
      return page
    }
    const page = watch(await context.newPage())
    /** A page in a second, empty browser profile: "another computer". */
    const otherBrowser = async () => {
      const other = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
      return watch(await other.newPage())
    }
    await run({ page, base, errors, otherBrowser })
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

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

/** Makes sign-in with any email and password work, without the real server. */
export async function mockSignIn(page, email = 'rider@example.com') {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email }
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, exp, role: 'authenticated' })}.sig`
  await page.route('**/auth/v1/**', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (route.request().url().includes('/token')) {
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r', user }),
      })
    }
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(user) })
  })
}

/** An empty stand-in for the account's tables. Share one between pages to play two browsers. */
export const emptyCloud = () => ({ turbo_profile: [], turbo_workouts: [], turbo_rides: [], problems: [] })

/**
 * Answers the app's database calls from `db` instead of the real server: reads with
 * id filters and a column list, and "insert or update" writes. Anything else the app
 * sends is recorded in db.problems, which a test should find empty.
 */
export async function mockCloud(page, db = emptyCloud()) {
  await page.route('**/rest/v1/**', (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const url = new URL(req.url())
    const table = url.pathname.split('/').pop()
    const rows = db[table]
    const reply = (status, body) =>
      route.fulfill({ status, headers: CORS, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) })
    const refuse = (why) => {
      db.problems.push(`${req.method()} ${url.pathname}${url.search}: ${why}`)
      return reply(400, { message: why })
    }
    if (!Array.isArray(rows)) return refuse('unknown table')
    if (req.method() === 'GET') {
      let out = rows
      for (const [key, value] of url.searchParams) {
        if (key === 'select') continue
        if (value.startsWith('eq.')) out = out.filter((r) => String(r[key]) === value.slice(3))
        else if (value.startsWith('in.(') && value.endsWith(')')) {
          const wanted = value.slice(4, -1).split(',').map((v) => v.replace(/^"|"$/g, ''))
          out = out.filter((r) => wanted.includes(String(r[key])))
        } else return refuse(`unsupported filter ${key}=${value}`)
      }
      const columns = (url.searchParams.get('select') ?? '*').split(',')
      return reply(200, columns[0] === '*' ? out : out.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))))
    }
    if (req.method() === 'POST') {
      if (!(req.headers().prefer ?? '').includes('resolution=merge-duplicates')) return refuse('a write that is not an upsert')
      const expected = table === 'turbo_profile' ? 'user_id' : 'user_id,id'
      if (url.searchParams.get('on_conflict') !== expected) return refuse(`on_conflict should be ${expected}`)
      const body = req.postDataJSON()
      for (const row of Array.isArray(body) ? body : [body]) {
        if ('user_id' in row) return refuse('the app must not send user_id; the server fills it in')
        if (Number.isNaN(Date.parse(row.updated_at))) return refuse('a row without a valid updated_at')
        const same = (r) => table === 'turbo_profile' || r.id === row.id
        const at = rows.findIndex(same)
        if (at >= 0) rows[at] = { ...rows[at], ...row }
        else rows.push({ ...row })
      }
      return reply(201)
    }
    return refuse('unsupported method')
  })
  return db
}

/** Waits until `test()` is truthy; fails the check with `message` after `ms`. */
export async function until(test, message, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await test()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  fail(message)
  return false
}
