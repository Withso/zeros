-- Context suffixes are part of native model IDs used by the existing composer.
-- Keep exact matching, reject arbitrary bracket syntax, and retain the 256-byte
-- ASCII limit. Released migration 0084 remains unchanged.
ALTER TABLE cloud_agent_execution_leases
  DROP CONSTRAINT cloud_agent_execution_leases_model_check;
ALTER TABLE cloud_agent_execution_leases
  ADD CONSTRAINT cloud_agent_execution_leases_model_check CHECK (
    char_length(model) BETWEEN 1 AND 256
    AND model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*(\[1m\])?$'
  );
