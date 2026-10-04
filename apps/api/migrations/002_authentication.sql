-- Standalone Fastify authentication. Apply after 001_lead_discovery.sql.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
-- A deployment must set password_hash through an administrative bootstrap or identity provider;
-- no default password is embedded in this PostgreSQL migration.
