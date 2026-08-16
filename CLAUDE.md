# CLAUDE.md — working on this codebase

Read this before changing anything. It is short on purpose; the detail lives in
[`docs/`](docs/).

## What this is

**TOPTHAI Day Business Matching Live** — a realtime countdown and queue system
for a business matching event on **17–18 August 2026**, Asia/Bangkok. Ten tables
run back-to-back meetings; entrepreneurs wait for their queue to be called.

Four views, one database:

| Route | Audience | Notes |
| ----- | -------- | ----- |
| `/display` | public, room screen | fixed 1920×1080, read-only, **zero buttons** |
| `/live` | public, phones | filter + search, silent, no personal data |
| `/control` | the single operator | timers and queue workflow |
| `/schedule` | the single operator | the editable time × table grid |

## Commands

```bash
npm install
npm run dev          # tsx watch, http://localhost:8080
npm test             # build + 102 tests (node:test)
npm run migrate      # apply migrations/*.sql in order
npm run import:xlsx -- "Final Matching Data.xlsx" [--force]
npm run build && npm start
```

Requires Node 20+ and PostgreSQL 14+. Copy `.env.example` to `.env` first.

## Invariants — do not break these

1. **The server owns the clock.** Remaining time is *derived* from
   `timer_states.ends_at`, never decremented by a job or a client. Anything that
   stores a countdown as a number that ticks down is wrong.
2. **One Play/Pause/Resume button. There is no Stop button** anywhere, by
   explicit product decision.
3. **Nothing auto-starts.** Complete & Next, Skip & Next and Back *load* an
   appointment and reset the timer to Ready. The operator always presses Play.
   Corollary: never disable an operator button on the grounds that nothing is
   loaded yet — Complete & Next is what loads the first company, and gating it
   on `table.current` deadlocked the whole page.
4. **Exactly one function returns a contact value** — `revealContact()` in
   `src/service.ts`, behind the operator session and logged as `contact.view`.
   Contact values must never appear in `loadAppointments`, `toPublicAppointment`,
   `buildSnapshot`, `buildGrid` or the CSV export; adding them leaks personal
   data to `/display` and `/live`.

   `grep -n 'contact_names\|contact_emails' src/service.ts` returns three hits,
   and all three are meant to be there: the `INSERT` in `importRoster`, a
   `IS NOT NULL` existence check in `buildGrid` that yields only a boolean
   (`has_contact`), and the `SELECT` in `revealContact`. A fourth hit is a bug.
5. **Every mutation is a `POST /api/control/*` behind `requireOperator`.**
   Socket.IO is broadcast-only; a public viewer has no write path at all.
6. **`table_days` must hold exactly 8 `main` + 2 `shopee` rows per date**, or
   the room display's fixed 4×2 grid silently breaks. `getTablesForDate()` logs
   a warning when it doesn't.
7. **Appointments are never deleted** by an edit. Skipping, no-showing or
   clearing a cell parks the row so it stays in the record and can be recalled.
8. **Slots are data, not a formula.** The grids are irregular — see below.

## Things that will surprise you

- **The two days have different tables.** Positions 7 and 8 are one pair of
  physical tables that changes vendor: `Alibaba-1/-2` on 17 Aug,
  `Profreight-1/-2` on 18 Aug. There are ten stable `table_code`s for the whole
  event; the *labels* come from `table_days` per day. `AMAZON_2` has no
  appointments on 18 Aug and shows as **Closed**.
- **Day 2 is sparse** — `AMAZON-1` has 16 of 23 cells empty, `JD.com-2` 14. An
  empty cell has no appointment row, which is why `time_slots` exists.
- **The grids are irregular.** Main: 23 slots with breaks at 12:00–13:00 and
  15:30–15:45. SHOPEE: 34 slots that skip 10:50 and 14:50 — and that **run
  straight through the 15:30–15:45 main break**. Never generate slot times.
- **The approved roster has no queue numbers.** They are generated at import
  from the table position and the *original* slot (`A001`…`J034`) so a queue
  push never renumbers anybody. `queue_number` is nullable; clients fall back to
  the scheduled time.
- **Company names are long Thai strings.** Clamp them, never truncate in the
  data layer, and keep `overflow-wrap: anywhere` on anything that shows them.
- **`[hidden]` needs `!important`** in `base.css`: several components set
  `display: grid`, which otherwise wins on specificity and leaves dialogs on
  screen.

## Layout of the code

```
src/
  timer.ts     pure timer maths            <- unit tested, no I/O
  grid.ts      pure grid rules             <- unit tested, no I/O
  csv.ts       CSV parser + validator      <- unit tested, no I/O
  roster.ts    xlsx reader + validator     <- unit tested, no I/O
  service.ts   all SQL and transactions
  routes/      express routers (public + control)
  realtime.ts  Socket.IO, the expiry tick, broadcasts
  app.ts       express wiring     index.ts  boot + graceful shutdown
public/        vanilla JS/CSS, one file per view, no framework
migrations/    forward-only SQL, applied on boot
```

The pure/impure split is deliberate: rules that must be provably right live in
`timer.ts` and `grid.ts` with no database access, so they can be tested
directly. Keep new rules there.

## Conventions

- TypeScript strict, CommonJS, no default exports.
- Comments explain *why*, not *what*. If a line looks odd, say why it must be
  that way (see the two-phase slot writes in `noShowAndPush`).
- Errors the operator can act on are `OperationError` with a sentence they can
  read; the route layer maps them to 409/404 and the UI toasts them verbatim.
- Frontend is plain ES5-style JS with no build step. Match the existing style.
- New SQL goes in a **new** numbered migration. Never edit an applied one.

## Before you say you're done

`npm test` passes, and for anything touching the timers, the grid or auth, check
it in the browser at both dates and confirm `/display` still fits 1920×1080 with
no scrollbars.
