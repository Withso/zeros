-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Archiving is a presentation flag; the existing stop/wake lifecycle remains
-- authoritative for compute. Existing workspaces and ordinary idle stops stay
-- unarchived until the creator explicitly archives them.
ALTER TABLE cloud_v2_workspaces ADD COLUMN archived_at timestamptz;
