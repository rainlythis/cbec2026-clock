# Data model

Seven tables. Everything the event needs to survive a restart is here.

## `event_settings` (one row)

| column | notes |
| ------ | ----- |
| `active_event_date` | which day the **room** is showing |
| `sound_enabled` | room-display chime; off by default, `/live` is always silent |
| `grid_revision` | durable counter, bumped by every grid edit |

`grid_revision` is in the database rather than in memory because a client needs
to know whether its grid went stale *across a service restart*.

## `matching_tables` (10 rows, stable for the whole event)

The physical tables: `THPM`, `JD.com_1`, `JD.com_2`, `TMALL`, `AMAZON_1`,
`AMAZON_2`, `ALIBABA_1`, `ALIBABA_2`, `SHOPEE_1`, `SHOPEE_2`.

These codes are identity only. They never change, which is what lets
`appointments` and `timer_states` hold a stable foreign key.

## `table_days` (per date × table)

What a table *is* on a given day.

| column | notes |
| ------ | ----- |
| `display_label` | full spreadsheet name — `Alibaba-1`, `Profreight-1` |
| `short_label` | room-screen name — `THPM`, `Profreight-1` |
| `platform` | `Alibaba` on day 1, `Profreight Logistics` on day 2 |
| `grid_key` | `main` (15 min) or `shopee` (10 min) |
| `duration_seconds`, `display_order` | |
| `is_active` | `FALSE` for `AMAZON_2` on 18 Aug |

**Why this table exists.** Both matrix sheets in the approved workbook have the
same eight columns in the same order; only positions 7 and 8 change vendor.
Profreight is Alibaba's group with a different vendor, so it is the *same
physical table* wearing a different name — not a new table. Modelling it as
labels keeps the room grid at a fixed ten cards and keeps every foreign key
stable.

`display_label` is what the operator sees (it matches their spreadsheet);
`short_label` is what the room sees (it has to read across a hall).

## `time_slots` (114 rows: 2 days × [23 main + 34 shopee])

One row per **cell position**, shared by every table on that grid that day.

| column | notes |
| ------ | ----- |
| `grid_key` | `main` or `shopee` |
| `slot_index` | 0-based, contiguous — **the ordering authority** |
| `starts_at`, `ends_at` | wall-clock times |

**Why not derive slots from appointments:** an empty cell has no appointment
row, and day 2 is full of holes (`AMAZON_2` has zero rows, `AMAZON_1` has 16
empty cells of 23). The grid must be stored.

**Why not compute them from a formula:** the real timetable is irregular.

```
main    10:00 … 11:45   [lunch]   13:00 … 15:15   [break]   15:45 … 16:45
shopee  10:00 … 10:40 (no 10:50)  11:00 … 11:50
        13:00 … 14:40 (no 14:50)  15:00 … 16:50   ← runs through the 15:30 break
```

Because a same-time move between two tables keeps `slot_id` and only changes
`table_code`, no time recalculation is needed for the common case.

## `appointments`

The approved roster plus its live state.

| column | notes |
| ------ | ----- |
| `event_date`, `scheduled_start`, `scheduled_end` | maintained from the slot |
| `table_code`, `platform` | maintained from `table_days` on a move |
| `queue_number` | nullable; generated at import, never renumbered |
| `company_name` | long Thai strings |
| `appointment_status` | `scheduled \| arrived \| called \| in_meeting \| completed \| skipped \| no_show` |
| `arrival_status` | `not_arrived \| arrived` — physical check-in, tracked separately from flow |
| `slot_id` | grid cell. **NULL = parked** |
| `original_slot_id` | set once at import; drives the "moved" badge and stable queue numbers |
| `row_version` | optimistic concurrency |
| `contact_names`, `contact_emails`, `province`, `product_category`, `priority_group` | operator-only |

Indexes:

