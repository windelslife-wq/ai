-- Lottery saved tickets (row 15, slice 3).
--
-- Two tables: the ticket record and its number lines (legacy
-- `lottery_tickets` + `lottery_ticket_lines`, spec §20/§29).
--
--   tickets <- (1:N) ticket_lines
--
-- A ticket on this platform is a RECORD of number lines a user chose or
-- generated — never a purchase, never a wager, never a paid entry. The schema
-- stores who keeps it, what lines it holds, which draw date it targets and —
-- after a check — what the stored VERIFIED draw actually matched:
--
--   status: OPEN -> CHECKED (a check found a draw and recorded the outcome)
--                -> ARCHIVED (a soft delete; nothing is ever hard-deleted here)
--
-- `result` holds the CHECKED outcome JSON: per-line match counts and the
-- OFFICIAL PRIZE TIER LABEL only. Prize AMOUNTS vary per draw and are never
-- stored or fabricated (spec §29) — there is no prize column, no cost column
-- and no payout column in this schema, which is the point of it.
--
-- `configuration` is the JSON the ticket was created with (generation
-- settings, notes); `generation_method` records HOW the lines were chosen
-- (MANUAL or one of the generator modes); `model_version` records the
-- generating model when there was one — legacy defaults it to the literal
-- 'MANUAL' when the caller did not say, and so does this port.
--
-- User isolation (spec §38) is a repository contract, not a UI rule:
-- `findLotteryTicket(id, userId)` and `listLotteryTickets(userId)` filter by
-- `user_id` in the statement itself, on both adapters, so a route cannot leak
-- another user's ticket by forgetting a WHERE clause.
--
-- Timestamps are VARCHAR(32) canonical UTC (`...Z`), matching migrations 007
-- through 017 (divergence AV-2 / SP-1 / LT-1). Additive only. No foreign keys
-- (the file adapter must implement the identical contract); ticket ids are
-- plain integers in the lines table.

CREATE TABLE IF NOT EXISTS wf_lottery_tickets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  lottery_code VARCHAR(32) NOT NULL,
  name VARCHAR(120) NOT NULL,
  draw_date DATE NULL,
  generation_method VARCHAR(32) NOT NULL,
  model_version VARCHAR(64) NOT NULL,
  configuration MEDIUMTEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  result MEDIUMTEXT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  KEY idx_lottery_tickets_user (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lottery_ticket_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  position INT NOT NULL,
  mains TEXT NOT NULL,
  stars TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_lottery_ticket_lines_ticket (ticket_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
