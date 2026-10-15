'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const createBreaker = require('../services/circuitBreaker')
const build = require('../services')
const listenMock = require('../mock-server')

// The unchanged MSW mock patches globalThis.fetch. Fake-fetch tests never touch it.
listenMock()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mocks setTimeout and Date with node:test mock.timers, starting at time 0.
 * The mock is reset automatically when the test ends. Move time with t.mock.timers.tick(ms).
 * @param {import('node:test').TestContext} t
 * @returns {void}
 */
const useMockTime = (t) => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })

/**
 * Lets pending promise callbacks run, e.g. the rest of a Retry after tick() fired it.
 * setImmediate is not mocked, so this never waits for real time.
 * @returns {Promise<void>}
 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Fake fetch for build({ fetch }). Routes are keyed by URL path (e.g. '/getUsers').
 * A route value can be:
 *   - a Response (a clone is returned on every call),
 *   - an Error (thrown, e.g. new TypeError('fetch failed') for a network error),
 *   - a function (init, path) => Response | Promise<Response> for custom behaviour.
 * An unknown path throws, so a test notices an unexpected call.
 * @param {Record<string, Response|Error|Function>} routes
 * @returns {((url: string, init?: RequestInit) => Promise<Response>) & { calls: { path: string, init?: RequestInit }[] }}
 */
function fakeFetch(routes) {
  const fetch = async (url, init) => {
    const path = new URL(url).pathname
    fetch.calls.push({ path, init })
    const route = routes[path]
    if (route === undefined) throw new Error(`fakeFetch: unexpected call to ${path}`)
    if (route instanceof Error) throw route
    if (typeof route === 'function') return route(init, path)
    return route.clone()
  }
  fetch.calls = []
  return fetch
}

/**
 * Creates a breaker with a fake log and a scripted send. Time comes from useMockTime(t).
 * Push the outcome of the next send onto `replies`: a status number, an Error
 * (thrown), or a promise (to keep the send in flight).
 * @returns {{
 *   breaker: ReturnType<typeof createBreaker>,
 *   sent: object[],
 *   logs: { from: string, to: string }[],
 *   replies: (number|Error|Promise<number>)[],
 * }}
 */
function setupBreaker() {
  const sent = []
  const logs = []
  const replies = []
  const breaker = createBreaker({
    send: async (payload) => {
      sent.push(payload)
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      return reply
    },
    log: { info: (obj) => logs.push(obj) },
  })
  return { breaker, sent, logs, replies }
}

/**
 * Checks the scheduled Retry fires exactly `ms` from now: nothing is sent after
 * ms - 1, and one send happens at ms. Push the Retry's reply first.
 * Await flush() afterwards to let the Retry finish.
 * @param {import('node:test').TestContext} t
 * @param {ReturnType<typeof setupBreaker>} b
 * @param {number} ms
 * @param {string} [msg]
 * @returns {void}
 */
function expectRetryIn(t, b, ms, msg) {
  const before = b.sent.length
  t.mock.timers.tick(ms - 1)
  assert.strictEqual(b.sent.length, before, `fired before ${ms} ms. ${msg ?? ''}`)
  t.mock.timers.tick(1)
  assert.strictEqual(b.sent.length, before + 1, `did not fire at ${ms} ms. ${msg ?? ''}`)
}

/**
 * Sends one failing call (status 503) through the breaker.
 * @param {ReturnType<typeof setupBreaker>} b
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function fail(b, payload) {
  b.replies.push(503)
  assert.strictEqual(await b.breaker.call(payload), 503)
}

/**
 * @param {number} n
 * @returns {{ id: string, name: string, userId: number }}
 */
const event = (n) => ({ id: `id-${n}`, name: `event ${n}`, userId: 1 })

/**
 * Builds the app with a fakeFetch and logging off; the app is closed when the test ends.
 * @param {import('node:test').TestContext} t
 * @param {Parameters<typeof fakeFetch>[0]} [routes]   fakeFetch routes. Empty: any upstream call throws.
 * @param {Parameters<typeof build>[0]} [options]       Extra build options, e.g. { upstreamTimeoutMs: 50 }.
 * @returns {{ app: ReturnType<typeof build>, fetch: ReturnType<typeof fakeFetch> }}
 */
