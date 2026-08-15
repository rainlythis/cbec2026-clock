-- 004_table_days.sql
-- Per-day roster for the two event days.
--
-- The ten table_codes from 002 are deliberately unchanged. Both matrix sheets
-- in the approved workbook carry the same eight columns in the same order; only
-- positions 7 and 8 change vendor, reading Alibaba-1/-2 on 17 Aug and
-- Profreight-1/-2 on 18 Aug. Profreight is Alibaba's group with a different
-- vendor, so it is the same physical table with a different label - not a new
-- table. Keeping the codes stable means the room display keeps its short
-- headings and every existing query keeps working.
--
-- AMAZON_2 has a column on the 18 Aug sheet but zero appointments, so it is
-- carried as inactive: the card still shows (as Closed) and the room grid stays
-- a tidy 4x2.

INSERT INTO table_days
  (event_date, table_code, display_label, platform, grid_key, duration_seconds, display_order, is_active)
VALUES
  -- Monday 17 August 2026
  ('2026-08-17', 'THPM',      'THAILANDPOSTMART-1', 'THAILANDPOSTMART', 'main',   900,  1, TRUE),
  ('2026-08-17', 'JD.com_1',  'JD.com-1',           'JD.com',           'main',   900,  2, TRUE),
  ('2026-08-17', 'JD.com_2',  'JD.com-2',           'JD.com',           'main',   900,  3, TRUE),
  ('2026-08-17', 'AMAZON_1',  'AMAZON-1',           'AMAZON',           'main',   900,  4, TRUE),
  ('2026-08-17', 'AMAZON_2',  'AMAZON-2',           'AMAZON',           'main',   900,  5, TRUE),
  ('2026-08-17', 'TMALL',     'TMALL-1',            'TMALL',            'main',   900,  6, TRUE),
  ('2026-08-17', 'ALIBABA_1', 'Alibaba-1',          'Alibaba',          'main',   900,  7, TRUE),
  ('2026-08-17', 'ALIBABA_2', 'Alibaba-2',          'Alibaba',          'main',   900,  8, TRUE),
  ('2026-08-17', 'SHOPEE_1',  'SHOPEE-1',           'SHOPEE',           'shopee', 600,  9, TRUE),
  ('2026-08-17', 'SHOPEE_2',  'SHOPEE-2',           'SHOPEE',           'shopee', 600, 10, TRUE),

  -- Tuesday 18 August 2026
  ('2026-08-18', 'THPM',      'THAILANDPOSTMART-1', 'THAILANDPOSTMART',     'main',   900,  1, TRUE),
  ('2026-08-18', 'JD.com_1',  'JD.com-1',           'JD.com',               'main',   900,  2, TRUE),
  ('2026-08-18', 'JD.com_2',  'JD.com-2',           'JD.com',               'main',   900,  3, TRUE),
  ('2026-08-18', 'AMAZON_1',  'AMAZON-1',           'AMAZON',               'main',   900,  4, TRUE),
  ('2026-08-18', 'AMAZON_2',  'AMAZON-2',           'AMAZON',               'main',   900,  5, FALSE),
  ('2026-08-18', 'TMALL',     'TMALL-1',            'TMALL',                'main',   900,  6, TRUE),
  ('2026-08-18', 'ALIBABA_1', 'Profreight-1',       'Profreight Logistics', 'main',   900,  7, TRUE),
  ('2026-08-18', 'ALIBABA_2', 'Profreight-2',       'Profreight Logistics', 'main',   900,  8, TRUE),
  ('2026-08-18', 'SHOPEE_1',  'SHOPEE-1',           'SHOPEE',               'shopee', 600,  9, TRUE),
  ('2026-08-18', 'SHOPEE_2',  'SHOPEE-2',           'SHOPEE',               'shopee', 600, 10, TRUE)
ON CONFLICT (event_date, table_code) DO UPDATE
  SET display_label    = EXCLUDED.display_label,
      platform         = EXCLUDED.platform,
      grid_key         = EXCLUDED.grid_key,
      duration_seconds = EXCLUDED.duration_seconds,
      display_order    = EXCLUDED.display_order,
      is_active        = EXCLUDED.is_active;

-- Stamp existing timer rows with the day they belong to.
UPDATE timer_states
   SET event_date = (SELECT active_event_date FROM event_settings WHERE id = 1)
 WHERE event_date IS NULL;
