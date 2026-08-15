# Decisions

Why the system is shaped the way it is. Each entry is a call that could
reasonably have gone another way.

---

## 1. The server owns the clock; remaining time is derived, never stored

**Alternative:** a `remaining_seconds` column decremented by a job or a client.

Timer accuracy is the whole product. Storing `ends_at` and computing
`ends_at - now` means a refresh, a reconnect, a phone waking from sleep and a
service restart all land on the same number with no reconciliation logic. A
decrementing counter drifts, and resets whatever it was doing when the process
died. Verified: 26 s of downtime mid-meeting, timers kept counting correctly.

---

## 2. One Play/Pause/Resume button, no Stop

Required by the brief, and right: a Stop button invites the operator to end a
meeting by accident, and "stopped" is not a state the queue needs — a meeting
either finishes (Complete & Next), is abandoned (Skip & Next), or is paused.
`toggleAction()` derives the button's meaning from the timer state so the three
labels can never disagree with what pressing it does.

---

## 3. Nothing auto-advances

Complete & Next and Skip & Next *load* the next appointment and reset the timer
to Ready. In a room, the next entrepreneur has to physically arrive and sit
down; a timer that started itself would already be wrong by the time they did.

---

## 4. Ten stable table codes with per-day labels, not twelve tables

**Alternative:** treat `Profreight-1/-2` as two more tables, giving twelve.

Both matrix sheets carry the same eight columns in the same order; positions 7
and 8 simply change vendor between days. The client confirmed Profreight is
Alibaba's group with a different vendor — the same physical table.

Modelling it as a label on a stable code keeps the room grid at exactly ten
cards (so the fixed 4×2 layout can never break), keeps `timer_states` at ten
rows, and avoids renaming anything. `table_days` carries `display_label` for the
operator, `short_label` for the room, and `platform` per day.

`AMAZON-2` has a column on the day-2 sheet but no bookings, so it is carried as
`is_active = FALSE` and shows as **Closed** — again to keep the grid at eight
main cards.

---

## 5. An explicit `time_slots` table

**Alternatives:** derive the grid from appointment times, or generate it from a
formula in code.

Both fail on the real data. An empty cell has no appointment row, and day 2 is
full of holes (`AMAZON_2` has zero rows; `AMAZON_1` has 16 of 23 cells empty),
so the grid cannot be derived. And the timetable is irregular — the main grid
breaks twice, SHOPEE skips 10:50 and 14:50 and runs *through* the 15:30 break —
so it cannot be generated. Slots are seeded as 114 literal rows, reviewable in
the diff.

Slots are keyed by `(event_date, grid_key)` rather than per table, so a
same-time move between two tables is just an `UPDATE table_code`.

---

## 6. `slot_id IS NULL` means parked, and parked is not callable

Gives one representation for "in the roster, in the history, recallable, but not
on the grid". `pickNextEligible` and the snapshot's eligible filter both require
`slot_id IS NOT NULL`, so clearing a cell genuinely removes someone from the
queue — which is what the operator means — while keeping the row for recall.

Rejected alternative: placeholder appointment rows for empty cells. That would
have poisoned the eligibility query, the stats counters and the ordering in
eight places, and eventually loaded a null company at a table.

---

## 7. The frozen prefix

One rule — *nothing called or finished, and nothing loaded at a table, may move;
compaction starts one row past the deepest such cell* — instead of a set of
special cases. Every awkward scenario (live meeting mid-column, completed
history, running timer, gap above a called meeting) falls out of it correctly,
and it is cheap to unit test because `planCompaction` is pure.

---

## 8. "No-show, keep the times" is the default; pushing the queue up is opt-in

**Discovered by testing, not designed up front.** The roster is built so no
company is ever due at two tables at once. Pushing a column up one slot breaks
that for everyone below: one no-show at a busy table moved 22 companies and
created **ten** self-clashes.

Without a push, the queue engine already calls the next company early, and the
rest of the day keeps its planned times — which is what happens in the room
anyway. Push remains available for deliberate re-timing, and reports every clash
it creates.

---

## 9. Clashes warn, they never refuse

