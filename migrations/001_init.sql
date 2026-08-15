-- 001_init.sql
-- Core schema for TOPTHAI Day Business Matching Live.
-- Deliberately minimal: five tables, no user/account system.

CREATE TABLE IF NOT EXISTS event_settings (
  id                 SMALLINT PRIMARY KEY DEFAULT 1,
  event_name         TEXT        NOT NULL DEFAULT 'TOPTHAI Day Business Matching Live',
  active_event_date  DATE        NOT NULL DEFAULT DATE '2026-08-17',
  timezone           TEXT        NOT NULL DEFAULT 'Asia/Bangkok',
  sound_enabled      BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_settings_singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS matching_tables (
  table_code       TEXT PRIMARY KEY,
  platform         TEXT    NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  zone             TEXT    NOT NULL CHECK (zone IN ('main', 'shopee')),
  display_order    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id                 SERIAL PRIMARY KEY,
  event_date         DATE    NOT NULL,
  scheduled_start    TIME    NOT NULL,
  scheduled_end      TIME    NOT NULL,
  platform           TEXT    NOT NULL,
  table_code         TEXT    NOT NULL REFERENCES matching_tables (table_code) ON UPDATE CASCADE,
  queue_number       TEXT    NOT NULL,
  company_name       TEXT    NOT NULL,
  appointment_status TEXT    NOT NULL DEFAULT 'scheduled'
    CHECK (appointment_status IN ('scheduled','arrived','called','in_meeting','completed','skipped','no_show')),
  arrival_status     TEXT    NOT NULL DEFAULT 'not_arrived'
    CHECK (arrival_status IN ('not_arrived','arrived')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT appointments_unique_queue UNIQUE (event_date, table_code, queue_number)
);

CREATE INDEX IF NOT EXISTS appointments_date_table_idx
  ON appointments (event_date, table_code, scheduled_start, queue_number);

-- Authoritative timer state. Never decremented by a background job:
-- `ends_at` is the single source of truth while running, and
-- `paused_remaining_seconds` while paused/ready-with-adjustment.
CREATE TABLE IF NOT EXISTS timer_states (
  table_code               TEXT PRIMARY KEY REFERENCES matching_tables (table_code) ON UPDATE CASCADE,
  timer_status             TEXT    NOT NULL DEFAULT 'ready'
    CHECK (timer_status IN ('ready','running','paused','timeup','break','closed')),
  duration_seconds         INTEGER NOT NULL CHECK (duration_seconds > 0),
  started_at               TIMESTAMPTZ,
  ends_at                  TIMESTAMPTZ,
  paused_remaining_seconds INTEGER,
  current_appointment_id   INTEGER REFERENCES appointments (id) ON DELETE SET NULL,
  timeup_at                TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operation_log (
  id             BIGSERIAL PRIMARY KEY,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor          TEXT NOT NULL DEFAULT 'operator',
  action         TEXT NOT NULL,
  table_code     TEXT,
  appointment_id INTEGER,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS operation_log_occurred_idx ON operation_log (occurred_at DESC);
