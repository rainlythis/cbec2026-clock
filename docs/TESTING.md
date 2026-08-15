# Testing

```bash
npm test        # builds, then runs node --test over dist/__tests__/*.test.js
```

102 tests, no database and no network required — every suite runs against pure
functions or an in-process Express app.

| Suite | Covers |
| ----- | ------ |
| `timer.test.ts` | the timer engine |
| `grid.test.ts` | frozen prefix, compaction, guards, move rules |
| `roster.test.ts` | xlsx parsing, alias map, validation, the real workbook |
| `csv.test.ts` | CSV parser and schedule validation |
| `auth.test.ts` | session tokens, passcode, cookie flags, endpoint authorization |

## What is deliberately covered

**Timer** — the toggle's three meanings; derivation from `ends_at`; pause
freezing; the sleep case (a 20-minute sleep on a 15-minute timer reads 0:00, not
a resumed countdown); ±1 minute at every state; the colour bands at their exact
boundaries (301→black, 300→orange, 121→orange, 120→red, 0→time up); 900 vs 600
second defaults; global toggle labelling; and rebuilding state from the
persisted columns alone, which is the restart case.

**Grid** — that a live meeting, a completed meeting and the loaded appointment
are all immovable; that compaction never pulls anybody backwards past a meeting
already called; that it steps over frozen cells; that a break crossing is
flagged; and that a cross-grid move is refused.

**Roster** — that `Alibaba-1` and `Profreight-1` map to the same physical table;
that Excel dates and serial times are read without a timezone shift; that a row
is rejected when its table doesn't trade that day; and, against the real
workbook, that all 415 rows parse, the per-day lineups are exactly right, SHOPEE
is 10 minutes and everything else 15, and no company is double-booked.

**Auth** — forged signatures, tampered payloads, expiry, wrong and missing
passcodes, throttling, `HttpOnly`/`SameSite=Strict`, and that control endpoints
answer 401 without a session.

## Manual checks worth repeating before the event

These need a database and a browser, and are the ones that catch integration
mistakes:

```bash
# 1. clean build exactly as Railway does it
rm -rf node_modules dist && npm ci && npm run build && npm test

# 2. schema + real roster on a scratch database
createdb topthai_check
DATABASE_URL=postgresql://localhost/topthai_check npm run migrate
DATABASE_URL=postgresql://localhost/topthai_check npm run import:xlsx -- "Final Matching Data.xlsx"
# expect: 415 inserted, 0 parked

# 3. nothing public can write
for EP in tables/THPM/toggle global/reset grid/cell/move grid/cell/clear; do
  curl -s -o /dev/null -w "$EP -> %{http_code}\n" -X POST localhost:8080/api/control/$EP \
    -H 'Content-Type: application/json' -d '{}'
done            # expect 401 for every one

# 4. no personal data in a public payload
curl -s localhost:8080/api/state | grep -icE "email|contact"   # expect 0
```

In the browser:

- `/display` at 1920×1080 on **both** dates — ten cards, no scrollbars, day 2
  shows Profreight and AMAZON-2 Closed.
- `/schedule` — compare against the workbook. There is a scripted version of
  this check that diffs all 504 cells; it currently reports zero mismatches.
- Move, swap and no-show on `/schedule`, with `/display` open in another tab —
  updates land in well under two seconds.
- Try to edit the cell of a running table — expect a 409 with a readable
  message.
- Two `/schedule` tabs on the same cell — the second gets *"This cell changed in
  another tab"*, not a silent overwrite.
- Restart the service mid-meeting — running timers keep counting, paused ones
  stay frozen.

## Adding tests

Put new rules in `src/timer.ts` or `src/grid.ts` (pure, no I/O) and test them
directly. Resist testing through the database: everything that has burned us so
far — colour boundaries, compaction over frozen cells, timezone-shifted Excel
times — was a pure-function bug.

`auth.test.ts` sets its environment before requiring the app modules (hence
`require`, not `import` — TypeScript hoists imports above the assignments).
Follow that pattern for any test that needs config.
