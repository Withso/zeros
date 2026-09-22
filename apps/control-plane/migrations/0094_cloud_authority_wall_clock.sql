-- Deadline checks must use elapsed wall time after contended locks. Transaction
-- time remains appropriate for audit timestamps, but cannot renew expired
-- authority. Preserve function signatures and grants for rolling deployment.
-- VOLATILE prevents deadline decisions from being reused across a statement.

CREATE OR REPLACE FUNCTION public.cloud_workspace_actor_auth_live(target_user_id uuid, source_provider text, source_subject text, source_session_id text, source_session_created_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT app_is_system() AND EXISTS (
    SELECT 1 FROM auth_sessions source
    JOIN user_identities identity ON identity.provider::text=source.provider AND identity.provider_sub=source.provider_sub
      AND identity.user_id=source.user_id AND identity.status='active' AND identity.email_verified_at IS NOT NULL
    JOIN users account ON account.id=source.user_id AND account.auth_status='active' AND account.deleted_at IS NULL
    WHERE source.provider=source_provider AND source.provider='workos' AND source.provider_sub=source_subject
      AND source.provider_session_id=source_session_id AND source.user_id=target_user_id
      AND source.created_at=source_session_created_at AND source.status='active' AND source.revoked_at IS NULL
      AND (source.provider_session_expires_at IS NULL OR source.provider_session_expires_at>clock_timestamp())
  )
$function$;

CREATE OR REPLACE FUNCTION public.cloud_workspace_actor_role(target_workspace_id uuid, target_user_id uuid)
 RETURNS text
 LANGUAGE sql
 VOLATILE
 SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT CASE
    WHEN workspace.owner_user_id=target_user_id THEN
      CASE WHEN member.user_id IS NOT NULL AND explicit_member.role='owner'
        AND EXISTS (SELECT 1 FROM team_members team_member WHERE team_member.team_id=workspace.team_id
          AND team_member.org_id=workspace.org_id AND team_member.user_id=target_user_id)
      THEN 'owner' ELSE NULL END
    WHEN workspace.single_member_mode THEN NULL
    WHEN member.user_id IS NOT NULL AND workspace.sharing_mode='organization'
      AND member.role IN ('owner','admin') THEN 'manager'
    WHEN member.user_id IS NOT NULL AND explicit_member.role IS NOT NULL THEN explicit_member.role
    WHEN member.user_id IS NOT NULL AND workspace.sharing_mode='organization' THEN 'developer'
    ELSE guest.role
  END
  FROM cloud_workspaces workspace
  JOIN organizations organization ON organization.id=workspace.org_id
    AND organization.deleted_at IS NULL AND NOT organization.is_personal
  JOIN teams team ON team.id=workspace.team_id AND team.org_id=workspace.org_id AND team.deleted_at IS NULL
  LEFT JOIN organization_members member ON member.org_id=workspace.org_id AND member.user_id=target_user_id
  LEFT JOIN cloud_workspace_members explicit_member ON explicit_member.workspace_id=workspace.id
    AND explicit_member.org_id=workspace.org_id AND explicit_member.user_id=target_user_id
  LEFT JOIN organization_entitlements entitlement ON entitlement.org_id=workspace.org_id
  LEFT JOIN cloud_workspace_guest_grants guest ON guest.workspace_id=workspace.id
    AND guest.org_id=workspace.org_id AND guest.user_id=target_user_id
    AND guest.revoked_at IS NULL AND guest.expires_at>clock_timestamp()
  WHERE workspace.id=target_workspace_id AND workspace.deleted_at IS NULL
    AND cloud_workspace_pilot_user_live(target_user_id)
    AND (
      (member.user_id IS NOT NULL AND entitlement.plan IN ('business','enterprise')
        AND entitlement.status IN ('active','trialing') AND entitlement.cloud_workspaces_allowed
        AND entitlement.valid_from<=clock_timestamp() AND (entitlement.valid_until IS NULL OR entitlement.valid_until>clock_timestamp())
        AND EXISTS (SELECT 1 FROM organization_seat_assignments seat WHERE seat.org_id=workspace.org_id
          AND seat.user_id=target_user_id AND seat.state='active')
        AND (SELECT count(*) FROM organization_seat_assignments seat WHERE seat.org_id=workspace.org_id
          AND seat.state='active')<=entitlement.seat_limit)
      OR ((member.user_id IS NULL OR entitlement.plan IS NULL OR entitlement.plan='pro')
        AND cloud_workspace_pro_user_live(target_user_id))
    )
$function$;

CREATE OR REPLACE FUNCTION public.cloud_workspace_compute_authority_live(target_workspace_id uuid, target_generation integer)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM cloud_workspace_generations generation
    JOIN provider_connection_versions version ON version.connection_id=generation.provider_connection_id
      AND version.org_id=generation.org_id AND version.version=generation.provider_connection_version
    LEFT JOIN managed_compute_provider_requirements requirement ON requirement.provider=generation.provider
    WHERE generation.workspace_id=target_workspace_id AND generation.generation=target_generation
      AND (version.credential_source='delegated' OR NOT coalesce(requirement.require_credit,true) OR EXISTS (
        SELECT 1 FROM managed_compute_allocation_leases lease
        JOIN cloud_workspaces workspace ON workspace.id=lease.workspace_id AND workspace.org_id=lease.org_id
          AND workspace.current_generation=lease.generation AND workspace.current_billing_epoch=lease.billing_epoch
          AND workspace.owner_user_id=lease.user_id
        JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=lease.workspace_id
          AND binding.org_id=lease.org_id AND binding.generation=lease.generation
          AND binding.provider_resource_id=lease.provider_resource_id
        JOIN managed_compute_credit_reservations reservation ON reservation.id=lease.id
          AND reservation.workspace_id=lease.workspace_id AND reservation.org_id=lease.org_id
          AND reservation.generation=lease.generation AND reservation.billing_epoch=lease.billing_epoch
          AND reservation.user_id=lease.user_id AND reservation.policy_id=lease.policy_id
          AND reservation.seconds_per_dollar=lease.seconds_per_dollar
        WHERE lease.workspace_id=generation.workspace_id AND lease.org_id=generation.org_id
          AND lease.generation=generation.generation AND lease.provider=generation.provider
          AND lease.state IN ('active','draining')
          AND lease.provider_expires_at > clock_timestamp() AND lease.funded_until > clock_timestamp()
          AND reservation.state='open' AND reservation.meter_since <= clock_timestamp()
          AND reservation.covered_until > clock_timestamp() AND reservation.reserved_micro_usd > 0
      ))
  )