function setupApp(t, routes = {}, options = {}) {
  const fetch = fakeFetch(routes)
  const app = build({ logger: false, fetch, ...options })
  t.after(() => app.close())
  return { app, fetch }
}

/**
 * Sends POST /addEvent through inject.
 * @param {ReturnType<typeof build>} app
 * @param {unknown} payload
 * @returns {Promise<import('light-my-request').Response>}
 */
const addEvent = (app, payload) => app.inject({ method: 'POST', url: '/addEvent', payload })

/**
 * @param {number} status
 * @returns {Response} An upstream response with that status and a body that must never reach a client.
 */
const upstream = (status) => new Response('secret upstream body', { status })

const UPSTREAM_ERROR = { error: 'UPSTREAM_ERROR', message: 'Event API request failed' }
const VALID = { name: 'party', userId: 1 }

// ---------------------------------------------------------------------------
// Circuit breaker examples
// ---------------------------------------------------------------------------

test('a new breaker is Closed with nothing scheduled', (t) => {
  useMockTime(t)
  const b = setupBreaker()
  assert.strictEqual(b.breaker.state(), 'Closed')
  t.mock.timers.tick(10 * 60_000)
  assert.strictEqual(b.sent.length, 0)
})

test('three failures within 30 s open the breaker; the first Retry sends the 3rd payload', async (t) => {
  useMockTime(t)
  const b = setupBreaker()
  await fail(b, event(1))
  t.mock.timers.tick(10_000)
  b.replies.push(new TypeError('fetch failed'))
  await assert.rejects(b.breaker.call(event(2)), TypeError)
  assert.strictEqual(b.breaker.state(), 'Closed')

  t.mock.timers.tick(20_000) // exactly 30 s after the 1st failure: still inside the window
  const third = event(3)
  b.replies.push(500)
  assert.strictEqual(await b.breaker.call(third), 500)
  assert.strictEqual(b.breaker.state(), 'Open')

  b.replies.push(200)
  t.mock.timers.tick(20_000)
  assert.strictEqual(b.sent.at(-1), third)
  await flush()
})

test('failures older than 30 s do not count', async (t) => {
  useMockTime(t)
  const b = setupBreaker()
  await fail(b, event(1))
  t.mock.timers.tick(10_000)
  await fail(b, event(2))
  t.mock.timers.tick(20_001) // the 1st failure is now outside the window
  await fail(b, event(3))
  assert.strictEqual(b.breaker.state(), 'Closed')
  t.mock.timers.tick(1)
  await fail(b, event(4))
  assert.strictEqual(b.breaker.state(), 'Open')
})

test('a status below 500 leaves the recorded failures alone', async (t) => {
  useMockTime(t)
  const b = setupBreaker()
  await fail(b, event(1))
  await fail(b, event(2))
  for (const status of [200, 301, 404, 499]) {
    b.replies.push(status)
    assert.strictEqual(await b.breaker.call(event(status)), status)
    assert.strictEqual(b.breaker.state(), 'Closed')
  }
  await fail(b, event(3)) // 3rd failure: the first two are still counted
  assert.strictEqual(b.breaker.state(), 'Open')
})

test('every state change is logged with from and to', async (t) => {
  useMockTime(t)
  const b = setupBreaker()
  for (let i = 1; i <= 3; i++) await fail(b, event(i))
  assert.deepStrictEqual(b.logs, [{ from: 'Closed', to: 'Open' }])

  b.replies.push(200)
  t.mock.timers.tick(20_000)
  await flush()
  assert.deepStrictEqual(b.logs, [
    { from: 'Closed', to: 'Open' },
    { from: 'Open', to: 'Retrying' },
    { from: 'Retrying', to: 'Closed' },
  ])
})

test('the first Retry fires exactly 20 000 ms after opening', async (t) => {
  useMockTime(t)
  const b = setupBreaker()
  t.mock.timers.tick(5_000)
  for (let i = 1; i <= 3; i++) await fail(b, event(i))
  b.replies.push(200)
  expectRetryIn(t, b, 20_000)
  await flush()
})

