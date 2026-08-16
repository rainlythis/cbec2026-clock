# TOPTHAI Day Business Matching Live

One synchronised Business Matching status system for **17–18 August 2026** (Asia/Bangkok):
a large room display, a public mobile queue page, and a single private operator console.
All connected screens show the same countdowns and queue state in real time.

| Route       | Who        | Purpose                                                        |
| ----------- | ---------- | -------------------------------------------------------------- |
| `/display`  | public     | 1920×1080 room screen. Read-only, no controls, QR to `/live`.   |
| `/live`     | public     | Mobile queue view. Filter, search, current / next / upcoming.   |
| `/control`  | operator   | Passcode-protected. Every timer and queue action lives here.    |
| `/schedule` | operator   | The editable time × table grid, shaped like the spreadsheet.    |
| `/health`   | Railway    | Health check (verifies the database round-trips).               |

## Documentation

| Doc | For |
| --- | --- |
| [CLAUDE.md](CLAUDE.md) | **start here** if you are an AI or a new engineer — invariants and surprises |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | timer authority, realtime, locking, resilience |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | every table and column, and why |
| [docs/GRID_EDITOR.md](docs/GRID_EDITOR.md) | the schedule grid's rules |
| [docs/API.md](docs/API.md) | every route and socket event |
| [docs/DATA_IMPORT.md](docs/DATA_IMPORT.md) | the xlsx/CSV formats and the alias map |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | **event-day runbook for the operator** |
| [docs/DECISIONS.md](docs/DECISIONS.md) | why the system is shaped this way |
| [docs/TESTING.md](docs/TESTING.md) | what is covered and how to check it |

## Tables

Ten physical tables, whose vendor at positions 7–8 changes between the two days.

| Day 1 — 17 Aug | Day 2 — 18 Aug | Meeting |
| -------------- | -------------- | ------- |
| THAILANDPOSTMART-1, JD.com-1, JD.com-2, AMAZON-1, AMAZON-2, TMALL-1, **Alibaba-1, Alibaba-2** | THAILANDPOSTMART-1, JD.com-1, JD.com-2, AMAZON-1, *AMAZON-2 (closed)*, TMALL-1, **Profreight-1, Profreight-2** | **15 minutes** |
| SHOPEE-1, SHOPEE-2 | SHOPEE-1, SHOPEE-2 | **10 minutes** |

Operating sessions: 10:00–12:00, 13:00–15:30, 15:45–17:00 (Asia/Bangkok). The
SHOPEE grid runs through the 15:30–15:45 break.

---

## How the timers work

Timer accuracy is the core requirement, so the design is deliberately narrow:

- **The server owns the clock.** `timer_states` stores `started_at`, `ends_at`,
  `paused_remaining_seconds`, `duration_seconds` and `timer_status`.
- **Nothing is ever decremented.** While a timer runs, the remaining time *is*
  `ends_at − now`. While paused, it is the frozen `paused_remaining_seconds`.
  No background job counts down a database column.
- **Clients compute their own display** from `ends_at` and a measured offset
  between the browser clock and the server clock, so a phone with the wrong local
  time still shows the correct MM:SS.
- **Recovery is automatic** after a refresh, a reconnect, a backgrounded tab, a
  sleeping phone or a Railway restart — all of them re-derive from `ends_at`.
- The only background job flips a running timer to `Time Up` once `ends_at`
  passes, and broadcasts it.
- Updates reach every screen over Socket.IO (measured at ~50 ms locally, well
  inside the two-second budget). If the socket drops, clients poll `/api/state`
  every three seconds and the header shows **Reconnecting** or **Offline** with
  the last successful sync time.

### Countdown colours

| Remaining | Colour |
| --------- | ------ |
| above 05:00 | black |
| 05:00 → 02:01 | orange |
| 02:00 → 00:01 | red |
| 00:00 | red + **TIME UP**, pulsing for ten seconds, then steady |

A text status is always shown next to the digits, so nothing depends on colour alone.

---

## Controls

Per table — and there is **no Stop button anywhere**:

1. **Play / Pause / Resume** — one button that changes meaning with the state.
2. **Reset** — back to the table's default duration. Never touches the queue;
   asks for confirmation unless the timer is untouched.
3. **Complete & Next** — current appointment → `completed`, next eligible one is
   loaded, timer reset. **It does not auto-start.** On an empty table it reads
   **Load First** and simply calls up the next company, which is how a table is
   started.
4. **Skip & Next** — current appointment → `skipped`, kept in the schedule and
   recallable later, next one loaded, timer reset. **It does not auto-start.**
   On an empty table it skips whoever is next in line.
5. **↩ Back** — undoes the last complete or skip: the previous company returns to
   the table and the loaded one goes back to the queue. Reversible, and refused
   while the timer is running.

Under **⋯ More**: add one minute, remove one minute (both confirmed), manage
queue / recall skipped, put the table on break, close the table.

Global: one **Play All / Pause All** toggle (labelled by what will happen, with a
**Mixed states** badge when tables disagree), **Reset All** (timers only, back to
full duration — the queue is untouched), and **Fresh Day**.

**Fresh Day** puts the whole active day back to never-run: every company waiting
in the slot it was imported into, every timer at full, nothing loaded at any
table. It is how you clear a rehearsal on the morning of the event. It discards
that day's completed and skipped outcomes and undoes schedule-grid edits, keeps
the roster and the operation log, and never touches the other day. Because it
cannot be undone by pressing it again, it is the one control that asks you to
type **RESET** to confirm.

Nothing ever advances or starts the next meeting automatically.

### Queue workflow

`scheduled → arrived → called → in_meeting → completed | skipped | no_show`