Refusing would make the operator's job impossible in exactly the moments it
matters. Staying silent would create a real double-booking nobody noticed. So
the edit applies and the response carries a `warnings[]` list, summarised in the
UI with the detail one click away. Same treatment for `crossedBreak`.

---

## 10. Cross-grid moves are refused rather than reshaped

10:45 exists on the main grid and not on SHOPEE; 10:40 and 10:50 exist on SHOPEE
and not on main. A "helpful" swap would silently turn a 15-minute meeting into a
10-minute one. The refusal explains why, and the escape hatch — park, then place
on the other grid — makes the duration change a decision somebody took.

---

## 11. Rename is allowed on a frozen cell

The single exception to the guard, on its own route so it is visible in the code
rather than a hole in the check. Renaming changes no identity and no ordering,
and a typo on the room screen should always be fixable.

---

## 12. Exactly one function returns a contact value

`revealContact()`, behind the operator session, logged as `contact.view`. Absent
from every other SELECT list, including the CSV export.

The point is that a reviewer can check the privacy guarantee with one command
rather than reasoning about payload shapes:

```bash
grep -n 'contact_names\|contact_emails' src/service.ts
```

Three hits are expected and each is annotated in the code — the `INSERT` at
import, an `IS NOT NULL` existence check in `buildGrid` that yields only a
boolean, and the `SELECT` in `revealContact`. A fourth is a bug. (The earlier
wording of this rule said "selected in exactly one place", which the grep
contradicts; the check is only useful if its expected output is stated exactly.)

The export drops contacts for the same reason — they never change during the
event and the operator still holds the original workbook.

---

## 13. Grid deltas go to an operators-only Socket.IO room

The grid carries the working roster and is four times the size of the public
snapshot. Sockets with a valid session cookie join `operators`; `grid:changed`
is emitted only there. Verified by test that a cookieless socket receives
nothing. The public snapshot shape is unchanged, so `/display` and `/live` need
no protocol change.

---

## 14. `/schedule` is its own page, and its date is independent

During the event the operator's screen belongs to the timers; the grid is mostly
a between-sessions tool, and 252 cells do not belong in a modal. Its `?date=`
is deliberately independent of `event_settings.active_event_date` so day 2 can
be prepared while day 1 runs.

---

## 15. Optimistic concurrency on top of row locks

Row locks prevent corruption; they do not prevent a second tab silently
overwriting the first. `row_version` on every cell, echoed as `expectedVersion`,
turns that into a 409 the operator can see. Lock order is fixed
(`event_settings` → `timer_states` by `table_code` → `appointments` by
`slot_index`) so concurrent swaps cannot deadlock; timer actions skip the first
lock so the room clock is never blocked by an edit.

---

## 16. Vanilla frontend, no framework

Three of the four views are mostly text and numbers that must survive flaky
venue wifi and a long-running fullscreen browser. No build step means no
toolchain to break on the morning of the event, and the whole client is
readable in one sitting.

---

## 17. `exceljs` with a `uuid` override

`exceljs` pulls a transitive `uuid` with a moderate advisory (v3/v5/v6 with a
`buf` argument). `exceljs` only calls `uuidv4()` with no arguments, so the path
is unreachable — but an `overrides` entry pinning `uuid@^11.1.1` clears the
audit and was verified to still read the workbook. Downgrading `exceljs` was the
alternative and is a breaking change for no benefit.

---

## Known deviations from the original brief

- **Table order on the room display** now follows the workbook column order
  (…AMAZON-1, AMAZON-2, TMALL-1, Alibaba-1, Alibaba-2) rather than the original
  mockup (…TMALL, AMAZON-1, AMAZON-2…). One order across the display, the
  control page and the grid is worth more than matching the mockup exactly.
- **The session banner** on `/display` uses the main-grid sessions. SHOPEE has
  live meetings at 15:30 and 15:40, inside the main 15:30–15:45 break, so the
  banner can read "Break" while both SHOPEE tables are running. Left as-is
  because the per-table status pill is always correct; fix by making sessions
  per-grid if it bothers anyone.
