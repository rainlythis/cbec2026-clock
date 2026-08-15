-- 006_short_labels.sql
-- Room-screen name for each table, per day.
--
-- The internal table_code is stable for the whole event, but the vendor at
-- positions 7 and 8 changes between days. Showing the code on the room screen
-- would caption a Profreight table "ALIBABA_1" on 18 August, so the display
-- needs its own per-day label - short enough to read across a hall, unlike the
-- full spreadsheet label (THAILANDPOSTMART-1 does not fit a 275px card).

ALTER TABLE table_days ADD COLUMN IF NOT EXISTS short_label TEXT;

UPDATE table_days SET short_label = CASE table_code
    WHEN 'THPM'      THEN 'THPM'
    WHEN 'JD.com_1'  THEN 'JD.com-1'
    WHEN 'JD.com_2'  THEN 'JD.com-2'
    WHEN 'AMAZON_1'  THEN 'AMAZON-1'
    WHEN 'AMAZON_2'  THEN 'AMAZON-2'
    WHEN 'TMALL'     THEN 'TMALL'
    WHEN 'SHOPEE_1'  THEN 'SHOPEE-1'
    WHEN 'SHOPEE_2'  THEN 'SHOPEE-2'
    -- positions 7 and 8 follow the day's vendor
    WHEN 'ALIBABA_1' THEN CASE WHEN event_date = DATE '2026-08-18' THEN 'Profreight-1' ELSE 'Alibaba-1' END
    WHEN 'ALIBABA_2' THEN CASE WHEN event_date = DATE '2026-08-18' THEN 'Profreight-2' ELSE 'Alibaba-2' END
    ELSE table_code
  END
 WHERE short_label IS NULL;

ALTER TABLE table_days ALTER COLUMN short_label SET NOT NULL;
