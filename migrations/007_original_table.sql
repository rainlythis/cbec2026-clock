-- 007_original_table.sql
-- Remembers which table an appointment was imported onto.
--
-- `original_slot_id` alone cannot restore a moved appointment: a slot is shared
-- by every table on the same grid that day, so it records the row but not the
-- column. Both are needed for "reset the day back to the approved roster".
--
-- Backfilled from the current table, which is correct for every appointment
-- that has not been moved between tables yet. Anything already moved when this
-- migration runs adopts its current table as its origin - unavoidable, and
-- harmless before the event starts.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS original_table_code TEXT;

UPDATE appointments SET original_table_code = table_code WHERE original_table_code IS NULL;
