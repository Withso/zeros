-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'legacy';
