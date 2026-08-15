# Event-day runbook

For the operator. Everything here is done from `/control` (timers) and
`/schedule` (the grid), signed in with the passcode.

## Before doors open

1. Open `/control`, sign in, confirm **Event day** is today's date.
2. Open `/schedule` and check the grid against your spreadsheet.
3. Put `/display` on the room screen and press **F11** for fullscreen.
4. Print or show the QR (bottom-right of the room screen) — it points at `/live`.
5. Leave **Room sound: Off** unless you want a chime at 00:00.

Each table starts **Ready** with no company loaded. Press **Complete & Next**
once per table to load the first appointment, or use the queue panel.

## Running a meeting

| You want to | Do this |
| ----------- | ------- |
| Start | **Play** |
| Pause | the same button, now reading **Pause** |
| Resume | the same button, now reading **Resume** |
| Put the clock back to full | **Reset** (confirms; does not change the queue) |
| Finish and load the next | **Complete & Next** |
| Give them more time | ⋯ → **Add one minute** |

The next meeting never starts by itself. After Complete & Next the timer sits at
Ready until you press Play.

At 00:00 the digits go red, pulse for ten seconds, then hold steady. The meeting
is not ended for you.

## Somebody hasn't turned up

**On `/control`** — **Skip & Next**. They are marked skipped, kept in the
record, and the next company is loaded.

**On `/schedule`** — click their cell:

- **No-show — keep the times** *(use this one)*. The table simply calls the next
  company early; nobody else is re-timed.
- **No-show — push whole queue up**. Everyone below moves up one slot. Only do
  this if you really want to re-time that table for the rest of the day — it
  often makes companies clash with their own meetings elsewhere, and you'll get
  the list.

## They turn up late

`/control` → ⋯ → **Manage queue** → find them under **Skipped** → **Recall**.
They go back into the waiting queue. Nothing is ever deleted.

## Moving somebody

On `/schedule`, click their cell → **Move or swap…** → click the destination.

- Empty destination = move. Occupied = swap.
- Between two tables at the same time = just a column change.
- **Between a 15-minute table and SHOPEE is refused** — the rows don't line up
  and it would change someone's meeting length. Take them off the grid and place
  them on the other grid instead.
- A cell that is at a table right now is locked. Complete or Skip it first.

## Changing a company name

Click the cell → **Rename company**. This works even while that table is
mid-meeting.

## Switching to day 2

`/control` → **Event day** → choose the date.

- Refused while any timer is running — pause them first.
- All timers reset and all loaded companies are cleared.
- Tables 7 and 8 change from Alibaba to **Profreight**; **AMAZON-2 shows as
  Closed** because it has no day-2 appointments. Both are expected.

You can prepare day 2 on `/schedule` at any time — use the day tabs. The badge
shows which day the room is on.

## Contact details

Click a cell on `/schedule` → **Show contact details**. Operator only, never on
`/display` or `/live`, and every view is recorded.

## Saving the day's schedule

`/schedule` → **Export** → a CSV of the live schedule, including a `moved`
column. Opens straight in Excel with Thai text intact.

## If something looks wrong

| Symptom | What to do |
| ------- | ---------- |
| Header says **Reconnecting** / **Offline** | Check wifi. Screens keep counting from the last known end time and catch up automatically. Timer state is safe on the server. |
| Room screen frozen | Refresh it. It re-derives every countdown from the server; nothing is lost. |
| A timer looks wrong after a restart | It shouldn't be — running timers keep counting through a restart, paused ones stay frozen. Reset that table if it genuinely is wrong. |
| *"This cell changed in another tab"* | Another tab edited it. The grid reloads; try again. |
| A company appears twice at 14:00 | You pushed a queue up. Check the warning list and move one of them. |
| Wrong day on screen | `/control` → Event day. |
| Locked out of `/control` | Too many wrong passcodes; wait five minutes. |

**Never** edit the database by hand during the event. Every action above is
transactional and logged; direct edits are not.

## After the event

Export both days from `/schedule`. `operation_log` holds the full record of
resets, skips, completions, moves and imports.
