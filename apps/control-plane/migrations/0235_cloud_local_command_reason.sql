-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- An N-1 registration replaces instance_id, invalidating this capability
-- proof before a released desktop can receive an optional notice field.
ALTER TABLE local_command_devices ADD COLUMN reason_instance_id uuid;
