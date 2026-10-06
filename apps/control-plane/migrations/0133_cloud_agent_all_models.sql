-- zeros-migration: expand
-- Existing explicit lists remain restrictive. Only a credential owner may
-- consent to future qualified models for their own use.
ALTER TABLE cloud_agent_credential_delegations
  ADD COLUMN all_models boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT cloud_agent_delegation_all_models_self
    CHECK (NOT all_models OR owner_user_id = grantee_user_id);
ALTER TABLE cloud_agent_organization_connections
  ADD COLUMN all_models boolean NOT NULL DEFAULT false;