The operator can mark arrival, call the next arrived entrepreneur, start, complete,
skip, recall a skipped entrepreneur, and manually select a different next queue.
Eligible appointments are ordered *arrived first, then approved schedule order* —
the same order the public screens display, so "NEXT" always matches what the
button will load.

---

## Local development

Requires Node 20+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env          # then edit DATABASE_URL / CONTROL_PASSWORD / SESSION_SECRET
createdb topthai_matching_dev
npm run migrate               # schema, the ten tables, the per-day roster, the slot grid
npm run import:xlsx -- "Final Matching Data.xlsx"   # the approved roster (415 appointments)
npm run dev                   # http://localhost:8080
```

Other commands:

```bash
npm test          # build, then run all 102 tests
npm run build     # compile TypeScript to dist/
npm start         # run the compiled server (migrations run automatically on boot)
npm run seed      # load data/sample_schedule.csv instead, for a demo dataset
```

Open `/display` on the room screen, `/live` on a phone, and `/control` on the
operator's laptop. Migrations run automatically at startup, so `npm start` on a
fresh database is enough.

---

## Deploying to Railway

1. **Create the project** and add a **PostgreSQL** database to it.
2. **Add this repository** as a service (Nixpacks picks up `railway.json`:
   build `npm run build`, start `npm run start`, health check `/health`).
3. **Set the service variables:**

   | Variable | Value |
   | -------- | ----- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `CONTROL_PASSWORD` | a long random operator passcode |
   | `SESSION_SECRET` | a long random string (keep it stable across deploys) |
   | `PUBLIC_BASE_URL` | `https://<your-service>.up.railway.app` — pins the QR code target. Optional: if unset the QR uses the origin the request arrived on, which is already correct on Railway |
   | `TZ` | `Asia/Bangkok` |
   | `PORT` | injected by Railway; no need to set it |

4. **Deploy.** Migrations and the ten tables are created on first boot.
5. **Load the roster** once, from your machine against the Railway database:
   `railway run npm run import:xlsx -- "Final Matching Data.xlsx"`.
   After this the web grid at `/schedule` is the source of truth — re-importing
   would discard live event changes, so the CLI refuses unless you pass
   `--force`.
6. Point the room PC at `/display` in fullscreen and print the QR for `/live`.

Notes:

- Keep **one replica**. State is all in PostgreSQL, but a second instance would
  run a second expiry tick.
- `SESSION_SECRET` must not change between deploys or the operator is signed out.
- All state is persisted, so a redeploy or crash restores the exact timers and
  queues — running timers keep counting through the restart, paused ones stay frozen.

---

## Security model

Deliberately minimal: one operator, one passcode. There is no registration, no
account system and no staff roles.

- `CONTROL_PASSWORD` lives only in the environment. It is never in the frontend
  source, never in a URL, and never in the cookie.
- A correct passcode issues an HMAC-SHA256 signed session cookie that is
  `HttpOnly`, `SameSite=Strict`, `Secure` in production, and expires after 12 hours.
- **Every** mutating endpoint sits behind `requireOperator`. Socket.IO is
  broadcast-only — a public viewer has no write path at all.
- Repeated wrong passcodes are throttled per IP.
- The schema stores no phone numbers, emails or other personal contact details,
  so the public pages cannot leak them.

---

## CSV schedule format

`data/schedule_template.csv` is a ready-to-fill template; `data/sample_schedule.csv`
is a full two-day sample covering all ten tables.

```
event_date,scheduled_start,scheduled_end,platform,table_code,queue_number,company_name,appointment_status,arrival_status
2026-08-17,10:00,10:15,THPM,THPM,A001,"Example Co., Ltd.",scheduled,not_arrived
```

- `event_date` — `YYYY-MM-DD`; `scheduled_start` / `scheduled_end` — `HH:MM` (24h)
- `table_code` — one of the ten codes above
- `appointment_status` — `scheduled | arrived | called | in_meeting | completed | skipped | no_show`
- `arrival_status` — `not_arrived | arrived` (`yes`/`no`/`true`/`false` are accepted)
- Quote any field containing a comma, e.g. `"Siam Foods Co., Ltd."`

The file is validated before anything is written; every bad row is reported with
its line number, column and reason, and **nothing is imported if any row fails**.
Importing replaces the schedule for the dates found in the file and leaves other
dates alone, so day 2 can be re-imported without disturbing day 1.

The system only displays and operates an approved schedule — it does not generate
or optimise matches.

---

## Data model

| Table | Holds |
| ----- | ----- |
| `event_settings` | event name, active event day, timezone, room sound flag |
| `matching_tables` | the ten tables, their platform, duration and display order |
| `appointments` | the approved schedule and each appointment's status |
| `timer_states` | authoritative timer per table + the currently loaded appointment |
| `operation_log` | resets, skips, completions, imports and other key actions |

`operation_log` has no management dashboard by design; it exists to preserve a
record of what happened. The most recent entries are available to the operator at
`GET /api/control/operations`.

---

## The schedule grid

`/schedule` reproduces the workbook's matrix sheets and makes them editable
during the event: mark a no-show, move or swap a company between cells, fix a
name, take somebody off the grid. Edits reach every screen in well under a
second, and the room clock and the grid are two views of one roster.

Verified against the source workbook: **504 of 504 cells match** across both
days. See [docs/GRID_EDITOR.md](docs/GRID_EDITOR.md) for the rules — in
particular the *frozen prefix*, which is why a live meeting can never be pulled
out from under a running timer.

## Tests

```bash
npm test
```

102 tests covering the parts where a mistake would be expensive: the timer
engine, the grid rules, the xlsx importer, the CSV parser and authorization.
See [docs/TESTING.md](docs/TESTING.md).
