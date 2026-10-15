# Event Management System

This service lets you read and add events. It does not store events itself. It passes each request on to another service, the Event API at `http://event.com`, and sends you the answer.

In this repository, a fake Event API (in `mock-server/`) stands in for the real one. The service starts it for you, so you need nothing else to try it out.

## Start the service

You need Node.js 22.13.0 or newer.

```sh
npm ci
npm start
npm test
```

### Settings

You can change these settings with environment variables. If a variable is not set, or is empty, the service uses the default.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | The port the service listens on |
| `HOST` | `127.0.0.1` | The address the service listens on |
| `LOG_LEVEL` | `info` | How much the service writes to the log |
| `EVENT_API_URL` | `http://event.com` | Where the Event API is |


## What you can ask the service

| Request | What you get back | Possible errors |
|---|---|---|
| `GET /health` | 200. Tells you the service is running, and shows the state of the circuit breaker: `Closed`, `Open` or `Retrying` | 500 |
| `GET /getUsers` | 200 and all users | 502, 500 |
| `GET /getEvents` | 200 and all events | 502, 500 |
| `GET /getEventsByUserId/:id` | 200 and all events of one user, in the order of the user's `events` list | 400, 404, 502, 500 |
| `POST /addEvent` | 201 and the event that was saved: `{ id, name, userId, details? }` | 400, 502, 503, 500 |

Any other address gives 404 `NOT_FOUND`.

### When something goes wrong

Every error looks like this:

```json
{ "error": "NOT_FOUND", "message": "A short explanation" }
```

Messages never show internal details, such as stack traces or what the Event API sent back.

| Error | What it means |
|---|---|
| 400 `VALIDATION_ERROR` | Your request is not valid. See [What a valid event looks like](#what-a-valid-event-looks-like). For `getEventsByUserId`, the `id` may only contain letters, digits, `-` and `_`. |
| 404 `NOT_FOUND` | The user does not exist (the Event API answered 404 or sent back nothing), or the address does not exist. |
| 502 `UPSTREAM_ERROR` | The Event API failed. It could not be reached, took longer than 5 seconds, answered with a status outside 200–299, or sent back an empty event. |
| 503 `SERVICE_UNAVAILABLE` | Only for `POST /addEvent`. The service has paused sending events to the Event API because it keeps failing. The `Retry-After` header tells you how many seconds to wait. See [How the service handles a failing Event API](#how-the-service-handles-a-failing-event-api). |
| 500 `INTERNAL_ERROR` | Something else went wrong. For example, the Event API sent back data that is not valid JSON. The service logs these errors. |

## What a valid event looks like

Send a JSON object to `POST /addEvent`:

| Field | Required | Rules |
|---|---|---|
| `name` | Yes | Text that is not empty |
| `userId` | Yes | A whole number of 1 or more |
| `details` | No | Text |

Example:

```json
{ "name": "Team lunch", "userId": 1, "details": "Friday at noon" }
```

The service checks types strictly. For example, it rejects `"name": 123` instead of turning it into `"123"`.

You get 400 if the body is missing, is not valid JSON, is not sent as JSON, or is an array or `null`. The message tells you which field is wrong.

The service creates the event `id` itself, as a UUID. If you send an `id`, the service ignores it. It only passes on `name`, `userId` and `details`.

## How the service handles a failing Event API

The Event API often fails when it gets many `addEvent` requests. To stop sending requests that will fail anyway, the service uses a circuit breaker (`services/circuitBreaker.js`). A circuit breaker counts failures and pauses traffic for a while when there are too many.

A failure means the Event API could not be reached, took longer than 5 seconds, or answered with status 500 or higher. A status below 500 is not a failure. It does not reset the failure count either.

### The three states

- Closed: everything is normal. The service sends each event to the Event API. You get 201 if it works and 502 if it does not.
- Open: traffic is paused. After 3 failures within 30 seconds, the service stops sending events. You get 503 right away. `Retry-After` tells you the number of seconds until the next test, rounded up, and at least 1.
- Retrying: the service is testing the Event API. It sends the event from the request that caused the third failure again, once, with the same `id`. While it waits for the answer, you get 503 with `Retry-After: 1`.

If the test works (status below 500), the breaker goes back to Closed and the failure count starts again from zero. If the test fails, the breaker goes back to Open and waits longer before the next test.

The first test happens 20 seconds after the breaker opens. After a failed test, the service waits 40 seconds before the next one, then 60 seconds for every test after that. Each wait starts when the previous test ends.

In every state, invalid requests still get 400. The service logs every change of state, and `GET /health` shows the current state.

## Why it is built this way

- Node.js 22.13.0 or newer: msw, the package behind the fake Event API, and its dependencies need this version.
- JS doc comments: Since the service is in vanilla JS the comments help you understand the code, give better tab completions, and description about functions and variable when you hover over them.
- Exact package versions: `package-lock.json` records the exact versions (fastify 4.29.1, msw 2.15.0). `npm ci` installs those, so every machine runs the same code. You can still update on purpose with `npm update`.
- Only two packages, `fastify` and `msw`, everything else uses what Node.js already has.
- Settings in environment variables: the same code runs everywhere without changes. The code uses `||` instead of `??`, so an empty variable also gets the default.
- The fake Event API starts before the service accepts requests.
- Exit code 1 if the service cannot start on its port: a process manager can then restart it or raise an alert.
- `GET /health` does not call the Event API: if the Event API is down, the service still counts as healthy.
- Clean shutdown: on SIGTERM or SIGINT, the service stops taking new requests, finishes the ones in progress, cancels any planned test, and exits with code 0.
- Logs: Fastify's built-in logger (pino) writes JSON logs with a request id. `utils/logger.js` is not used because the built-in logger is faster and gives more information out of the box (according to Fastify).
- One place handles all errors: every error has the same shape and status codes.
- A 5-second limit on every Event API call: a slow Event API cannot keep a request open forever. Going over the limit counts as a failure.
- New event ids: the old code let a client overwrite the id. It also used `Date.now()`, so two requests in the same millisecond got the same id. The service now creates a UUID and ignores any `id` from the client.
- Tests use `node:test` and `app.inject`: they need no extra packages and open no ports. The circuit breaker tests use `mock.timers`, so they do not have to wait in real time.
