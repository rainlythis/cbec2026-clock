# The schedule grid editor

`/schedule` reproduces the workbook's `Monday 17 Matrix` + `Monday 17 SHOPEE`
sheets — rows are start times, columns are tables, each cell is a company — and
makes them editable while the event runs. Verified against the source workbook:
**504 of 504 cells match across both days.**

The grid and the clock are two views of one roster. An edit here reaches
`/display` and `/live` in well under a second; a Complete & Next on `/control`
shows up here immediately.

## Reading the grid

| Look | Meaning |
| ---- | ------- |
| **yellow, heavy black border, live countdown** | **at the table right now** |
| white | waiting |
| green | checked in (arrived) |
| amber | called, not yet started |
| grey, struck through | completed |
| red, struck through | skipped or no-show |
| blue left edge | moved from its original slot |
| hatched column | table closed that day (`AMAZON-2` on 18 Aug) |
| heavy rule between rows | a break in the day |

The page takes its day from `?date=`, **independent of the day showing in the
room**, so day 2 can be prepared while day 1 runs. A badge marks whichever day
is live.

### The live marker

The company at each table right now is highlighted, and carries its **live
countdown** in the corner — `▶ 12:34` running, `❙❙` paused — coloured with the
same bands as the room screen (black → orange → red). Its time row is
highlighted too, so a live row is findable while scrolling 23 of them, and a
**Jump to now** button in the header scrolls the earliest one into view.

Two details worth knowing:

- The countdown comes from the same server clock as `/display`, over the same
  socket, so the grid and the room can never disagree.
- Markers appear **only when the grid is showing the day that is running in the
  room**. Switch to the other day to prepare it and they disappear, because
  nothing there is live.

## The frozen prefix

The one rule that makes everything else safe.

> Anything `called`, `in_meeting`, `completed`, `skipped` or `no_show` — plus
> whatever `timer_states.current_appointment_id` points at — is **frozen**.
> `firstMovableSlotIndex` is one past the deepest frozen cell in that column,
> and a compaction only ever touches rows at or after it.

Consequences, all of which fall out for free:

- a live meeting is never pulled from under a running timer;
- a completed meeting is never rewritten;
- a table part-way through its day compacts only its future;
- nobody is pulled *backwards* into a gap above a meeting that has already been
  called — that time has effectively passed.

`planCompaction` in `src/grid.ts` is a pure function and is unit tested against
all of these cases.

## Actions

Click a cell.

| Action | Behaviour |
| ------ | --------- |
| **No-show — keep the times** | Marks `no_show`, parks the row. Nobody is re-timed. |
| **No-show — push whole queue up** | Also pulls every movable appointment below it up one slot. |
| **Move or swap** | Click the cell, then click the destination. Empty target = move; occupied target = swap. |
| **Rename company** | Fixes a typo. Allowed even mid-meeting. |
| **Take off the grid** | Parks the row: still in the roster, recallable, not callable. |
| **Show contact details** | Fetches contact + email on that click, and logs the access. |

### Why "keep the times" is the default no-show

The approved roster is built so no company is ever due at two tables at once.
Pushing a whole column up one slot breaks that for everyone below the gap — in
testing, one no-show at a busy table shifted 22 companies and produced **ten**
fresh self-clashes.

Without a push, the queue engine simply calls the next company early
(`pickNextEligible` already skips a no-show) and the rest of the day keeps its
planned times. That is what actually happens in the room. Push is still there
for when the operator genuinely wants to re-time a column, and it reports every
clash it creates.

## Warnings, not refusals

Two things are reported rather than blocked, because refusing would make the
operator's job impossible and silence would create a real problem nobody saw:

- **Self-clash** — the edit leaves one company due at two tables at overlapping
  times. Reported as a list.
- **`crossedBreak`** — on the main grid `11:45` and `13:00` are adjacent slot
  *indexes* but an hour apart, so a compaction can move somebody across lunch.

More than one warning is summarised in the toast, with the full list one click
away.

## Refusals

| Situation | Message |
| --------- | ------- |
| Cell is loaded at a table right now | *"… is loaded at THPM right now. Use Complete & Next or Skip & Next first."* |
| Cell already called / finished | *"… is already skipped and stays in the record. Recall them instead."* |
| Move between the 15- and 10-minute grids | *"SHOPEE runs a 10-minute grid … the rows do not line up."* |
| Move onto a table closed that day | *"That table is closed for the day."* |
| Move onto an occupied cell | *"… is already in that cell. Swap them instead."* |
| Version mismatch | *"This cell changed in another tab…"* |

**Cross-grid moves are refused, not reshaped.** 10:45 exists on the main grid
and not on SHOPEE; 10:40 and 10:50 exist on SHOPEE and not on main. A swap would
silently convert someone's 15-minute meeting into a 10-minute one. The escape
hatch is deliberate and explicit: take them off the grid, then place them on the
other one.

**Rename is the one thing allowed on a frozen cell.** It changes no identity and
no ordering, so a typo can always be fixed. It is a separate route so the
exception is visible in the code rather than a hole in the guard.

## Concurrency

Lock order is `event_settings` → `timer_states` (ordered by `table_code`) →
`appointments` (ordered by `slot_index`). Grid mutations take the first lock,
which makes them globally serial; timer actions do not, so the room clock is
never blocked by an edit.

`row_version` is sent with every cell and echoed back as `expectedVersion`. A
mismatch is a 409 and the page reloads the grid — a second tab can never
silently overwrite the first.

## Implementation notes

- Compaction and swaps write in **two phases** (detach all movers, then place
  them). `appointments_cell_uniq` is a partial index, and Postgres cannot defer
  a partial unique index to commit time, so an in-place shuffle would collide
  mid-update.
- `writeCell` is the single writer of a cell's position. It also rewrites
  `scheduled_start/end` from the slot and `platform` from `table_days`, because
  the queue engine orders by `scheduled_start` and `/live` labels by platform.
- Appointments are moved with `UPDATE`, never delete-and-insert:
  `timer_states.current_appointment_id` and `operation_log.appointment_id`
  reference the row, and recall depends on it surviving.
