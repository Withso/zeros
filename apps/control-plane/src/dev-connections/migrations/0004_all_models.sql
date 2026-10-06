-- Owner-scoped Dev consent has the same explicit semantics as cloud grants.
ALTER TABLE dev_connections.organization_consents
  ADD COLUMN all_models boolean NOT NULL DEFAULT false;
