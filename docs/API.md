# API

All JSON unless noted. Times are ISO-8601 instants; wall-clock times are
`HH:MM` in Asia/Bangkok.

## Public — no authentication

| Method | Path | Returns |
| ------ | ---- | ------- |
| GET | `/health` | `{status, time, timezone}`; 503 if the database is unreachable |
| GET | `/api/time` | `{serverTime}` — clock-sync probe |
| GET | `/api/state` | the full snapshot (also the polling fallback) |
| GET | `/api/qr.svg?path=/live` | QR code SVG for the room display. Encodes `PUBLIC_BASE_URL` when set, otherwise the origin the request arrived on. The resolved URL is echoed in the `X-QR-Target` response header, so `curl -I` confirms it without decoding the image |

### Snapshot shape

```jsonc
{
  "serverTime": 1786800000000,
  "event": { "name": "...", "activeDate": "2026-08-17", "eventDates": ["2026-08-17","2026-08-18"],
             "timezone": "Asia/Bangkok", "soundEnabled": false, "sessions": [...] },
  "global": { "action": "play", "label": "Play All", "mixed": false },
  "tables": [{
    "tableCode": "ALIBABA_1",
    "displayLabel": "Alibaba-1",     // operator-facing, from table_days
    "shortLabel":   "Alibaba-1",     // room-screen name
    "isActive": true,                 // false => card shows Closed
    "platform": "Alibaba", "zone": "main",
    "durationSeconds": 900, "durationMinutes": 15, "displayOrder": 7,
    "timer": { "timerStatus": "running", "durationSeconds": 900,
               "startedAt": "...", "endsAt": "...", "pausedRemainingSeconds": null,
               "timeupAt": null, "remainingSeconds": 842,
               "statusLabel": "Running", "toggleLabel": "Pause", "toggleEnabled": true },
    "current":  { "id": 1, "queueNumber": "G001", "companyName": "...",
                  "scheduledStart": "10:00", "scheduledEnd": "10:15",
                  "tableCode": "ALIBABA_1", "platform": "Alibaba",
                  "appointmentStatus": "in_meeting", "arrivalStatus": "arrived" },
    "next": { ... }, "upcoming": [ ... up to 5 ... ],
    "stats": { "completed": 3, "skipped": 1, "waiting": 19, "total": 23 }
  }]
}
```

`queueNumber` may be `null` — clients fall back to `scheduledStart`. The
snapshot contains **no** contact fields.

### Socket.IO

| Event | Direction | Payload |
| ----- | --------- | ------- |
| `state` | server → all | the snapshot above |
| `sync` | server → all | `{serverTime}`, every 5 s |
| `time:ping` | client → server | clock probe, acked with `{clientSent, serverTime}` |
| `grid:changed` | server → **operators room only** | `{date, gridRevision, cells[], removed[]}` |

Sockets presenting a valid session cookie join the `operators` room. There is no
client-to-server event that mutates anything.

## Authentication

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/auth/status` | `{authenticated}` |
| POST | `/api/auth/login` | `{password}` → sets HttpOnly `SameSite=Strict` cookie. Throttled per IP |
| POST | `/api/auth/logout` | clears the cookie |

## Operator — all behind `requireOperator`, all 401 without a session

### Timers

| Method | Path | Body |
| ------ | ---- | ---- |
| POST | `/api/control/tables/:code/toggle` | — (Play / Pause / Resume, one button) |
| POST | `/api/control/tables/:code/reset` | — |
| POST | `/api/control/tables/:code/complete-next` | —. With an empty table this loads the first company rather than completing anything |
| POST | `/api/control/tables/:code/back` | — undoes the last complete/skip at this table. Refused while the timer runs |
| POST | `/api/control/tables/:code/skip-next` | `{noShow?}` |
| POST | `/api/control/tables/:code/adjust` | `{deltaSeconds}` (±15 min max) |
| POST | `/api/control/tables/:code/presence` | `{status: break\|closed\|ready}` |
| POST | `/api/control/global/toggle` | — |
| POST | `/api/control/global/reset` | `{confirm: true}` — **required** |

### Queue

| Method | Path | Body |
| ------ | ---- | ---- |
| POST | `/api/control/tables/:code/select` | `{appointmentId}` |
| POST | `/api/control/appointments/:id/arrival` | `{arrived}` |
| POST | `/api/control/appointments/:id/recall` | — |
| GET | `/api/control/appointments?date=` | full list for the operator's queue panel |

### Grid

| Method | Path | Body |
| ------ | ---- | ---- |
| GET | `/api/control/grid?date=` | `{date, activeDate, gridRevision, tables[], slots[], cells[], parked[]}` (~77 KB) |
| POST | `/api/control/grid/cell/no-show-push` | `{appointmentId, expectedVersion?, push?}` |
| POST | `/api/control/grid/cell/move` | `{appointmentId, tableCode, slotId\|null, expectedVersion?}` |
| POST | `/api/control/grid/cell/swap` | `{firstId, secondId, firstVersion?, secondVersion?}` |
| POST | `/api/control/grid/cell/clear` | `{appointmentId, expectedVersion?}` |
| POST | `/api/control/grid/cell/rename` | `{appointmentId, companyName}` |
| GET | `/api/control/grid/export.csv?date=` | BOM-prefixed CSV of the live schedule |

Grid mutations answer:

```jsonc
{ "ok": true, "gridRevision": 42, "date": "2026-08-17",
  "changed": [123, 124], "warnings": ["… is now due at TMALL, THPM around 14:00."],
  "crossedBreak": false }
```

`warnings` are advisory — the change **was** applied. See
[GRID_EDITOR.md](GRID_EDITOR.md#warnings-not-refusals).

### Settings, schedule, audit

| Method | Path | Body |
| ------ | ---- | ---- |
| POST | `/api/control/settings/sound` | `{enabled}` |
| POST | `/api/control/settings/active-date` | `{date}` — refused while any timer runs |
| POST | `/api/control/schedule/import` | `{csv, dryRun?}` — CSV fallback importer |
| GET | `/api/control/appointments/:id/contact` | the **only** contact read; logged as `contact.view` |
| GET | `/api/control/operations` | last 40 operations |

## Errors

| Status | When |
| ------ | ---- |
| 401 | no or invalid session |
| 429 | login throttled |
| 404 | unknown table / appointment |
| 409 | `OperationError` — an operator-readable sentence in `message` |
| 422 | CSV failed validation; `errors[]` carries line, column and reason |
| 500 | unexpected; logged with a stack, nothing applied |

409 codes worth handling in a UI: `stale` (version mismatch — reload the grid),
`occupied` (swap instead), `grid_mismatch` (cross-grid move refused).
