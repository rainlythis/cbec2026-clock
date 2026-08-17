-- 009_bare_clock_colors.sql
-- A colour per bare clock.
--
-- Stored as a name from a fixed palette, not a hex value. Three reasons:
-- the room screen needs every colour to stay legible on a white card, the board
-- should keep looking like one system rather than eight unrelated cards, and a
-- name can never carry a value that ends up interpolated into a stylesheet.
-- The hex for each name lives once, in public/css/bare-clock.css.
--
-- The colour is an identity, not a status: it paints the card border and the
-- clock's name, and the countdown digits keep their own bands (orange under
-- 5:00, red under 2:00). A clock can therefore be "the blue one" all day without
-- costing the room its time warning.

ALTER TABLE bare_clocks
  ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT 'ink';

ALTER TABLE bare_clocks
  DROP CONSTRAINT IF EXISTS bare_clocks_color_check;

ALTER TABLE bare_clocks
  ADD CONSTRAINT bare_clocks_color_check
  CHECK (color IN ('ink', 'coral', 'red', 'orange', 'green', 'blue', 'slate', 'purple'));
