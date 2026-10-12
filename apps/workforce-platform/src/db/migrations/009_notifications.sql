-- Operator notifications (row 5 of docs/migration/UNFINISHED_MODULES.md).
--
-- Ports the legacy `notifications` table (`application/database/schema.mysql.sql`
-- line 232) and the `Aegis\Persistence\NotificationRepository` semantics
-- implemented in `application/models/Aegis_model.php`.
--
-- Two legacy properties are deliberately preserved rather than "improved":
--
--  1. `user_id NULL` means BROADCAST — visible to every signed-in operator. A
--     signed-in operator sees broadcasts plus their own targeted rows. That is
--     the whole visibility rule; there is no team or role scoping.
--  2. `read_at` is a single column on the row, not a per-recipient table, so
--     read state is GLOBAL: once any operator marks a broadcast read it is read
--     for all of them. The legacy repository behaves exactly this way
--     (`markRead` updates the matched row). Changing it to per-recipient read
--     state is a product decision that needs its own migration and its own
--     approval; it is recorded as divergence NV-2 in the phase notes instead of
--     being silently "fixed" here.
--
-- Dedupe: while an UNREAD row with a given `dedupe_key` exists, a new publish
-- with that key is skipped, so a recurring risk alert produces one unread badge
-- until an operator acknowledges it rather than one per scan.
--
-- Additive only: nothing here alters an existing table. No broker, order or
-- live-execution column is introduced; a notification is a message about
-- something that already happened and can never itself route an order.

CREATE TABLE IF NOT EXISTS wf_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- NULL = broadcast to every operator.
  user_id BIGINT UNSIGNED NULL,
  type VARCHAR(40) NOT NULL,
  severity VARCHAR(10) NOT NULL DEFAULT 'info',
  title VARCHAR(200) NOT NULL,
  detail_json LONGTEXT NOT NULL,
  dedupe_key VARCHAR(120) NULL,
  read_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_wf_notifications_user
    FOREIGN KEY (user_id) REFERENCES wf_users(id)
    ON DELETE CASCADE,
  -- The inbox query and the dedupe check are the only two reads this table gets.
  KEY ix_wf_notifications_inbox (user_id, read_at, created_at),
  KEY ix_wf_notifications_dedupe (dedupe_key, read_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
