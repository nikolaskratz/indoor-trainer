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

const userIds = new Map()
/** A stable made-up account id per email address. */
const userId = (email) => {
  if (!userIds.has(email)) userIds.set(email, `00000000-0000-4000-8000-${String(userIds.size + 1).padStart(12, '0')}`)
  return userIds.get(email)
}

/**
 * Makes signing in and creating an account work with any email and password, without the
 * real server. Each email address is its own account.
 */
export async function mockSignIn(page) {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const account = (email) => ({ id: userId(email), aud: 'authenticated', role: 'authenticated', email })
  await page.route('**/auth/v1/**', (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const path = new URL(req.url()).pathname
    if (path.endsWith('/logout')) return route.fulfill({ status: 204, headers: CORS })
    if (path.endsWith('/token') || path.endsWith('/signup')) {
      const user = account(String(req.postDataJSON()?.email ?? 'rider@example.com').toLowerCase())
      const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, exp, role: 'authenticated' })}.sig`
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r', user }),
      })
    }
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(account('rider@example.com')) })
  })
}

/**
 * An empty stand-in for one account's tables. Share one between pages to play two browsers.
 * `access` is what the server says the account may do: 'owner', 'member' or 'none'.
 */
export const emptyCloud = () => ({ access: 'owner', turbo_profile: [], turbo_workouts: [], turbo_rides: [], turbo_members: [], problems: [] })

/**
 * Answers the app's database calls from `db` instead of the real server: the access
 * question, reads with id filters and a column list, "insert or update" writes, and the
 * owner's list of people with access. Like the real server, it hands nothing to and takes
 * nothing from an account without access. Anything else the app sends is recorded in
 * db.problems, which a test should find empty.
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
    if (url.pathname.endsWith('/rpc/turbo_access')) return reply(200, db.access)
    if (!Array.isArray(rows)) return refuse('unknown table')
    if (db.access === 'none') return refuse('a database call from an account without access')
    if (table === 'turbo_members') {
      if (db.access !== 'owner') return refuse('only the owner may touch the access list')
      const email = (url.searchParams.get('email') ?? '').replace(/^eq\./, '')
      if (req.method() === 'GET') return reply(200, rows.map((r) => ({ email: r.email })))
      if (req.method() === 'POST') {
        const row = req.postDataJSON()
        if (row.email !== row.email.trim().toLowerCase()) return refuse('an email address that is not lower case')
        if (rows.some((r) => r.email === row.email)) return reply(409, { code: '23505', message: 'duplicate key value' })
        rows.push({ email: row.email, added_at: new Date().toISOString() })
        return reply(201)
      }
      if (req.method() === 'DELETE' && email) {
        rows.splice(0, rows.length, ...rows.filter((r) => r.email !== email))
        return reply(204)
      }
      return refuse('unsupported call to the access list')
    }
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
