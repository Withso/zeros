-- zeros-migration: contract
-- zeros-contract-after: 2026-10-21
-- zeros:requires-controlled-downtime
-- The owner approved retirement of the old cloud runtime and its data. Deploy
-- only with the v2 control plane/desktop cutover; historical migrations remain
-- immutable so every existing database follows the same upgrade ladder.
-- Batch 1 of 11. Keep maintenance through 0200_retire_legacy_cloud_11.sql;
-- later batches follow 0190 so existing migration numbers stay unchanged.
-- Each transaction targets fewer than 1,000 locks (the ladder test caps 1,500).
-- Retain the Settings vault, Codex renewal ledger, GitHub connections,
-- organization/account entitlements, identity/security data and cloud_v2_*.

-- Finish the old vault's lazy metadata backfill before its delegation source
-- disappears. This preserves imported accounts without carrying workspace
-- delegation or engine authority into v2.
INSERT INTO cloud_agent_credential_organizations(credential_id,org_id,owner_user_id)
SELECT DISTINCT credential.id,delegation.org_id,credential.owner_user_id
FROM cloud_agent_credential_delegations delegation
JOIN cloud_agent_credentials credential ON credential.id=delegation.credential_id AND credential.owner_user_id=delegation.owner_user_id
JOIN organization_members member ON member.org_id=delegation.org_id AND member.user_id=credential.owner_user_id
JOIN organizations organization ON organization.id=member.org_id AND NOT organization.is_personal AND organization.deleted_at IS NULL
WHERE credential.revoked_at IS NULL AND delegation.revoked_at IS NULL
ON CONFLICT DO NOTHING;
UPDATE cloud_agent_credentials credential SET connection_method=CASE
  WHEN credential.kind IN ('claude-setup-token','codex-chatgpt') OR
    (credential.kind='cursor-api-key' AND material.material_expires_at IS NOT NULL) THEN 'account' ELSE 'api' END
FROM cloud_agent_credential_versions material
WHERE material.credential_id=credential.id AND material.version=credential.current_version AND material.material_mode='local';
-- Internal publication fences have no v2 holder. Public removal receipts and
-- their remote Dev broker acknowledgements remain intact.
DELETE FROM cloud_agent_credential_mutations WHERE target->>'kind' IN ('publish-credential','publish-connection');

-- Account entitlement checks are used by Settings, independently of a VM.
CREATE OR REPLACE FUNCTION public.account_pro_entitlement(target_user_id uuid)
 RETURNS TABLE(plan text, revision bigint, valid_from timestamp with time zone, valid_until timestamp with time zone, source text)
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT eligible.plan,eligible.revision,eligible.valid_from,eligible.valid_until,eligible.source
  FROM users account CROSS JOIN LATERAL (
    SELECT entitlement.plan,entitlement.revision,entitlement.valid_from,entitlement.valid_until,entitlement.source,0 AS priority
    FROM account_entitlements entitlement WHERE entitlement.user_id=account.id AND entitlement.plan='pro'
      AND (entitlement.status IN ('active','trialing') OR (entitlement.status='cancelled' AND entitlement.valid_until IS NOT NULL))
      AND entitlement.cloud_workspaces_allowed AND entitlement.valid_from<=clock_timestamp()
      AND (entitlement.valid_until IS NULL OR entitlement.valid_until>clock_timestamp())
    UNION ALL
    SELECT 'pro',900000000000000+benefit.revision,benefit.valid_from,NULL::timestamptz,'staff',1
    FROM staff_pro_benefits benefit WHERE benefit.user_id=account.id AND benefit.revoked_at IS NULL
      AND account.staff_role IN ('platform_owner','developer')
  ) eligible
  WHERE account.id=target_user_id AND account.auth_status='active' AND account.deleted_at IS NULL
    AND (app_is_system() OR account.id=app_current_user())
  ORDER BY eligible.priority LIMIT 1
