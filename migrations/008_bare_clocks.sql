-- 008_bare_clocks.sql
-- Standalone countdown clocks for /Bare_Clock and /Bare_Clock_Control.
--
-- Deliberately its own table with no reference to matching_tables, table_days,
-- time_slots or appointments. The bare clock is a plain countdown board: it has
-- no queue, no company, no roster and no event day, so renaming a clock or
-- typing a new length on it can never touch the approved schedule or the room
-- display. That isolation is the whole point of the feature - the operator can
-- rehearse with it, or run an unrelated session on it, while the matching event
-- is live on /display.
--
-- The timer columns mirror timer_states so the same pure maths in src/timer.ts
-- drives both: `ends_at` is authoritative while running,
-- `paused_remaining_seconds` while paused or adjusted-but-not-started. Nothing
-- decrements a stored number.
--
-- 'break' and 'closed' are absent from the status check: they belong to a
-- physical matching table, not to a bare clock, which is only ever ready,
-- running, paused or finished.

CREATE TABLE IF NOT EXISTS bare_clocks (
  id                       SERIAL PRIMARY KEY,
  label                    TEXT    NOT NULL,
  -- Upper bound matches MAX_REMAINING_SECONDS in src/timer.ts (six hours), so a
  -- mistyped "600" minutes is refused by the database as well as the service.
  duration_seconds         INTEGER NOT NULL CHECK (duration_seconds > 0 AND duration_seconds <= 21600),
  timer_status             TEXT    NOT NULL DEFAULT 'ready'
    CHECK (timer_status IN ('ready', 'running', 'paused', 'timeup')),
  started_at               TIMESTAMPTZ,
  ends_at                  TIMESTAMPTZ,
  paused_remaining_seconds INTEGER,
  timeup_at                TIMESTAMPTZ,
  display_order            INTEGER NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bare_clocks_order_idx ON bare_clocks (display_order, id);

-- Seeded with the ten platforms of the event so the board is useful on first
-- open, but they are ordinary rows: the operator may rename or delete any of
-- them. Guarded so this never re-adds a clock somebody deleted.
INSERT INTO bare_clocks (label, duration_seconds, display_order)
SELECT * FROM (VALUES
  ('THPM',       900,  1),
  ('JD.com-1',   900,  2),
  ('JD.com-2',   900,  3),
  ('AMAZON-1',   900,  4),
  ('AMAZON-2',   900,  5),
  ('TMALL',      900,  6),
  ('Alibaba-1',  900,  7),
  ('Alibaba-2',  900,  8),
  ('SHOPEE-1',   600,  9),
  ('SHOPEE-2',   600, 10)
) AS seed (label, duration_seconds, display_order)
WHERE NOT EXISTS (SELECT 1 FROM bare_clocks);