test('a Retry moves to Retrying and sends the Pending_Request once with its original id', async (t) => {
  useMockTime(t)
  const b = setupBreaker()
  for (let i = 1; i <= 3; i++) await fail(b, event(i))
  const sentBefore = b.sent.length

  let resolve
  b.replies.push(new Promise((r) => { resolve = r }))
  t.mock.timers.tick(20_000)
  assert.strictEqual(b.breaker.state(), 'Retrying')
  resolve(200)
  await flush()

  assert.strictEqual(b.breaker.state(), 'Closed')
  assert.strictEqual(b.sent.length, sentBefore + 1)
  assert.strictEqual(b.sent.at(-1).id, 'id-3')
})

test('failed Retries wait 40 s, then 60 s, from their end; a successful one closes and resets to 20 s', async (t) => {
  useMockTime(t)
  const b = setupBreaker()
  for (let i = 1; i <= 3; i++) await fail(b, event(i))
  const pending = b.sent.at(-1)

  // 1st Retry fails, so the next one is 40 s away.
  b.replies.push(503)
  expectRetryIn(t, b, 20_000)
  await flush()
  assert.strictEqual(b.breaker.state(), 'Open')

  // 2nd Retry is in flight for 3 s, then throws: the next one is 60 s after it ended, not after it started.
  let fail2
  b.replies.push(new Promise((_, reject) => { fail2 = () => reject(new TypeError('fetch failed')) }))
  expectRetryIn(t, b, 40_000)
  t.mock.timers.tick(3_000)
  fail2()
  await flush()
  assert.strictEqual(b.breaker.state(), 'Open')

  // 3rd Retry fails: still 60 s.
  b.replies.push(500)
  expectRetryIn(t, b, 60_000)
  await flush()

  // 4th Retry succeeds.
  b.replies.push(201)
  expectRetryIn(t, b, 60_000)
  await flush()
  assert.strictEqual(b.breaker.state(), 'Closed')
  assert.deepStrictEqual(b.sent.slice(3), [pending, pending, pending, pending]) // same Pending_Request every time

  // Nothing else is scheduled.
  const sentAfterClose = b.sent.length
  t.mock.timers.tick(10 * 60_000)
  assert.strictEqual(b.sent.length, sentAfterClose)

  // Failures were cleared: two new ones do not open, the third does, with 20 s.
  await fail(b, event(4))
  await fail(b, event(5))
  assert.strictEqual(b.breaker.state(), 'Closed')
  await fail(b, event(6))
  assert.strictEqual(b.breaker.state(), 'Open')

  // The Pending_Request is the new 3rd failing payload, not the old one.
  b.replies.push(200)
  expectRetryIn(t, b, 20_000)
  assert.strictEqual(b.sent.at(-1).id, 'id-6')
  await flush()
})

// ---------------------------------------------------------------------------
// Routes (fake fetch)
// ---------------------------------------------------------------------------

test('/health returns ok and the breaker state without calling upstream', async (t) => {
  const { app, fetch } = setupApp(t)
  const res = await app.inject('/health')
  assert.strictEqual(res.statusCode, 200)
  assert.deepStrictEqual(res.json(), { status: 'ok', circuitBreaker: 'Closed' })
  assert.strictEqual(fetch.calls.length, 0)
})

test('an unknown route returns 404 NOT_FOUND', async (t) => {
  const { app } = setupApp(t)
  const res = await app.inject('/nope')
  assert.strictEqual(res.statusCode, 404)
  assert.deepStrictEqual(res.json(), { error: 'NOT_FOUND', message: 'Route not found' })
})

test('/getUsers and /getEvents map upstream 503 and network errors to 502 without the upstream body', async (t) => {
  for (const path of ['/getUsers', '/getEvents']) {
    for (const reply of [upstream(503), new TypeError('fetch failed')]) {
      const { app } = setupApp(t, { [path]: reply })
      const res = await app.inject(path)
      const at = `${path} ${reply.constructor.name}`
      assert.strictEqual(res.statusCode, 502, at)
      assert.deepStrictEqual(res.json(), UPSTREAM_ERROR, at)
      assert.ok(!res.body.includes('secret'), at)
    }
  }
})

