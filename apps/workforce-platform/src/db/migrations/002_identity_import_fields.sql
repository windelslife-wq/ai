-- Keep legacy profile fields beside the Node identity without mutating the
-- original PHP schema or baking a one-off layout into wf_users.
CREATE TABLE IF NOT EXISTS wf_user_profiles (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  display_name VARCHAR(120) NOT NULL,
  profile_image VARCHAR(255) NULL,
  last_login_at DATETIME(3) NULL,
  CONSTRAINT fk_wf_user_profiles_user FOREIGN KEY (user_id) REFERENCES wf_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_data_imports (
  import_key VARCHAR(100) NOT NULL PRIMARY KEY,
  source_checksum CHAR(64) NOT NULL,
  summary_json JSON NOT NULL,
  completed_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
