# Importing the roster

## Source of truth

The workbook seeds the database **once**. After that the web grid is the source
of truth: re-importing would discard live event changes, so the CLI refuses if
appointments already exist for those dates unless you pass `--force`.

```bash
npm run import:xlsx -- "Final Matching Data.xlsx"
npm run import:xlsx -- "Final Matching Data.xlsx" --force   # replace anyway
```

Nothing is written unless every row validates.

## What is read

Only the **`Master Schedule`** sheet. The four matrix sheets are an exact pivot
of it (verified 177/177 cells for Monday) and it is the only sheet carrying
contact details.

| Column | Required | Notes |
| ------ | -------- | ----- |
| `Date` | yes | must be 2026-08-17 or 2026-08-18 |
| `Start Time`, `End Time` | yes | must match a slot on that table's grid |
| `Platform` | yes | falls back to the table's platform |
| `Table` | yes | see the alias map below |
| `Company Name` | yes | |
| `Contact Name(s)`, `Email Address(es)` | no | operator-only |
| `Province`, `Product Category`, `Priority Group` | no | operator-only |
| `Duration (min)` | yes | must match the table (15, or 10 for SHOPEE) |

`Day`, `Priority Source Row`, `Status`, `Source Platform Sheet` and
`Source Row(s)` are ignored.

## Table alias map

| Workbook label | Internal code |
| -------------- | ------------- |
| `THAILANDPOSTMART-1` | `THPM` |
| `JD.com-1` / `JD.com-2` | `JD.com_1` / `JD.com_2` |
| `AMAZON-1` / `AMAZON-2` | `AMAZON_1` / `AMAZON_2` |
| `TMALL-1` | `TMALL` |
| `Alibaba-1` / `Alibaba-2` | `ALIBABA_1` / `ALIBABA_2` |
| **`Profreight-1` / `Profreight-2`** | **`ALIBABA_1` / `ALIBABA_2`** |
| `SHOPEE-1` / `SHOPEE-2` | `SHOPEE_1` / `SHOPEE_2` |

Alibaba and Profreight map to the same codes because they are the same two
physical tables with a different vendor on each day. They never collide because
they never share a date, and each row is validated against `table_days` for
**its own date** — an `Alibaba-1` row dated 18 Aug is rejected.

## Validation

Reported per row with its spreadsheet line number:

- date missing, malformed, or outside the event;
- time not parseable, or not a slot on that table's grid (`10:50` is a SHOPEE
  gap and never a main-grid slot);
- unknown table label;
- table doesn't trade that day, or is marked closed;
- duration doesn't match the table;
- two companies booked into the same cell;
- missing company name.

A row whose start time matches no slot is imported **parked** rather than
dropped: it appears in the operator's parked tray and is not callable.

## Excel value quirks handled

- Dates arrive as UTC-midnight `Date` objects; read with UTC getters, or an
  evening date shifts a day under `TZ=Asia/Bangkok`.
- Times arrive as `1899-12-30T10:00:00Z` or as serial fractions
  (`0.41666666666666663` = 10:00). Both are handled and rounded to the minute.
- Cells can be rich-text or formula objects, not plain strings.

## Queue numbers

The workbook has none. They are generated as `<letter><index>` from the table's
`display_order` and the appointment's **original** slot:

```
THPM → A001…A023      SHOPEE-1 → I001…I034
JD.com-1 → B001…      SHOPEE-2 → J001…J034
```

Derived from the original slot on purpose: pushing a queue up never renumbers
anybody, so a queue number stays valid all day. `queue_number` is nullable and
clients fall back to the scheduled time.

## What a fresh import produced

| | Day 1 (17 Aug) | Day 2 (18 Aug) |
| --- | --- | --- |
| appointments | 245 | 170 |
| tables with bookings | 10 | 9 (no `AMAZON-2`) |
| parked | 0 | 0 |

Total 415 rows, 159 distinct companies, all with contacts.

## CSV fallback

The older CSV importer (`/control` → **Import CSV**, and
`POST /api/control/schedule/import`) still works and is unchanged. It uses
`data/schedule_template.csv`'s column set and is useful if you only have a CSV.
The xlsx path is the one to use for the approved workbook.

## Export

`/schedule` → **Export**, or `GET /api/control/grid/export.csv?date=`.

UTF-8 with a BOM so Excel opens Thai correctly, and it round-trips back through
this project's own CSV parser (which strips the BOM). Contact columns are
**not** exported: they never change during the event, you still have the
original workbook, and leaving them out keeps the guarantee that exactly one
function ever returns a contact value.
