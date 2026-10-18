-- zeros-migration: expand
-- Cooperative SIGTERM handoff only. A running claim without this checkpoint
-- still expires normally; it must never be stolen in the middle of a clone.
-- Keep state='running' so N-1 claimers cannot restart a handed-off build, even
-- after its builder has stopped. It continues to occupy its original slot.
ALTER TABLE cloud_computer_v2_builds
  ADD COLUMN helper_fence bigint CHECK(helper_fence>0 AND helper_fence<=worker_fence),
  ADD COLUMN handoff_at timestamptz,
  ADD COLUMN install_started boolean NOT NULL DEFAULT false,
  ADD COLUMN install_log_after bigint NOT NULL DEFAULT 0 CHECK(install_log_after BETWEEN 0 AND 9007199254740991),
  ADD COLUMN install_log_discard_streams text[] NOT NULL DEFAULT '{}'
    CHECK(install_log_discard_streams <@ ARRAY['stdout','stderr']::text[] AND cardinality(install_log_discard_streams)<=2),
  ADD CONSTRAINT cloud_computer_build_handoff_checkpoint CHECK(handoff_at IS NULL OR (
    state<>'queued' AND stage NOT IN ('queued','done') AND helper_fence IS NOT NULL
    AND base_image_id IS NOT NULL AND runtime_id IS NOT NULL AND started_at IS NOT NULL AND deadline_at IS NOT NULL));

CREATE INDEX cloud_computer_build_handoffs ON cloud_computer_v2_builds(handoff_at,id)
  WHERE state='running' AND handoff_at IS NOT NULL;

CREATE FUNCTION cloud_computer_build_handoff_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.helper_fence IS NOT NULL AND NEW.helper_fence IS DISTINCT FROM OLD.helper_fence)
    OR (OLD.install_started AND NOT NEW.install_started)
    OR NEW.install_log_after<OLD.install_log_after THEN
    RAISE EXCEPTION 'Cloud Computer helper identity and progress are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_build_handoff_guard BEFORE UPDATE ON cloud_computer_v2_builds
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_build_handoff_guard();
GRANT EXECUTE ON FUNCTION cloud_computer_build_handoff_guard() TO zeros_app;

CREATE TRIGGER cloud_template_build_handoff_available
  AFTER UPDATE OF handoff_at ON cloud_computer_v2_builds
  FOR EACH ROW WHEN (NEW.state='running' AND NEW.handoff_at IS NOT NULL)
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_template_work');