$function$
;
CREATE OR REPLACE FUNCTION public.account_pro_user_live(target_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT EXISTS(SELECT 1 FROM account_pro_entitlement(target_user_id))
$function$
;
REVOKE ALL ON FUNCTION account_pro_entitlement(uuid), account_pro_user_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION account_pro_entitlement(uuid), account_pro_user_live(uuid) TO zeros_app;

-- Organization entitlement audit evidence remains append-only during tenant
-- life and is erased only after the retained deletion lifecycle enters purge.
CREATE FUNCTION public.purge_organization_entitlement_configuration(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'system context required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organizations
  WHERE id = p_org_id AND lifecycle_status = 'purging' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization purge state mismatch' USING ERRCODE = '55000';
  END IF;
  DELETE FROM public.cloud_workspace_entitlement_changes WHERE org_id = p_org_id;
END;
$function$;
REVOKE ALL ON FUNCTION purge_organization_entitlement_configuration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_organization_entitlement_configuration(uuid) TO zeros_app;

-- These two triggers serve retained account/security queues; keep their exact
-- behavior and notification channels under names outside the old runtime.
ALTER FUNCTION cloud_actor_staff_revision() RENAME TO account_staff_revision;
ALTER FUNCTION notify_cloud_worker_available() RENAME TO notify_background_work_available;

-- Remove old engine hooks on retained tables before deleting their sources.
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON account_entitlements;
DROP TRIGGER IF EXISTS account_entitlement_cloud_authority_check ON account_entitlements;
DROP TRIGGER IF EXISTS cloud_capability_epoch_account_entitlement_changes ON account_entitlements;
DROP TRIGGER IF EXISTS cloud_capability_epoch_account_entitlements ON account_entitlements;
DROP TRIGGER IF EXISTS account_pro_monthly_allowance ON account_entitlements;
DROP TRIGGER IF EXISTS revoke_disconnected_native_github_grants ON cloud_github_connections;
DROP TRIGGER IF EXISTS organization_entitlement_cloud_authority_check ON organization_entitlements;
DROP TRIGGER IF EXISTS cloud_capability_epoch_organization_entitlements ON organization_entitlements;
DROP TRIGGER IF EXISTS cloud_capability_epoch_organization_entitlement_changes ON organization_entitlements;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON organization_entitlements;
DROP TRIGGER IF EXISTS cloud_workspace_data_org_membership_removed ON organization_members;
DROP TRIGGER IF EXISTS cloud_capability_epoch_org_members_changes ON organization_members;
DROP TRIGGER IF EXISTS cloud_capability_epoch_org_members ON organization_members;
DROP TRIGGER IF EXISTS organization_member_cloud_workspace_access_revoke ON organization_members;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON organization_members;
DROP TRIGGER IF EXISTS organization_membership_cloud_authority_check ON organization_members;
DROP TRIGGER IF EXISTS pro_workspace_guest_membership_removed ON organization_members;
DROP TRIGGER IF EXISTS organization_seat_cloud_authority_check ON organization_seat_assignments;
DROP TRIGGER IF EXISTS cloud_capability_epoch_seat_assignments_changes ON organization_seat_assignments;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON organization_seat_assignments;
DROP TRIGGER IF EXISTS cloud_capability_epoch_seat_assignments ON organization_seat_assignments;
DROP TRIGGER IF EXISTS cloud_capability_epoch_organizations ON organizations;
DROP TRIGGER IF EXISTS organization_cloud_workspace_retirement ON organizations;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON organizations;
DROP TRIGGER IF EXISTS organization_cloud_authority_check ON organizations;
DROP TRIGGER IF EXISTS cloud_capability_epoch_staff_pro_benefits ON staff_pro_benefits;
DROP TRIGGER IF EXISTS cloud_capability_epoch_staff_pro_benefits_changes ON staff_pro_benefits;
DROP TRIGGER IF EXISTS staff_pro_monthly_allowance ON staff_pro_benefits;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON staff_pro_benefits;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON team_members;
DROP TRIGGER IF EXISTS cloud_capability_epoch_team_members_changes ON team_members;
DROP TRIGGER IF EXISTS cloud_capability_epoch_team_members ON team_members;
DROP TRIGGER IF EXISTS cloud_workspace_data_team_membership_removed ON team_members;
DROP TRIGGER IF EXISTS team_membership_cloud_authority_check ON team_members;
DROP TRIGGER IF EXISTS team_member_cloud_workspace_access_revoke ON team_members;
DROP TRIGGER IF EXISTS team_cloud_workspace_retirement ON teams;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON teams;
DROP TRIGGER IF EXISTS cloud_capability_epoch_teams ON teams;
DROP TRIGGER IF EXISTS cloud_capability_epoch_event_accounts ON users;
DROP TRIGGER IF EXISTS user_auth_cloud_authority_check ON users;
DROP TRIGGER IF EXISTS user_cloud_workspace_authority_retirement ON users;
DROP TRIGGER IF EXISTS user_staff_cloud_authority_check ON users;
DROP TRIGGER IF EXISTS cloud_capability_epoch_users ON users;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON users;
DROP TRIGGER IF EXISTS workos_link_cloud_authority_check ON workos_organization_links;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON workos_organization_links;

-- This is the sole FK from a retained table into the retired workspace graph.
-- Account and organization security events are preserved; obsolete workspace
-- events have no remaining catalog or authority consumer.
DELETE FROM security_events WHERE workspace_id IS NOT NULL;
ALTER TABLE security_events DROP CONSTRAINT IF EXISTS security_events_workspace_scope;

-- The explicit list also removes each table's RLS policies and triggers.
-- CASCADE handles row-returning old functions; later batches finish cleanup.
DROP TABLE IF EXISTS
  cloud_accepted_work_enrollments,
  cloud_agent_adoption_key_policy,
  cloud_agent_adoption_retired_owners,
  cloud_agent_adoptions,
  cloud_agent_background_tasks,
  cloud_agent_boot_contexts,
  cloud_agent_boot_credentials,
  cloud_agent_boot_refreshes,
  cloud_agent_boot_source_deliveries,
  cloud_agent_checkpoint_history_snapshots,
  cloud_agent_credential_source_retirements,
  cloud_agent_funding_consents,
  cloud_agent_runtime_qualification_changes,
  cloud_agent_runtime_qualifications,
  cloud_builder_vm_create_attempts,
  cloud_capability_access_losses,
  cloud_capability_key_changes,
  cloud_capability_member_epochs,
  cloud_computer_admin_workspace_requests,
  cloud_computer_build_logs,
  cloud_computer_build_qualifications,
  cloud_computer_environment_refs,
  cloud_computer_image_base_references,
  cloud_computer_image_create_attempts,
  cloud_computer_template_snapshots,
  cloud_computer_v2_config_repositories
CASCADE;
