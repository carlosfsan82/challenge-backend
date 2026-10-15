'use strict'

/**
 * @typedef {Object} Breaker
 * @property {() => 'Closed'|'Open'|'Retrying'} state
 * @property {(payload: object) => Promise<number>} call
 *   Resolves to the upstream HTTP status. Rejects with the send error, or with a
 *   503 error carrying `retryAfter` (seconds) when not Closed, without calling send.
 * @property {() => void} stop   Clears the scheduled Retry; no further Retries are scheduled.
 */

const THRESHOLD = 3
const WINDOW_MS = 30_000
const DELAYS = [20_000, 40_000, 60_000]

/**
 * Creates a circuit breaker for Event_API /addEvent.
 * @param {Object} options
 * @param {(payload: object) => Promise<number>} options.send   Resolves to the HTTP status; rejects on network error/timeout.
 * @param {{ info: Function }} options.log                       Fastify logger.
 * @returns {Breaker}
 */
function createBreaker({ send, log }) {
  let state = 'Closed'
  /** @type {number[]} */
  let failures = []
  let pending = null
  let attempt = 0
  let timer = null
  let nextRetryAt = 0
  let stopped = false

  /**
   * Moves to a new state and logs the change.
   * @param {'Closed'|'Open'|'Retrying'} to
   * @returns {void}
   */
  function setState(to) {
    if (to === state) return
    log.info({ from: state, to }, 'circuit breaker state change')
    state = to
  }

  /**
   * Schedules the next Retry per the Retry_Schedule, measured from Date.now().
   * @returns {void}
   */
  function schedule() {
    if (stopped) return
    const delay = DELAYS[Math.min(attempt, DELAYS.length - 1)]
    nextRetryAt = Date.now() + delay
    timer = setTimeout(retry, delay)
  }

  /**
   * Moves to Open, stores the Pending_Request and schedules the first Retry.
   * @param {object} payload
   * @returns {void}
   */
  function open(payload) {
    pending = payload
    attempt = 0
    setState('Open')
    schedule()
  }

  /**
   * Records an Upstream_Failure while Closed; opens at THRESHOLD failures within WINDOW_MS.
   * Failures from calls that finish after the breaker left Closed are ignored.
   * @param {object} payload   Payload of the failed call.
   * @returns {void}
   */
  function recordFailure(payload) {
    if (state !== 'Closed') return
    const t = Date.now()
    failures.push(t)
    failures = failures.filter((f) => f >= t - WINDOW_MS)
    if (failures.length >= THRESHOLD) open(payload)
  }

  /**
   * Sends the Pending_Request once while Retrying. Success closes the breaker;
   * failure reopens it and schedules the next Retry from the end of this one.
   * @returns {Promise<void>}
   */
  async function retry() {
    timer = null
    setState('Retrying')
    let ok = false
    try {
      ok = (await send(pending)) < 500
    } catch {
      ok = false
    }
    if (ok) {
      failures = []
      pending = null
      attempt = 0
      setState('Closed')
    } else {
      attempt++
      setState('Open')
      schedule()
    }
  }

  /**
   * Seconds a client should wait before trying again.
   * @returns {number}
   */
  function retryAfter() {
    if (state === 'Retrying') return 1
    return Math.max(1, Math.ceil((nextRetryAt - Date.now()) / 1000))
  }

  /**
   * Forwards a payload while Closed; rejects with 503 otherwise.
   * @param {object} payload
   * @returns {Promise<number>} Upstream HTTP status.
   */
  async function call(payload) {
    if (state !== 'Closed') {
      const err = new Error('The external event service is unavailable')
      err.statusCode = 503
      err.retryAfter = retryAfter()
      throw err
    }
    let status
    try {
      status = await send(payload)
    } catch (err) {
      recordFailure(payload)
      throw err
    }
    if (status >= 500) recordFailure(payload)
    return status
  }

  /**
   * Clears the scheduled Retry and prevents further scheduling.
   * @returns {void}
   */
  function stop() {
    stopped = true
    clearTimeout(timer)
    timer = null
  }

  return { state: () => state, call, stop }
}

module.exports = createBreaker