test('an upstream call that exceeds the timeout returns 502', async (t) => {
  // Never answers; rejects when the timeout aborts init.signal.
  const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  const { app } = setupApp(t, { '/getUsers': hang }, { upstreamTimeoutMs: 50 })
  const res = await app.inject('/getUsers')
  assert.strictEqual(res.statusCode, 502)
  assert.deepStrictEqual(res.json(), UPSTREAM_ERROR)
})

test('an invalid addEvent body returns 400 without calling upstream', async (t) => {
  const json = { 'content-type': 'application/json' }
  const cases = [
    { label: 'missing body', req: {}, field: /body|JSON object/ },
    { label: 'array', req: { payload: [] }, field: /body|JSON object/ },
    { label: 'null', req: { payload: 'null', headers: json }, field: /body|JSON object/ },
    { label: 'name: 123', req: { payload: { name: 123, userId: 1 } }, field: /name/ },
    { label: "name: ''", req: { payload: { name: '', userId: 1 } }, field: /name/ },
    { label: 'userId: 0', req: { payload: { name: 'x', userId: 0 } }, field: /userId/ },
    { label: 'details: 1', req: { payload: { name: 'x', userId: 1, details: 1 } }, field: /details/ },
  ]
  for (const { label, req, field } of cases) {
    const { app, fetch } = setupApp(t)
    const res = await app.inject({ method: 'POST', url: '/addEvent', ...req })
    assert.strictEqual(res.statusCode, 400, label)
    const body = res.json()
    assert.strictEqual(body.error, 'VALIDATION_ERROR', label)
    assert.match(body.message, field, label)
    assert.strictEqual(fetch.calls.length, 0, label)
  }
})

test('a bad user id returns 400 without calling upstream', async (t) => {
  for (const id of ['a.b', 'a%20b', '%3Cscript%3E', '..%2F1']) {
    const { app, fetch } = setupApp(t)
    const res = await app.inject('/getEventsByUserId/' + id)
    assert.strictEqual(res.statusCode, 400, id)
    assert.strictEqual(res.json().error, 'VALIDATION_ERROR', id)
    assert.strictEqual(fetch.calls.length, 0, id)
  }
})

test('addEvent forwards only name, userId, details and a new id', async (t) => {
  const cases = [
    { id: 'client-id', name: 'x', userId: 1, details: 'd', extra: true },
    { id: 7, name: 'x', userId: 'u-1' },
  ]
  for (const payload of cases) {
    const { app, fetch } = setupApp(t, { '/addEvent': new Response(null, { status: 200 }) })
    const res = await addEvent(app, payload)
    assert.strictEqual(res.statusCode, 201)
    const sent = JSON.parse(fetch.calls[0].init.body)
    const { id, extra, ...fields } = payload
    assert.deepStrictEqual(Object.keys(sent).sort(), ['id', ...Object.keys(fields)].sort())
    assert.deepStrictEqual({ ...sent, id: undefined }, { ...fields, id: undefined })
    assert.notStrictEqual(sent.id, id)
    assert.match(sent.id, /^[0-9a-f-]{36}$/)
  }
})

test('every getEventById call starts before any of them completes', async (t) => {
  const ids = ['a', 'b', 'c', 'd']
  let started = 0
  let release
  const barrier = new Promise((r) => { release = r })
  const routes = { '/getUserById/1': Response.json({ events: ids }) }
  for (const id of ids) {
    routes['/getEventById/' + id] = async (init) => {
      if (++started === ids.length) release()
      // Sequential code never reaches the release, so this fails via the upstream timeout instead of hanging.
      await Promise.race([barrier, new Promise((_, reject) => init.signal.addEventListener('abort', reject))])
      return Response.json({ id })
    }
  }
  const { app } = setupApp(t, routes, { upstreamTimeoutMs: 1000 })
  const res = await app.inject('/getEventsByUserId/1')
  assert.strictEqual(res.statusCode, 200, res.body)
  assert.strictEqual(started, ids.length)
})

