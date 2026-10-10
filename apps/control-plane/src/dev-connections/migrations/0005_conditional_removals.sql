-- Only the broker may attest that a frozen source was removed. A lost response
-- repeats the original result without revoking a later replacement/consent.
CREATE TABLE dev_connections.removal_receipts (
  generation_id uuid NOT NULL REFERENCES dev_connections.generations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES dev_connections.members(id) ON DELETE CASCADE,
  organization text NOT NULL,
  operation_id uuid NOT NULL,
  request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object' AND octet_length(response::text)<=2048),
  PRIMARY KEY(generation_id,member_id,organization,operation_id)
);
ALTER TABLE dev_connections.removal_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_connections.removal_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY broker_only ON dev_connections.removal_receipts TO zeros_app
  USING(current_setting('dev_connections.authority',true)='broker')
  WITH CHECK(current_setting('dev_connections.authority',true)='broker');
GRANT SELECT,INSERT,DELETE ON dev_connections.removal_receipts TO zeros_app;
