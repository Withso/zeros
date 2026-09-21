-- Bounded incremental replay. Durable conversation records remain authoritative
-- across engine replacement; replacing an engine invalidates this stream epoch.
CREATE TABLE cloud_workspace_event_streams (
  workspace_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  engine_instance_id uuid NOT NULL,
  head bigint NOT NULL DEFAULT 0 CHECK (head >= 0),
  first_retained bigint NOT NULL DEFAULT 1 CHECK (first_retained > 0 AND first_retained <= head + 1),
  last_batch_id uuid,
  last_batch_sha256 bytea CHECK (last_batch_sha256 IS NULL OR octet_length(last_batch_sha256) = 32),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, org_id),
  FOREIGN KEY (workspace_id, org_id) REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (engine_instance_id, workspace_id, generation, org_id)
    REFERENCES cloud_workspace_engine_instances(id, workspace_id, generation, org_id) ON DELETE RESTRICT
);
CREATE TABLE cloud_workspace_stream_events (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  frame jsonb NOT NULL CHECK (jsonb_typeof(frame) = 'object' AND octet_length(frame::text) <= 524288),
  encoded_bytes integer NOT NULL CHECK (encoded_bytes > 0 AND encoded_bytes <= 262144),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, sequence),
  FOREIGN KEY (workspace_id, org_id) REFERENCES cloud_workspace_event_streams(workspace_id, org_id) ON DELETE CASCADE
);
ALTER TABLE cloud_workspace_event_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_event_streams FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_stream_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_stream_events FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_event_streams_system ON cloud_workspace_event_streams
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY cloud_stream_events_system ON cloud_workspace_stream_events
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_workspace_event_streams,
  cloud_workspace_stream_events TO zeros_app;
