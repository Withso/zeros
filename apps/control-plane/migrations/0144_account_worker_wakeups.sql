-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Account queues also serve Local-only installations. These empty hints do
-- not depend on cloud workspaces, and deliver only after the writer commits.
-- Wake on terminal commands too: completing a predecessor admits the next
-- command for the same ordering key, even when its retry was far in the future.
CREATE TRIGGER account_command_deadline_changed
  AFTER INSERT OR UPDATE OF state, next_attempt_at, lease_expires_at ON workos_command_outbox
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_account_maintenance_work');

CREATE TRIGGER account_organization_provisioned
  AFTER INSERT OR UPDATE OF state, workos_organization_id ON workos_organization_links
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_worker_available('zeros_account_maintenance_work');

CREATE TRIGGER account_security_mail_deadline_changed
  AFTER INSERT OR UPDATE OF state, next_attempt_at, lease_expires_at, delivery_provider ON security_notification_outbox
  FOR EACH ROW WHEN (NEW.delivery_provider='resend' AND NEW.state IN ('queued','sending'))
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_account_maintenance_work');

CREATE TRIGGER account_deletion_deadline_changed
  AFTER INSERT OR UPDATE OF state, next_attempt_at, purge_after, lease_expires_at, attempt_count ON deletion_requests
  FOR EACH ROW WHEN (NEW.state IN ('scheduled','failed','purging','provider_deleting'))
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_account_maintenance_work');