$function$;

CREATE OR REPLACE FUNCTION public.cloud_workspace_generation_provider_authority_live(target_workspace_id uuid, target_generation integer, minimum_remaining_seconds integer)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT minimum_remaining_seconds BETWEEN 0 AND 3600
    AND EXISTS (
      SELECT 1
      FROM cloud_workspace_generations generation
      JOIN provider_connections connection
        ON connection.id = generation.provider_connection_id
       AND connection.org_id = generation.org_id
       AND connection.provider = generation.provider
      JOIN provider_connection_versions version
        ON version.connection_id = generation.provider_connection_id
       AND version.org_id = generation.org_id
       AND version.version = generation.provider_connection_version
      WHERE generation.workspace_id = target_workspace_id
        AND generation.generation = target_generation
        AND connection.state = 'active'
        AND connection.credential_source = version.credential_source
        AND version.retired_at IS NULL
        AND (
          version.credential_source = 'hosted'
          OR (
            version.capabilities ->> 'qualified' = 'true'
            AND version.capabilities ->> 'lifecycle' = 'true'
            AND (
              version.credential_expires_at IS NULL
              OR version.credential_expires_at >
                clock_timestamp() + make_interval(secs => minimum_remaining_seconds)
            )
          )
        )
    )
$function$;

CREATE OR REPLACE FUNCTION public.cloud_workspace_paid_authority_live(target_workspace_id uuid, target_user_id uuid, require_workos boolean)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT cloud_workspace_pilot_user_live(target_user_id) AND EXISTS (
    SELECT 1 FROM cloud_workspaces workspace
    JOIN organizations organization ON organization.id = workspace.org_id
      AND organization.deleted_at IS NULL AND NOT organization.is_personal
      AND organization.cloud_workspaces_allowed
    JOIN organization_members member ON member.org_id = workspace.org_id
      AND member.user_id = target_user_id
    JOIN teams team ON team.id = workspace.team_id AND team.org_id = workspace.org_id
      AND team.deleted_at IS NULL
    JOIN team_members team_member ON team_member.team_id = team.id
      AND team_member.org_id = workspace.org_id AND team_member.user_id = target_user_id
    JOIN cloud_workspace_members workspace_member ON workspace_member.workspace_id = workspace.id
      AND workspace_member.org_id = workspace.org_id
      AND workspace_member.user_id = target_user_id AND workspace_member.role = 'owner'
    JOIN workspace_billing_epochs billing ON billing.workspace_id = workspace.id
      AND billing.org_id = workspace.org_id AND billing.billing_epoch = workspace.current_billing_epoch
      AND billing.ended_at IS NULL AND billing.billing_owner_user_id = target_user_id
    LEFT JOIN organization_entitlements organization_entitlement ON organization_entitlement.org_id = workspace.org_id
    WHERE workspace.id = target_workspace_id AND workspace.deleted_at IS NULL
      AND workspace.owner_user_id = target_user_id
      AND (NOT require_workos OR EXISTS (
        SELECT 1 FROM workos_organization_links link WHERE link.organization_id = workspace.org_id
          AND link.state = 'active' AND link.workos_organization_id IS NOT NULL))
      AND (
        ((organization_entitlement.plan IS NULL OR organization_entitlement.plan = 'pro')
          AND billing.entitlement_scope = 'account' AND billing.entitlement_plan = 'pro'
          AND cloud_workspace_pro_user_live(target_user_id)
          AND EXISTS (SELECT 1 FROM account_entitlements entitlement
            WHERE entitlement.user_id = target_user_id AND entitlement.revision = billing.entitlement_revision))
        OR (organization_entitlement.plan IN ('business', 'enterprise')
          AND billing.entitlement_scope = 'organization'
          AND billing.entitlement_plan = organization_entitlement.plan
          AND billing.entitlement_revision = organization_entitlement.revision
          AND organization_entitlement.status IN ('active', 'trialing')
          AND organization_entitlement.cloud_workspaces_allowed
          AND organization_entitlement.valid_from <= clock_timestamp()
          AND (organization_entitlement.valid_until IS NULL OR organization_entitlement.valid_until > clock_timestamp())
          AND EXISTS (SELECT 1 FROM organization_seat_assignments seat
            WHERE seat.org_id = workspace.org_id AND seat.user_id = target_user_id AND seat.state = 'active')
          AND (SELECT count(*) FROM organization_seat_assignments seat
            WHERE seat.org_id = workspace.org_id AND seat.state = 'active') <= organization_entitlement.seat_limit)
      )
  )
$function$;

CREATE OR REPLACE FUNCTION public.cloud_workspace_pro_user_live(target_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT cloud_workspace_pilot_user_live(target_user_id) AND EXISTS (
    SELECT 1 FROM account_entitlements entitlement
    WHERE entitlement.user_id = target_user_id AND entitlement.plan = 'pro'
      AND entitlement.status IN ('active', 'trialing')
      AND entitlement.cloud_workspaces_allowed AND entitlement.valid_from <= clock_timestamp()
      AND (entitlement.valid_until IS NULL OR entitlement.valid_until > clock_timestamp()))
$function$;

CREATE OR REPLACE FUNCTION public.cloud_workspace_runtime_authority_live(target_workspace_id uuid, target_generation integer, target_user_id uuid, require_workos boolean)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT cloud_workspace_paid_authority_live(target_workspace_id,target_user_id,require_workos)
    AND cloud_workspace_generation_provider_authority_live(target_workspace_id,target_generation,300)
    AND cloud_workspace_compute_authority_live(target_workspace_id,target_generation)
$function$;
