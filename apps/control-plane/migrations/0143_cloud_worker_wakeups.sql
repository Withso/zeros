-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Empty, commit-bound hints only. Claim transactions still own authorization,
-- leases and generation fences. Include future deadlines: a worker sleeping
-- on an empty queue must learn about newly scheduled retries and expirations.
-- Existing replicas ignore these channels and retain their polling fallback.
CREATE TRIGGER cloud_outbox_deadline_changed
  AFTER INSERT OR UPDATE OF state, next_attempt_at, lease_expires_at ON cloud_workspace_outbox
  FOR EACH ROW WHEN (NEW.state IN ('queued','processing'))
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_outbox_work');

CREATE TRIGGER cloud_access_deadline_changed
  AFTER INSERT OR UPDATE OF state, expires_at, next_revocation_at, revocation_lease_expires_at ON cloud_workspace_client_access_grants
  FOR EACH ROW WHEN (NEW.state IN ('active','issuing','revocation_pending'))
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_access_work');

CREATE TRIGGER cloud_invitation_delivery_deadline_changed
  AFTER INSERT OR UPDATE OF state, next_attempt_at, lease_expires_at ON cloud_workspace_invitation_deliveries
  FOR EACH ROW WHEN (NEW.state IN ('queued','sending'))
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_invitation_work');

CREATE TRIGGER cloud_invitation_authority_changed
  AFTER UPDATE OF revoked_at, accepted_at, expires_at ON cloud_workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_invitation_work');

CREATE TRIGGER security_publication_available
  AFTER INSERT OR UPDATE OF expires_at ON security_events
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_security_publication_work');

CREATE TRIGGER cloud_directory_publication_available
  AFTER INSERT ON cloud_workspace_directory_outbox
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_security_publication_work');

CREATE TRIGGER cloud_recovery_deadline_changed
  AFTER INSERT OR UPDATE OF state, next_attempt_at ON cloud_workspace_restore_incidents
  FOR EACH ROW WHEN (NEW.state IN ('queued','waiting_for_capacity','waiting_for_funding','restoring','cancelled','succeeded'))
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_recovery_work');

CREATE TRIGGER cloud_fork_deadline_changed
  AFTER INSERT OR UPDATE OF state, deadline_at, lease_expires_at ON workspace_fork_intents
  FOR EACH ROW WHEN (NEW.state NOT IN ('succeeded','failed','cancelled'))
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_fork_work');