test('events come back in the order of the user\'s events list', async (t) => {
  const delays = { e3: 30, e1: 0, e2: 15, e4: 5 } // completion order differs from request order
  const ids = ['e3', 'e1', 'e2', 'e1', 'e4']
  const routes = { '/getUserById/u1': Response.json({ events: ids }) }
  for (const [id, ms] of Object.entries(delays)) {
    routes['/getEventById/' + id] = async () => {
      await new Promise((r) => setTimeout(r, ms))
      return Response.json({ id, ms })
    }
  }
  const { app } = setupApp(t, routes)
  const res = await app.inject('/getEventsByUserId/u1')
  assert.strictEqual(res.statusCode, 200)
  assert.deepStrictEqual(res.json(), ids.map((id) => ({ id, ms: delays[id] })))
})

test('an empty, null or 404 user returns 404 NOT_FOUND', async (t) => {
  const users = { empty: new Response(''), null: Response.json(null), 404: new Response(null, { status: 404 }) }
  for (const [label, reply] of Object.entries(users)) {
    const { app, fetch } = setupApp(t, { '/getUserById/9': reply })
    const res = await app.inject('/getEventsByUserId/9')
    assert.strictEqual(res.statusCode, 404, label)
    assert.strictEqual(res.json().error, 'NOT_FOUND', label)
    assert.strictEqual(fetch.calls.length, 1, label) // no getEventById call
  }
})

test('one failing or null event returns 502 with no partial results', async (t) => {
  for (const [label, bad] of [['500', upstream(500)], ['null', Response.json(null)]]) {
    const { app } = setupApp(t, {
      '/getUserById/1': Response.json({ events: ['ok', 'bad'] }),
      '/getEventById/ok': Response.json({ id: 'ok' }),
      '/getEventById/bad': bad,
    })
    const res = await app.inject('/getEventsByUserId/1')
    assert.strictEqual(res.statusCode, 502, label)
    assert.deepStrictEqual(Object.keys(res.json()).sort(), ['error', 'message'], label)
    assert.strictEqual(res.json().error, 'UPSTREAM_ERROR', label)
    assert.ok(!res.body.includes('secret'), label)
  }
})

test('a 2xx from upstream returns 201 with the id that was sent', async (t) => {
  for (const status of [200, 201, 204]) {
    const { app, fetch } = setupApp(t, { '/addEvent': new Response(null, { status }) })
    const res = await addEvent(app, { ...VALID, details: 'd' })
    assert.strictEqual(res.statusCode, 201, `status ${status}`)
    assert.deepStrictEqual(res.json(), JSON.parse(fetch.calls[0].init.body), `status ${status}`)
  }
})

test('an upstream 503, 404 or network error returns 502', async (t) => {
  for (const reply of [upstream(503), upstream(404), new TypeError('fetch failed')]) {
    const { app } = setupApp(t, { '/addEvent': reply })
    const res = await addEvent(app, VALID)
    const at = reply instanceof Error ? 'network error' : `status ${reply.status}`
    assert.strictEqual(res.statusCode, 502, at)
    assert.deepStrictEqual(res.json(), UPSTREAM_ERROR, at)
  }
})

/**
 * Opens the app's breaker at the current mock time with three upstream 503s.
 * @param {ReturnType<typeof build>} app   Built with an '/addEvent' route that answers 503.
 * @returns {Promise<void>}
 */
async function openBreaker(app) {
  for (let i = 0; i < 3; i++) assert.strictEqual((await addEvent(app, VALID)).statusCode, 502)
  assert.strictEqual((await app.inject('/health')).json().circuitBreaker, 'Open')
}

