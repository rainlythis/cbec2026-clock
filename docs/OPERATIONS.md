# Event-day runbook

For the operator. Everything here is done from `/control` (timers) and
`/schedule` (the grid), signed in with the passcode.

## Before doors open

1. Open `/control`, sign in, confirm **Event day** is today's date.
2. Open `/schedule` and check the grid against your spreadsheet. During the day
   this page highlights whoever is at each table, with their live countdown —
   press **Jump to now** to scroll straight to them.
3. Put `/display` on the room screen and press **F11** for fullscreen.
4. Print or show the QR (bottom-right of the room screen). **Check the URL printed
   beside it is your real address, not localhost** — that text is read back from
   the QR image itself, so if it looks right, the code is right.
5. Leave **Room sound: Off** unless you want a chime at 00:00.
6. **If you rehearsed, press Fresh Day** on `/control` and type `RESET`. That
   clears the practice run completely — see below.

Each table starts **Ready** with no company loaded. Press **Load First** on each
table to call up its first company. (That button becomes **Complete & Next**
once somebody is at the table — it is the same button doing the same job.)

## Running a meeting

| You want to | Do this |
| ----------- | ------- |
| Start | **Play** |
| Pause | the same button, now reading **Pause** |
| Resume | the same button, now reading **Resume** |
| Put the clock back to full | **Reset** (confirms; does not change the queue) |
| Finish and load the next | **Complete & Next** |
| Undo that — go back a company | **↩** (pause the timer first) |
| Give them more time | ⋯ → **Add one minute** |

The next meeting never starts by itself. After Complete & Next the timer sits at
Ready until you press Play.

At 00:00 the digits go red, pulse for ten seconds, then hold steady. The meeting
is not ended for you.

## Clearing a rehearsal — Fresh Day

`/control` → **Fresh Day** → type `RESET`.

The active day goes back to never-run: every company waiting again in the slot
they were imported into, every timer at its full duration, nobody loaded at any
table. Use it once on the morning of the event after testing.

- It **discards** that day's completed and skipped meetings, and **undoes**
  changes made on the schedule grid — including a queue you pushed up.
- It **keeps** the roster itself and the operation log.
- It **never touches** the other event day.
- It is the only button on the page that cannot be undone by pressing it again,
  which is why it asks you to type the word.

Afterwards the schedule grid matches the approved workbook exactly again.

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

## You advanced a table by mistake

Press **↩** on that table. The last company you completed or skipped comes back
to the table and whoever was loaded returns to the queue. It is fully
reversible — press **Complete & Next** again to undo the undo. The timer must be
paused first.

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
| **Complete & Next** looks greyed out | Only happens when that table's queue is finished, or the table is closed for the day. On an empty table it reads **Load First** and is clickable. |
| **↩** greyed out | Pause the timer first, or there is nothing to go back to yet at that table. |
| QR points at localhost | `PUBLIC_BASE_URL` is set to a stale value in Railway. Clear it (the QR then uses the real address automatically) or set it to the live URL. |
| Locked out of `/control` | Too many wrong passcodes; wait five minutes. |
| Fresh Day says it is not the day in the room | It only ever resets the day currently showing. Switch **Event day** first, then reset. |
| A deploy went out but the page behaves as before | Hard-refresh that tab (**⌘⇧R** / **Ctrl+F5**). Assets now revalidate on every load, but a tab left open since before the deploy is still running the JavaScript it loaded then. Refresh long-lived screens after any deploy. |

**Never** edit the database by hand during the event. Every action above is
transactional and logged; direct edits are not.

## After the event

Export both days from `/schedule`. `operation_log` holds the full record of
resets, skips, completions, moves and imports.
