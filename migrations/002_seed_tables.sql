-- 002_seed_tables.sql
-- The ten fixed matching tables, their durations, and one timer row each.
-- Idempotent: safe to re-run on an existing production database.

INSERT INTO event_settings (id, event_name, active_event_date, timezone)
VALUES (1, 'TOPTHAI Day Business Matching Live', DATE '2026-08-17', 'Asia/Bangkok')
ON CONFLICT (id) DO NOTHING;

INSERT INTO matching_tables (table_code, platform, duration_seconds, zone, display_order) VALUES
  ('THPM',      'THPM',     900, 'main',    1),
  ('JD.com_1',  'JD.com',   900, 'main',    2),
  ('JD.com_2',  'JD.com',   900, 'main',    3),
  ('TMALL',     'TMALL',    900, 'main',    4),
  ('AMAZON_1',  'AMAZON',   900, 'main',    5),
  ('AMAZON_2',  'AMAZON',   900, 'main',    6),
  ('ALIBABA_1', 'ALIBABA',  900, 'main',    7),
  ('ALIBABA_2', 'ALIBABA',  900, 'main',    8),
  ('SHOPEE_1',  'SHOPEE',   600, 'shopee',  9),
  ('SHOPEE_2',  'SHOPEE',   600, 'shopee', 10)
ON CONFLICT (table_code) DO UPDATE
  SET platform         = EXCLUDED.platform,
      duration_seconds = EXCLUDED.duration_seconds,
      zone             = EXCLUDED.zone,
      display_order    = EXCLUDED.display_order;

INSERT INTO timer_states (table_code, timer_status, duration_seconds)
SELECT t.table_code, 'ready', t.duration_seconds
FROM matching_tables t
ON CONFLICT (table_code) DO NOTHING;
