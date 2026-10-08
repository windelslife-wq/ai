-- Account management, session device labels and legacy RBAC parity.
-- Additive only: nothing here drops or rewrites existing data, so the migration
-- is safe to apply to a database that already holds imported identity rows.
ALTER TABLE wf_sessions ADD COLUMN device_label VARCHAR(120) NULL AFTER expires_at;

CREATE INDEX ix_wf_sessions_user_revoked ON wf_sessions (user_id, revoked_at);

CREATE INDEX ix_wf_users_username_lookup ON wf_users (username);

CREATE INDEX ix_wf_audit_entity ON wf_audit_events (entity_type, entity_id, created_at);

-- The legacy platform seeds 8 roles and 10 permissions (tools/rbac.php). The
-- foundation seeded only 3 permissions, so ported modules would have had no
-- vocabulary to check against. Keys and display names are copied verbatim.
INSERT INTO wf_roles (role_key, display_name, created_at)
VALUES ('super_admin', 'Super administrator', UTC_TIMESTAMP(3)),
       ('sports_admin', 'Sports administrator', UTC_TIMESTAMP(3)),
       ('sports_viewer', 'Sports viewer', UTC_TIMESTAMP(3)),
       ('trading_operator', 'Trading operator (control + execution)', UTC_TIMESTAMP(3)),
       ('trading_viewer', 'Trading viewer (read-only)', UTC_TIMESTAMP(3)),
       ('lottery_admin', 'Lottery administrator', UTC_TIMESTAMP(3)),
       ('lottery_viewer', 'Lottery viewer', UTC_TIMESTAMP(3)),
       ('platform_member', 'Platform member', UTC_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name);

INSERT INTO wf_permissions (permission_key, display_name, created_at)
VALUES ('system.super_admin', 'Full platform administration', UTC_TIMESTAMP(3)),
       ('system.authenticated', 'Signed-in member baseline', UTC_TIMESTAMP(3)),
       ('sports.view', 'View sports intelligence', UTC_TIMESTAMP(3)),
       ('sports.manage', 'Manage sports providers and configuration', UTC_TIMESTAMP(3)),
       ('sports.approve', 'Approve sports tickets', UTC_TIMESTAMP(3)),
       ('sports.settle', 'Override sports settlements', UTC_TIMESTAMP(3)),
       ('trading.view', 'View trading status, proposals and executions', UTC_TIMESTAMP(3)),
       ('trading.control', 'Kill switch, trading mode, risk and automation limits', UTC_TIMESTAMP(3)),
       ('trading.execute', 'Propose, approve and route trades through the Execution Supervisor', UTC_TIMESTAMP(3)),
       ('lottery.view', 'View lottery intelligence (draws, statistics, tickets, performance)', UTC_TIMESTAMP(3)),
       ('lottery.manage', 'Manage lottery providers, data sync and configuration', UTC_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name);

-- Role grants, identical to the legacy matrix. super_admin receives every
-- permission, and permission checks treat it as a wildcard (Identity::can()).
INSERT INTO wf_role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, UTC_TIMESTAMP(3)
  FROM wf_roles r
  JOIN wf_permissions p ON p.permission_key IN (
    'system.super_admin', 'system.authenticated', 'sports.view', 'sports.manage', 'sports.approve',
    'sports.settle', 'trading.view', 'trading.control', 'trading.execute', 'lottery.view', 'lottery.manage',
    'identity.users.view', 'identity.users.manage', 'system.health.view'
  )
 WHERE r.role_key = 'super_admin'
ON DUPLICATE KEY UPDATE created_at = VALUES(created_at);

INSERT INTO wf_role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, UTC_TIMESTAMP(3)
  FROM wf_roles r
  JOIN wf_permissions p ON p.permission_key IN ('sports.view', 'sports.manage', 'sports.approve', 'sports.settle')
 WHERE r.role_key = 'sports_admin'
ON DUPLICATE KEY UPDATE created_at = VALUES(created_at);

INSERT INTO wf_role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, UTC_TIMESTAMP(3)
  FROM wf_roles r
  JOIN wf_permissions p ON p.permission_key IN ('sports.view')
 WHERE r.role_key = 'sports_viewer'
ON DUPLICATE KEY UPDATE created_at = VALUES(created_at);

INSERT INTO wf_role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, UTC_TIMESTAMP(3)
  FROM wf_roles r
  JOIN wf_permissions p ON p.permission_key IN ('trading.view', 'trading.control', 'trading.execute')
 WHERE r.role_key = 'trading_operator'
ON DUPLICATE KEY UPDATE created_at = VALUES(created_at);

INSERT INTO wf_role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, UTC_TIMESTAMP(3)
  FROM wf_roles r
  JOIN wf_permissions p ON p.permission_key IN ('trading.view')
 WHERE r.role_key = 'trading_viewer'
ON DUPLICATE KEY UPDATE created_at = VALUES(created_at);

INSERT INTO wf_role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, UTC_TIMESTAMP(3)
  FROM wf_roles r
  JOIN wf_permissions p ON p.permission_key IN ('lottery.view', 'lottery.manage')
 WHERE r.role_key = 'lottery_admin'
ON DUPLICATE KEY UPDATE created_at = VALUES(created_at);

INSERT INTO wf_role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, UTC_TIMESTAMP(3)
  FROM wf_roles r
  JOIN wf_permissions p ON p.permission_key IN ('lottery.view')
 WHERE r.role_key = 'lottery_viewer'
ON DUPLICATE KEY UPDATE created_at = VALUES(created_at);

INSERT INTO wf_role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, UTC_TIMESTAMP(3)
  FROM wf_roles r
  JOIN wf_permissions p ON p.permission_key IN ('trading.view', 'sports.view', 'lottery.view')
 WHERE r.role_key = 'platform_member'
ON DUPLICATE KEY UPDATE created_at = VALUES(created_at);
