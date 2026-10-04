-- Install alongside canonical schema.mysql.sql. Kept separate temporarily because
-- existing deployments need an explicit reviewed migration.
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  last_login_at VARCHAR(32) NULL,
  username VARCHAR(64) NULL,
  user_uid CHAR(6) NULL,
  profile_image VARCHAR(255) NULL,
  INDEX idx_users_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS permissions (
  id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(96) NOT NULL UNIQUE, name VARCHAR(160) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS user_roles (user_id INT NOT NULL, role_id INT NOT NULL, PRIMARY KEY(user_id, role_id), INDEX idx_ur_role(role_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS role_permissions (role_id INT NOT NULL, permission_id INT NOT NULL, PRIMARY KEY(role_id, permission_id), INDEX idx_rp_permission(permission_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS auth_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, type VARCHAR(64) NOT NULL, detail LONGTEXT NULL, at VARCHAR(32) NOT NULL, INDEX idx_auth_events_user(user_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
