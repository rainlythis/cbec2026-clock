# Architecture

## Shape

```
                  ┌──────────────┐
  room screen ───▶│              │
  phones      ───▶│  Express +   │◀──── PostgreSQL (all state)
  operator    ───▶│  Socket.IO   │
                  └──────────────┘
```

One Node process, one database, no cache, no queue, no framework on the
frontend. Everything a screen needs to render is in the snapshot it receives;
everything the server needs to survive a restart is in PostgreSQL.

## The timer model

This is the part that has to be right, so it is deliberately small.

`timer_states` stores, per table:

| column | meaning |
| ------ | ------- |
| `timer_status` | `ready \| running \| paused \| timeup \| break \| closed` |
| `duration_seconds` | the table's full meeting length (900 or 600) |
| `started_at` | when the meeting first started |
| `ends_at` | **the authority while running** |
| `paused_remaining_seconds` | the frozen value while paused or adjusted |
| `timeup_at` | when it hit zero, so clients can pulse for ten seconds |
| `current_appointment_id` | who is at the table |

Remaining time is a *function*, never a stored counter:

```
running          -> ceil((ends_at - now) / 1000), floored at 0
paused/break/... -> paused_remaining_seconds ?? duration_seconds
ready            -> paused_remaining_seconds ?? duration_seconds
timeup           -> 0
```

`src/timer.ts` implements exactly this and nothing else touches the maths. The
same function runs on the server (`remainingSeconds`) and in the browser
(`TopThai.remainingSeconds` in `public/js/client.js`), so they cannot disagree.

**Why it matters:** a refresh, a reconnect, a phone waking from sleep, or a
Railway redeploy all recompute from `ends_at` and land on the same number. A
decrementing counter would drift or reset on every one of those.

The only background job is a 1-second tick in `src/realtime.ts` that flips
`running -> timeup` once `ends_at` has passed. It records a transition that the
clock already made; it does not advance anything.

## Clock synchronisation

A phone's clock can be minutes off. On load, and again on reconnect, resume from
background, and every 60s, the client calls `GET /api/time` and keeps the offset
measured over the **fastest** round trip:

```
offset = serverTime + rtt/2 - clientReceiveTime
serverNow() = Date.now() + offset
```

All countdown rendering uses `serverNow()`.

## Realtime

- Socket.IO, WebSocket with long-poll fallback for venue wifi.
- On any change the server rebuilds the snapshot and emits `state` to everyone.
  Broadcasts are coalesced on a 40 ms timer so a burst of operator actions
  produces one message. Measured fan-out to three clients: ~50 ms.
- Every 5 s it emits `sync` (a server timestamp) and re-sends the full state at
  least every 15 s as a safety net.
- Clients that lose the socket poll `GET /api/state` every 3 s and show
  **Reconnecting** / **Offline** with the time of the last successful sync.
- **Operator-only channel:** sockets presenting a valid session cookie join the
  `operators` room. Grid deltas (`grid:changed`) go only there, so the working
  roster never reaches `/display` or `/live`. Verified by test.
- **Screens follow deploys.** Every snapshot carries `assetVersion`, a hash of
  `public/` computed once at boot. A page that sees a version different from the
  one it loaded with reloads itself, once, guarded by `sessionStorage` so a
  failed reload cannot loop. Without it a screen left open across a deploy runs
  old code against new markup and fails silently — buttons simply stop working,
  which is exactly what happened twice before this existed.
- **One socket per page.** `TopThai.on(event, handler)` lets `/schedule`
  subscribe to `grid:changed` on the shared connection rather than opening a
  second one, so its live countdowns use the same measured clock offset as every
  other screen.

## Request flow for a mutation

```
POST /api/control/... ──▶ requireOperator ──▶ service fn
                                                │  withTransaction
                                                │  ├ lock (see below)
                                                │  ├ guard  -> OperationError => 409
                                                │  ├ write
                                                │  └ logOperation
                                                ▼
                                    broadcastState() + broadcastGrid()
```

`OperationError` carries a sentence the operator can read; the route maps it to
409 (or 404) and the UI toasts it verbatim. Anything else is a 500 and is logged
with a stack.

## Locking

Two writers exist: the timer engine and the grid editor. They interlock through
`timer_states`, which is the natural per-table lock.

Order, always:

1. `event_settings` — grid mutations only, making them globally serial
2. `timer_states` via `lockTimer`, **ordered by `table_code`** when more than
   one table is involved (prevents A↔B / B↔A deadlock)
3. `appointments`, ordered by `slot_index`

Timer actions skip step 1, so the room clock is never blocked by a grid edit.

On top of row locks, `appointments.row_version` gives optimistic concurrency for
the UI: a stale `expectedVersion` returns 409 *"This cell changed in another
tab"* instead of silently overwriting another operator tab.

## Resilience

- Migrations run on boot behind a Postgres advisory lock, so a rolling redeploy
  cannot run them twice.
- `pg` reconnects on its own; the pool's `error` handler stops a dropped backend
  from killing the process.
- `SIGTERM` stops the tick, closes Socket.IO, drains HTTP, ends the pool, with a
  10 s hard backstop.
- Because all state is in PostgreSQL, a restart mid-meeting restores exact
  remaining times. Verified: 26 s of downtime, running timers kept counting,
  paused timers stayed frozen to the second.

## Deliberate non-goals

No chat, payments, attendee accounts, analytics, or match generation. The system
displays and operates an approved schedule. It does not build one.
