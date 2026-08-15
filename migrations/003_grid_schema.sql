-- 003_grid_schema.sql
-- Adds the editable time x table grid on top of the queue engine.
--
-- Why an explicit slot table rather than deriving the grid from appointments:
-- an empty cell has no appointment row anywhere, and the real roster is full of
-- them (AMAZON_2 has zero appointments on 18 Aug, AMAZON_1 has 16 empty cells).
-- The grid therefore has to be stored, not inferred. Slots are also irregular -
-- the main grid breaks 12:00-13:00 and 15:30-15:45, while SHOPEE skips 10:50
-- and 14:50 and runs straight through the afternoon break - so they are seeded
-- literally in 005 rather than generated from a formula.

-- One row per cell position, shared by every table on that grid for that day.
-- A same-time move between two tables is then just an UPDATE of table_code.
CREATE TABLE IF NOT EXISTS time_slots (
  id         SERIAL PRIMARY KEY,
  event_date DATE     NOT NULL,
  grid_key   TEXT     NOT NULL CHECK (grid_key IN ('main', 'shopee')),
  slot_index SMALLINT NOT NULL,
  starts_at  TIME     NOT NULL,
  ends_at    TIME     NOT NULL,
  CONSTRAINT time_slots_index_uniq UNIQUE (event_date, grid_key, slot_index),
  CONSTRAINT time_slots_start_uniq UNIQUE (event_date, grid_key, starts_at)
);

-- Per-day identity of each physical table. The ten table_codes are stable for
-- the whole event; only the label and platform change between days, because
-- Profreight occupies exactly the two Alibaba positions on day 2.
CREATE TABLE IF NOT EXISTS table_days (
  event_date       DATE     NOT NULL,
  table_code       TEXT     NOT NULL REFERENCES matching_tables (table_code) ON UPDATE CASCADE,
  display_label    TEXT     NOT NULL,
  platform         TEXT     NOT NULL,
  grid_key         TEXT     NOT NULL CHECK (grid_key IN ('main', 'shopee')),
  duration_seconds INTEGER  NOT NULL CHECK (duration_seconds > 0),
  display_order    SMALLINT NOT NULL,
  is_active        BOOLEAN  NOT NULL DEFAULT TRUE,
  PRIMARY KEY (event_date, table_code)
);

CREATE INDEX IF NOT EXISTS table_days_date_order_idx ON table_days (event_date, display_order);

-- Grid position. slot_id IS NULL means "parked": still in the roster and in the
-- history, but not on the grid and deliberately not callable.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS slot_id          INTEGER REFERENCES time_slots (id);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS original_slot_id INTEGER REFERENCES time_slots (id);

-- Optimistic concurrency for the grid editor: two operator tabs editing the
-- same cell must collide loudly instead of silently overwriting each other.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;

-- Imported from the Master Schedule. These columns are operator-only and are
-- selected in exactly one place in the codebase (the contact reveal endpoint);
-- they must never appear in a payload sent to /display or /live.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS contact_names    TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS contact_emails   TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS province         TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS product_category TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS priority_group   TEXT;

-- The approved roster carries no queue numbers - identity there is
-- (date, table, start time). Numbers are still generated at import so /live has
-- something to search on, but they can no longer be mandatory.
ALTER TABLE appointments ALTER COLUMN queue_number DROP NOT NULL;
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_unique_queue;

CREATE UNIQUE INDEX IF NOT EXISTS appointments_queue_uniq
  ON appointments (event_date, table_code, queue_number)
  WHERE queue_number IS NOT NULL;

-- One appointment per cell.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_cell_uniq
  ON appointments (event_date, table_code, slot_id)
  WHERE slot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS appointments_slot_idx ON appointments (event_date, slot_id);

-- Durable grid counter. The in-memory revision in src/service.ts resets on
-- restart, which is fine for a snapshot but not for "has my grid gone stale".
ALTER TABLE event_settings ADD COLUMN IF NOT EXISTS grid_revision BIGINT NOT NULL DEFAULT 0;

-- Which day a timer row belongs to, so switching the active day can safely
-- clear stale current_appointment_id pointers.
ALTER TABLE timer_states ADD COLUMN IF NOT EXISTS event_date DATE;
