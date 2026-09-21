-- Provider identity is independent from the deployment's managed default.
-- Existing connections, generations and encrypted credential AAD are unchanged.
ALTER TABLE provider_connections
  DROP CONSTRAINT provider_connections_provider_check;
ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_provider_check
  CHECK (provider IN ('daytona', 'boat'));