CREATE TRIGGER cloud_fork_import_completed
  AFTER UPDATE OF state ON workspace_fork_intents
  FOR EACH ROW WHEN (NEW.operation='local_to_cloud' AND NEW.state='succeeded' AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_lifecycle_work');

CREATE TRIGGER cloud_checkpoint_deadline_changed
  AFTER INSERT OR UPDATE OF state, deadline_at ON workspace_checkpoint_requests
  FOR EACH ROW WHEN (NEW.state IN ('queued','delivered'))
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_checkpoint_work');

CREATE TRIGGER cloud_checkpoint_fork_completed
  AFTER UPDATE OF state ON workspace_checkpoint_requests
  FOR EACH ROW WHEN (NEW.fork_intent_id IS NOT NULL AND NEW.state IN ('succeeded','failed','expired','cancelled') AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_fork_work');

CREATE TRIGGER cloud_checkpoint_lifecycle_completed
  AFTER UPDATE OF state ON workspace_checkpoint_requests
  FOR EACH ROW WHEN (NEW.lifecycle_intent_id IS NOT NULL AND NEW.state='succeeded' AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_lifecycle_work');

-- Extend 0134's immediate-work triggers without replacing their definitions.
CREATE TRIGGER cloud_setup_deadline_changed
  AFTER INSERT OR UPDATE OF state, next_attempt_at, lease_expires_at ON cloud_workspace_setup_runs
  FOR EACH ROW WHEN (NEW.state IN ('queued','running'))
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_setup_work');

CREATE TRIGGER cloud_lifecycle_deadline_changed
  AFTER INSERT OR UPDATE OF state, next_attempt_at, lease_expires_at ON cloud_workspace_lifecycle_intents
  FOR EACH ROW WHEN (NEW.state IN ('queued','observing','dispatching'))
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_lifecycle_work');

CREATE TRIGGER cloud_paid_authority_deadline_changed
  AFTER INSERT OR UPDATE OF next_check_at ON cloud_workspace_paid_authority_checks
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_lifecycle_work');

CREATE TRIGGER cloud_compute_deadline_changed
  AFTER INSERT OR UPDATE OF state, next_check_at, lease_expires_at ON managed_compute_allocation_leases
  FOR EACH ROW WHEN (NEW.state<>'settled')
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_lifecycle_work');

CREATE TRIGGER cloud_engine_health_available
  AFTER INSERT ON cloud_workspace_engine_instances
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_lifecycle_work');

-- A renewal only moves the deadline later; the scheduled read discovers it.
-- Revocation or a shorter lease must wake immediately.
CREATE TRIGGER cloud_engine_health_changed
  AFTER UPDATE OF state, revoked_at, lease_expires_at ON cloud_workspace_engine_instances
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
    OR NEW.lease_expires_at<OLD.lease_expires_at)
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_lifecycle_work');

CREATE TRIGGER cloud_workspace_health_changed
  AFTER INSERT OR UPDATE OF status, desired_state, current_generation, diagnostic_recovery_at ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_lifecycle_work');

CREATE TRIGGER cloud_drift_deadline_changed
  AFTER INSERT OR UPDATE OF next_drift_check_at ON cloud_workspace_provider_bindings
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_lifecycle_work');

CREATE TRIGGER cloud_operations_workspace_changed
  AFTER INSERT OR UPDATE OF status, desired_state, data_deleted_at ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_operations_work');

CREATE TRIGGER cloud_deletion_deadline_changed
  AFTER INSERT OR UPDATE OF state, next_attempt_at, lease_expires_at ON workspace_deletion_jobs
  FOR EACH ROW WHEN (NEW.state IN ('waiting_for_provider','deleting_objects','deleting_records'))
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_operations_work');

CREATE TRIGGER cloud_deletion_provider_proven
  AFTER UPDATE OF deletion_verified_at ON cloud_workspace_provider_bindings
  FOR EACH ROW WHEN (NEW.deletion_verified_at IS NOT NULL AND OLD.deletion_verified_at IS DISTINCT FROM NEW.deletion_verified_at)
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_operations_work');

CREATE TRIGGER cloud_export_deadline_changed
  AFTER INSERT OR UPDATE OF state, expires_at ON workspace_exports
  FOR EACH ROW WHEN (NEW.state='available')
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_operations_work');

CREATE TRIGGER cloud_retention_policy_changed
  AFTER INSERT OR UPDATE OF legal_hold, record_event_days, content_event_days, checkpoint_days ON workspace_retention_policies
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_operations_work');

CREATE TRIGGER cloud_computer_retirement_changed
  AFTER INSERT OR UPDATE OF state, cleanup_state ON cloud_computer_builds
  FOR EACH ROW WHEN (NEW.state='building' OR NEW.cleanup_state<>'complete')
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_retirement_work');

CREATE TRIGGER cloud_computer_image_retirement_changed
  AFTER INSERT OR UPDATE OF state ON cloud_computer_images
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_retirement_work');

CREATE TRIGGER cloud_template_build_deadline_changed
  AFTER INSERT OR UPDATE OF state, deadline_at, cancel_requested_at ON cloud_computer_v2_builds
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_template_work');

CREATE TRIGGER cloud_template_capacity_changed
  AFTER INSERT OR UPDATE OF stopped_at, cleanup_lease_until, cleanup_retry_at, cleanup_confirmed_at ON cloud_computer_templates
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_template_work');
