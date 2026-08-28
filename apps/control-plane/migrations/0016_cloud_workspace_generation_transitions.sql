-- ───────────────────────────────────────────────────────────
-- 0016 — Fenced cloud-workspace generation replacement
--
-- Lifecycle work must retain the generation selected when the request was
-- recorded. Joining an intent to a workspace's later current_generation can
-- dispatch a reclaimed request against the wrong provider resource. Generation
-- transitions also need a durable source/candidate record so setup failure can
-- restore the last qualified generation and independently retire the rejected
-- provider resource.
-- ───────────────────────────────────────────────────────────

CREATE TYPE cloud_workspace_generation_transition_operation AS ENUM (
  'upgrade',
  'rollback'
);

CREATE TYPE cloud_workspace_generation_transition_state AS ENUM (
  'draining',
  'provisioning',
  'setting_up',
  'rolling_back',
  'succeeded',
  'rolled_back',
  'rollback_failed',
  'cancelled'
);

ALTER TABLE cloud_workspace_lifecycle_intents
  ADD COLUMN generation integer,
  ADD COLUMN affects_workspace boolean NOT NULL DEFAULT true;

UPDATE cloud_workspace_lifecycle_intents i
SET generation = cw.current_generation
FROM cloud_workspaces cw
WHERE cw.id = i.workspace_id AND cw.org_id = i.org_id;

ALTER TABLE cloud_workspace_lifecycle_intents
  ALTER COLUMN generation SET NOT NULL,
  ADD CONSTRAINT cloud_workspace_lifecycle_intents_generation_check
    CHECK (generation > 0),
  ADD CONSTRAINT cloud_workspace_lifecycle_intents_generation_fkey
    FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT cloud_workspace_lifecycle_intents_scope_check
    CHECK (affects_workspace OR operation IN ('stop', 'delete'));

-- Keep direct/internal INSERT callers compatible while ensuring the selected
-- generation is materialized before dispatch. Public routes still provide the
-- generation explicitly; this trigger protects migration-era and recovery SQL.
CREATE FUNCTION bind_cloud_workspace_intent_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.generation IS NULL THEN
    SELECT cw.current_generation INTO NEW.generation
    FROM cloud_workspaces cw
    WHERE cw.id = NEW.workspace_id AND cw.org_id = NEW.org_id;
  END IF;
  IF NEW.generation IS NULL THEN
    RAISE EXCEPTION 'cloud workspace lifecycle intent generation is required'
      USING ERRCODE = '23502';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_workspace_lifecycle_intents_bind_generation
  BEFORE INSERT ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION bind_cloud_workspace_intent_generation();

CREATE TABLE cloud_workspace_generation_transitions (
  id                     uuid PRIMARY KEY,
  workspace_id           uuid NOT NULL,
  org_id                 uuid NOT NULL,
  requested_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  operation              cloud_workspace_generation_transition_operation
                         NOT NULL,
  -- The current generation displaced by this operation.
  source_generation      integer NOT NULL CHECK (source_generation > 0),
  -- The immutable inputs copied into the candidate. For an upgrade this is
  -- normally source_generation; an explicit rollback can select an older,
  -- previously qualified generation.
  template_generation    integer NOT NULL CHECK (template_generation > 0),
  candidate_generation   integer NOT NULL CHECK (candidate_generation > 0),
  state                  cloud_workspace_generation_transition_state NOT NULL,
  drain_intent_id        uuid UNIQUE
                         REFERENCES cloud_workspace_lifecycle_intents(id)
                         ON DELETE RESTRICT,
  provision_intent_id    uuid UNIQUE
                         REFERENCES cloud_workspace_lifecycle_intents(id)
                         ON DELETE RESTRICT,
  error_code             text CHECK (
                           error_code IS NULL OR char_length(error_code) <= 128
                         ),
  error_message          text CHECK (
                           error_message IS NULL
                           OR char_length(error_message) <= 2048
                         ),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  UNIQUE (workspace_id, candidate_generation),
  UNIQUE (id, workspace_id, org_id),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, template_generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, candidate_generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE RESTRICT,
  CHECK (candidate_generation > source_generation),
  CHECK (template_generation <= source_generation),
  CHECK (
    (state IN ('succeeded', 'rolled_back', 'rollback_failed', 'cancelled')
      AND completed_at IS NOT NULL)
    OR
    (state IN ('draining', 'provisioning', 'setting_up', 'rolling_back')
      AND completed_at IS NULL)
  ),
  CHECK (drain_intent_id IS NOT NULL OR provision_intent_id IS NOT NULL),
  CHECK (
    (state <> 'draining')
    OR (drain_intent_id IS NOT NULL AND provision_intent_id IS NULL)
  ),
  CHECK (
    state NOT IN ('provisioning', 'setting_up', 'succeeded')
    OR provision_intent_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX cloud_workspace_generation_transition_active_idx
  ON cloud_workspace_generation_transitions (workspace_id)
  WHERE state IN ('draining', 'provisioning', 'setting_up', 'rolling_back');
CREATE INDEX cloud_workspace_generation_transition_org_idx
  ON cloud_workspace_generation_transitions (
    org_id, workspace_id, created_at DESC, id
  );

ALTER TABLE cloud_workspace_lifecycle_intents
  ADD COLUMN generation_transition_id uuid,
  ADD CONSTRAINT cloud_workspace_lifecycle_intents_transition_fkey
    FOREIGN KEY (generation_transition_id, workspace_id, org_id)
    REFERENCES cloud_workspace_generation_transitions(id, workspace_id, org_id)
    ON DELETE RESTRICT;

ALTER TABLE cloud_workspace_generation_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY cloud_workspace_generation_transitions_read
  ON cloud_workspace_generation_transitions FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY cloud_workspace_generation_transitions_system
  ON cloud_workspace_generation_transitions FOR ALL
  USING (app_is_system())
  WITH CHECK (app_is_system());

ALTER TABLE cloud_workspace_generation_transitions FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON cloud_workspace_generation_transitions
  TO zeros_app;