test('while Open or Retrying, addEvent returns 503 with Retry-After and does not call upstream', async (t) => {
  useMockTime(t)
  let finishRetry
  const { app, fetch } = setupApp(t, {
    '/addEvent': () => fetch.calls.length <= 3
      ? upstream(503)
      : new Promise((r) => { finishRetry = () => r(new Response(null, { status: 200 })) }),
  })
  await openBreaker(app)

  /**
   * @param {string} retryAfter   Expected Retry-After header.
   * @param {number} calls        Expected fake fetch calls so far.
   */
  const expect503 = async (retryAfter, calls) => {
    const res = await addEvent(app, VALID)
    assert.strictEqual(res.statusCode, 503)
    assert.strictEqual(res.headers['retry-after'], retryAfter)
    assert.strictEqual(res.json().error, 'SERVICE_UNAVAILABLE')
    assert.match(res.json().message, /external event service is unavailable/)
    assert.strictEqual(fetch.calls.length, calls)
  }
  await expect503('20', 3) // just opened: 20 s left
  t.mock.timers.tick(500)
  await expect503('20', 3) // 19.5 s left
  t.mock.timers.tick(19_300)
  await expect503('1', 3) // 0.2 s left
  t.mock.timers.tick(200) // the Retry fires and stays in flight
  assert.strictEqual(fetch.calls.length, 4)
  assert.strictEqual((await app.inject('/health')).json().circuitBreaker, 'Retrying')
  await expect503('1', 4)

  finishRetry()
  await flush()
  assert.strictEqual((await app.inject('/health')).json().circuitBreaker, 'Closed')
})

test('app.close() clears the scheduled Retry', async (t) => {
  useMockTime(t)
  const { app, fetch } = setupApp(t, { '/addEvent': upstream(503) })
  await openBreaker(app)
  await app.close()
  t.mock.timers.tick(10 * 60_000)
  await flush()
  assert.strictEqual(fetch.calls.length, 3)
})

// ---------------------------------------------------------------------------
// Routes (real mock, real clock)
// ---------------------------------------------------------------------------

const MOCK_URL = 'http://event.com'

/**
 * Sends an Event_API call to the MSW mock through globalThis.fetch, failing on any other host.
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
function mockFetch(url, init) {
  assert.ok(url.startsWith(MOCK_URL + '/'), `unexpected host: ${url}`)
  return globalThis.fetch(url, init)
}

test('10 and 50 events from the real mock (500 ms each) come back in under 1 500 ms', async (t) => {
  for (const n of [10, 50]) {
    const events = Array.from({ length: n }, (_, i) => `event-${(i % 4) + 1}`)
    const { app } = setupApp(t, {}, {
      eventApiUrl: MOCK_URL,
      // Only getUserById/1 is faked (the mock's users have at most 2 events); every getEventById hits the mock.
      fetch: (url, init) => new URL(url).pathname === '/getUserById/1' ? Response.json({ events }) : mockFetch(url, init),
    })
    const start = performance.now()
    const res = await app.inject('/getEventsByUserId/1')
    const ms = performance.now() - start
    assert.strictEqual(res.statusCode, 200, `n=${n} ${res.body}`)
    assert.strictEqual(res.json().length, n)
    assert.ok(ms < 1500, `n=${n} took ${Math.round(ms)} ms`)
  }
})

// Must run before the addEvent test below, which appends a new event to user 1 in the mock's memory.
test('end-to-end getEventsByUserId/1 against the real mock returns event-1 and event-3 in order', async (t) => {
  const { app } = setupApp(t, {}, { eventApiUrl: MOCK_URL, fetch: mockFetch })
  const res = await app.inject('/getEventsByUserId/1')
  assert.strictEqual(res.statusCode, 200, res.body)
  assert.deepStrictEqual(res.json(), [
    { id: 1, name: 'Event 1', userId: 1, details: 'This is the first event' }, // event-1
    { id: 1, name: 'Event 1', userId: 1, details: 'This is the first event' }, // event-3
  ])
})

// The process's first addEvent through the mock: its count-based cycle answers 200 for requests 1–5.
test('end-to-end addEvent against the real mock returns 201 with the generated id', async (t) => {
  const { app } = setupApp(t, {}, { eventApiUrl: MOCK_URL, fetch: mockFetch })
  const res = await addEvent(app, VALID)
  assert.strictEqual(res.statusCode, 201, res.body)
  const { id, ...rest } = res.json()
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.deepStrictEqual(rest, VALID)
})
