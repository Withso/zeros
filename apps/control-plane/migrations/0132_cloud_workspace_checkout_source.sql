-- zeros-migration: expand
-- Immutable source metadata accompanies the accepted Computer generation.
-- Older generations retain NULL; no mutable workspace selections are backfilled.
ALTER TABLE cloud_workspace_computer_sources
  ADD COLUMN checkout_source jsonb CHECK (
    checkout_source IS NULL OR (
      jsonb_typeof(checkout_source) = 'object'
      AND octet_length(checkout_source::text) <= 8192
    )
  );
