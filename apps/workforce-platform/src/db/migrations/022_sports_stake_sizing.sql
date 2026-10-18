-- Phase 48 (row 14, slice 6): bounded, record-only stake sizing — DV-27.
--
-- `wf_sports_configurations` is append-only and versioned; every stored version gains
-- `staking_method` with DEFAULT 'FLAT', so every historical configuration row keeps the
-- only behaviour legacy ever had (the fixed `stake_amount` copied onto each ticket) and
-- means exactly what it meant before this migration. `CONFIDENCE_SCALED` sizes down from
-- the flat stake and is record-only: no ticket is ever executed.
--
-- No new table: the sized stake lives in the existing `wf_sports_tickets.stake` column,
-- settlement already computes P/L on it, and the breakdown is reconstructible from the
-- configuration version each ticket stores.

ALTER TABLE wf_sports_configurations
  ADD COLUMN staking_method VARCHAR(24) NOT NULL DEFAULT 'FLAT' AFTER stake_amount;
