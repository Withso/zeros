-- Additive: old backends ignore native operation receipts. Existing workspace
-- RLS and zeros_app table grants also cover this nullable column.
ALTER TABLE cloud_workspace_commands
  ADD COLUMN IF NOT EXISTS result jsonb
  CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536));

-- Only the migration owner can qualify features for an exact image/auth kind.
-- The existing read-only zeros_app grant and RLS continue to apply.
ALTER TABLE cloud_agent_runtime_qualifications
  ADD COLUMN IF NOT EXISTS native_capabilities jsonb
  CHECK (native_capabilities IS NULL OR (jsonb_typeof(native_capabilities) = 'object' AND octet_length(native_capabilities::text) <= 1024));