```sql
appointments_cell_uniq  (event_date, table_code, slot_id)      WHERE slot_id IS NOT NULL
appointments_queue_uniq (event_date, table_code, queue_number) WHERE queue_number IS NOT NULL
```

Both are **partial**, which is what allows a parked appointment (no slot) and an
appointment with no queue number to exist. It also means neither can be
`DEFERRABLE`, which is why compaction and swaps write in two phases — detach
every mover, then place them.

### `slot_id IS NULL` means parked

In the roster and in the history, but off the grid and **not callable**:
`pickNextEligible` and `buildSnapshot`'s eligible filter both require
`slot_id IS NOT NULL`. Without that, a company you cleared out of the grid would
still be called to a table.

### Personal data

`contact_*`, `province` and `product_category` are **returned by exactly one
function** — `revealContact()` — behind the operator session, with every read
written to `operation_log` as `contact.view`.

The columns are named in three places in `src/service.ts`, and only three:

| Where | What it does |
| ----- | ------------ |
| `importRoster` | the `INSERT` that stores them |
| `buildGrid` | `IS NOT NULL` existence check yielding the `hasContact` **boolean** |
| `revealContact` | the one `SELECT` that returns actual values |

They are absent from `loadAppointments`, `toPublicAppointment`, `buildSnapshot`
and the CSV export, so no public payload can carry them. A fourth reference is a
bug; check any new one against this table.

## `timer_states` (one row per table)

See [ARCHITECTURE.md](ARCHITECTURE.md#the-timer-model). `event_date` records
which day the row belongs to so a day switch can safely clear
`current_appointment_id` — leaving stale pointers would make the next
Complete & Next mark *yesterday's* appointment completed.

## `bare_clocks` (the standalone clock board)

Backs `/Bare_Clock` and `/Bare_Clock_Control`, and is referenced by **no** other
table: no event date, no platform, no appointment, no slot. A row is a label, a
length and the same timer columns as `timer_states`, so the pure maths in
`src/timer.ts` drives both.

Rows are ordinary data — the operator renames, adds and deletes them from the
control page, and unlike an appointment a deleted clock is really deleted,
because there is no approved roster behind it. `008_bare_clocks.sql` seeds the ten
event platforms as a convenience only, guarded so it never re-adds a clock
somebody removed.

Statuses are `ready`, `running`, `paused`, `timeup`; `break` and `closed` are not
in the check constraint because they describe a physical matching table.

`color` holds a palette **name** (`ink`…`purple`), constrained by a CHECK and
mirrored by `CLOCK_COLORS` in `src/bare.ts`; the hex for each lives once, in
`public/css/bare-clock.css`. Storing a name rather than a value keeps every colour
legible on a white card and means operator input can never reach a stylesheet.
Colour is identity, not status: it paints the card border and the clock's name,
while the digits keep their own time bands.

## `operation_log`

Append-only record of resets, skips, completions, grid edits, imports, day
switches and contact views. No dashboard by design; the last 40 entries are at
`GET /api/control/operations`.

Bare clock actions are logged here too, as `bare.*` with `table_code` left
**null** — writing a clock id into that column would make the event's log read as
if a matching table had been touched.

## Migrations

Forward-only, numbered, applied on boot behind an advisory lock.

| file | what |
| ---- | ---- |
| `001_init.sql` | core schema |
| `002_seed_tables.sql` | the ten tables and their timers |
| `003_grid_schema.sql` | `time_slots`, `table_days`, grid columns, partial indexes |
| `004_table_days.sql` | the per-day roster for both days |
| `005_seed_time_slots.sql` | 114 literal slot rows |
| `006_short_labels.sql` | room-screen labels per day |
| `007_original_table.sql` | remembers the cell each appointment was imported into |
| `008_bare_clocks.sql` | the standalone clock board, seeded with ten clocks |
| `009_bare_clock_colors.sql` | a palette colour per bare clock |

`005` is written out literally rather than generated: the irregularity *is* the
schedule and has to be reviewable in the diff.
