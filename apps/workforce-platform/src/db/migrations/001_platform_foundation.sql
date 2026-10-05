-- Names are intentionally prefixed with wf_ to allow side-by-side operation with PHP.
CREATE TABLE IF NOT EXISTS wf_schema_migrations (
  migration_name VARCHAR(190) NOT NULL PRIMARY KEY,
  checksum CHAR(64) NOT NULL,
  applied_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  legacy_user_id BIGINT UNSIGNED NULL,
  legacy_uid CHAR(6) NULL,
  username VARCHAR(64) NOT NULL,
  username_normalized VARCHAR(64) NOT NULL,
  email VARCHAR(254) NULL,
  email_normalized VARCHAR(254) NULL,
  password_hash VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_wf_users_legacy_user_id (legacy_user_id),
  UNIQUE KEY uq_wf_users_legacy_uid (legacy_uid),
  UNIQUE KEY uq_wf_users_username (username_normalized),
  UNIQUE KEY uq_wf_users_email (email_normalized),
  KEY ix_wf_users_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_roles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  role_key VARCHAR(64) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_wf_roles_key (role_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_permissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  permission_key VARCHAR(128) NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_wf_permissions_key (permission_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_user_roles (
  user_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id, role_id),
  CONSTRAINT fk_wf_user_roles_user FOREIGN KEY (user_id) REFERENCES wf_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_wf_user_roles_role FOREIGN KEY (role_id) REFERENCES wf_roles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_role_permissions (
  role_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_wf_role_permissions_role FOREIGN KEY (role_id) REFERENCES wf_roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_wf_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES wf_permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  CONSTRAINT fk_wf_sessions_user FOREIGN KEY (user_id) REFERENCES wf_users(id) ON DELETE CASCADE,
  KEY ix_wf_sessions_user_expiry (user_id, expires_at),
  KEY ix_wf_sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id BIGINT UNSIGNED NULL,
  action_key VARCHAR(96) NOT NULL,
  entity_type VARCHAR(64) NULL,
  entity_id VARCHAR(96) NULL,
  detail_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_wf_audit_actor FOREIGN KEY (actor_user_id) REFERENCES wf_users(id) ON DELETE SET NULL,
  KEY ix_wf_audit_actor_time (actor_user_id, created_at),
  KEY ix_wf_audit_action_time (action_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO wf_roles (role_key, display_name, created_at)
VALUES ('super_admin', 'Super administrator', UTC_TIMESTAMP(3)),
       ('user', 'User', UTC_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name);

INSERT INTO wf_permissions (permission_key, display_name, created_at)
VALUES ('identity.users.view', 'View user accounts', UTC_TIMESTAMP(3)),
       ('identity.users.manage', 'Manage user accounts', UTC_TIMESTAMP(3)),
       ('system.health.view', 'View system health', UTC_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name);

INSERT INTO wf_role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, UTC_TIMESTAMP(3)
  FROM wf_roles r
  JOIN wf_permissions p ON p.permission_key IN ('identity.users.view', 'identity.users.manage', 'system.health.view')
 WHERE r.role_key = 'super_admin'
ON DUPLICATE KEY UPDATE role_id = VALUES(role_id);
