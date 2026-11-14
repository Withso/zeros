-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Serialize the backfill with every input writer, including older servers.
LOCK TABLE organizations, organization_members, users, account_entitlements, staff_pro_benefits IN SHARE ROW EXCLUSIVE MODE;

-- The generation forces a stale REPEATABLE READ writer to retry even when an
-- organization had no members in its snapshot. Readers never lock this row.
CREATE TABLE organization_seat_generations (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0)
);
-- A person can gain their first membership while an entitlement writer sees
-- no organization. Both writers must meet even across that empty scope.
CREATE TABLE organization_seat_user_generations (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0)
);
CREATE TABLE organization_member_seat_periods (
  org_id uuid NOT NULL REFERENCES organization_seat_generations(org_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  pro_periods tstzmultirange NOT NULL,
  hold_periods tstzmultirange NOT NULL,
  PRIMARY KEY (org_id, user_id),
  CHECK (NOT (pro_periods && hold_periods))
);
ALTER TABLE organization_seat_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_seat_generations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_seat_generations_owner ON organization_seat_generations FOR ALL
  USING (current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.organization_seat_generations'::regclass)))
  WITH CHECK (current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.organization_seat_generations'::regclass)));
ALTER TABLE organization_seat_user_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_seat_user_generations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_seat_user_generations_owner ON organization_seat_user_generations FOR ALL
  USING (current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.organization_seat_user_generations'::regclass)))
  WITH CHECK (current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.organization_seat_user_generations'::regclass)));
ALTER TABLE organization_member_seat_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_member_seat_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_member_seat_periods_owner ON organization_member_seat_periods FOR ALL
  USING (current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.organization_member_seat_periods'::regclass)))
  WITH CHECK (current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.organization_member_seat_periods'::regclass)));
CREATE POLICY organization_member_seat_periods_read ON organization_member_seat_periods FOR SELECT
  USING (public.app_is_system());
-- zeros-expand-exception: privilege-tightening Only database triggers may change the new seat projection
REVOKE ALL ON organization_seat_generations, organization_seat_user_generations, organization_member_seat_periods FROM PUBLIC, zeros_app;
GRANT SELECT ON organization_member_seat_periods TO zeros_app;

-- Preserve the seat policy and the legacy parameterized limits. The projection
-- evaluates it only at the bounded plan boundaries of the ten admitted people.
CREATE FUNCTION organization_member_seats_at(
  target_org_id uuid, member_limit integer, free_limit integer, at timestamptz
) RETURNS TABLE (user_id uuid, seat text)
LANGUAGE sql STABLE AS $$
  WITH members AS (
    SELECT m.user_id,
           coalesce(public.account_entitlement_pro_at(e, at), false) OR public.staff_pro_live(b, u) AS pro,
           row_number() OVER (ORDER BY m.created_at, m.user_id) <= member_limit AS admitted,
           greatest(m.created_at, public.account_entitlement_pro_ended_at(e, at), b.revoked_at) AS free_since
    FROM public.organization_members m
    JOIN public.users u ON u.id=m.user_id
    LEFT JOIN public.account_entitlements e ON e.user_id=m.user_id
    LEFT JOIN public.staff_pro_benefits b ON b.user_id=m.user_id
    WHERE m.org_id=target_org_id AND public.app_require_system()
  ), ranked AS (
    SELECT members.*, row_number() OVER (
      PARTITION BY admitted AND NOT pro ORDER BY free_since, user_id) AS free_rank
    FROM members
  )
  SELECT ranked.user_id, CASE
    WHEN NOT ranked.admitted THEN 'hold'
    WHEN ranked.pro THEN 'pro'
    WHEN ranked.free_rank <= free_limit THEN 'free'
    ELSE 'hold'
  END FROM ranked
$$;
-- zeros-expand-exception: privilege-tightening The parameterized policy requires a system context and explicit application access
REVOKE ALL ON FUNCTION organization_member_seats_at(uuid,integer,integer,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION organization_member_seats_at(uuid,integer,integer,timestamptz) TO zeros_app;

-- Share one input scan across all time intervals and across the backfill's
-- organizations; per-organization function calls otherwise repeat the joins.
CREATE FUNCTION organization_member_seat_periods_for(target_org_ids uuid[])
RETURNS TABLE (org_id uuid, user_id uuid, pro_periods tstzmultirange, hold_periods tstzmultirange)
LANGUAGE sql STABLE AS $$
  WITH members AS MATERIALIZED (
    SELECT m.org_id,m.user_id,m.created_at,e AS entitlement,
      public.staff_pro_live(b,u) AS staff_pro,b.revoked_at AS staff_ended_at,
      row_number() OVER (PARTITION BY m.org_id ORDER BY m.created_at,m.user_id)<=10 AS admitted
    FROM public.organization_members m JOIN public.users u ON u.id=m.user_id
    LEFT JOIN public.account_entitlements e ON e.user_id=m.user_id
    LEFT JOIN public.staff_pro_benefits b ON b.user_id=m.user_id
    WHERE m.org_id=ANY(target_org_ids) AND public.app_require_system()
  ), boundaries AS (
    SELECT org_id,'-infinity'::timestamptz AS at FROM members
    UNION SELECT org_id,(entitlement).valid_from FROM members WHERE admitted AND isfinite((entitlement).valid_from)
    UNION SELECT org_id,(entitlement).valid_until FROM members WHERE admitted AND isfinite((entitlement).valid_until)
  ), periods AS (
    SELECT org_id,at,lead(at) OVER (PARTITION BY org_id ORDER BY at) AS until FROM boundaries
  ), at_seats AS MATERIALIZED (
    SELECT m.org_id,m.user_id,m.admitted,p.at,p.until,
      coalesce(public.account_entitlement_pro_at(m.entitlement,p.at),false) OR m.staff_pro AS pro,
      greatest(m.created_at,public.account_entitlement_pro_ended_at(m.entitlement,p.at),m.staff_ended_at) AS free_since
    FROM members m JOIN periods p ON p.org_id=m.org_id
  ), ranked AS (
    SELECT s.*,row_number() OVER (
      PARTITION BY s.org_id,s.at,s.admitted AND NOT s.pro ORDER BY s.free_since,s.user_id) AS free_rank
    FROM at_seats s
  )
  SELECT r.org_id,r.user_id,
    coalesce(range_agg(tstzrange(r.at,r.until,'[)')) FILTER(WHERE r.admitted AND r.pro),'{}'::tstzmultirange),
    coalesce(range_agg(tstzrange(r.at,r.until,'[)')) FILTER(WHERE NOT r.admitted OR (NOT r.pro AND r.free_rank>5)),'{}'::tstzmultirange)
  FROM ranked r GROUP BY r.org_id,r.user_id
$$;
-- zeros-expand-exception: privilege-tightening Only the migration owner and refresh triggers may derive the stored intervals
REVOKE ALL ON FUNCTION organization_member_seat_periods_for(uuid[]) FROM PUBLIC;

-- zeros-expand-exception: seat-projection-refresh Removes only obsolete derived rows after a membership change
CREATE FUNCTION refresh_organization_member_seats(target_org_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous_system text := current_setting('app.system',true);
BEGIN
  PERFORM set_config('app.system','on',true);
  -- Join and invitation writers already lock the organization before their
  -- membership write. Use that same order before changing the projection.
  PERFORM 1 FROM public.organizations WHERE id=target_org_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.system',coalesce(previous_system,''),true);
    RETURN;
  END IF;
  INSERT INTO public.organization_seat_generations(org_id) VALUES(target_org_id)
    ON CONFLICT(org_id) DO UPDATE SET revision=organization_seat_generations.revision+1;

  INSERT INTO public.organization_member_seat_periods(org_id,user_id,pro_periods,hold_periods)
    SELECT s.org_id,s.user_id,s.pro_periods,s.hold_periods
    FROM public.organization_member_seat_periods_for(ARRAY[target_org_id]) s
    ON CONFLICT(org_id,user_id) DO UPDATE SET pro_periods=EXCLUDED.pro_periods,hold_periods=EXCLUDED.hold_periods;
  DELETE FROM public.organization_member_seat_periods p WHERE p.org_id=target_org_id
    AND NOT EXISTS(SELECT 1 FROM public.organization_members m WHERE m.org_id=p.org_id AND m.user_id=p.user_id);
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RAISE;
END;
$$;
-- zeros-expand-exception: privilege-tightening The refresh is trigger-only and cannot be called with arbitrary application scope
REVOKE ALL ON FUNCTION refresh_organization_member_seats(uuid) FROM PUBLIC;

CREATE FUNCTION refresh_changed_organization_seats() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE organization_ids uuid[]; people uuid[]; observed_organizations uuid[]; organization uuid;
  previous_system text := current_setting('app.system',true);
BEGIN
  PERFORM set_config('app.system','on',true);
  IF TG_OP<>'INSERT' THEN people:=array_append(people,OLD.user_id); END IF;
  IF TG_OP<>'DELETE' THEN people:=array_append(people,NEW.user_id); END IF;
  IF TG_TABLE_NAME='organization_members' THEN
    IF TG_OP<>'INSERT' THEN organization_ids:=array_append(organization_ids,OLD.org_id); END IF;
    IF TG_OP<>'DELETE' THEN organization_ids:=array_append(organization_ids,NEW.org_id); END IF;
  ELSE
    SELECT array_agg(DISTINCT m.org_id ORDER BY m.org_id) INTO organization_ids
      FROM public.organization_members m WHERE m.user_id=ANY(people);
  END IF;
  LOOP
    BEGIN
      -- Organization-first matches admission callers. The separate person
      -- version avoids inverting that order with a staff-role UPDATE on users.
      PERFORM 1 FROM public.organizations WHERE id=ANY(organization_ids) ORDER BY id FOR NO KEY UPDATE;
      INSERT INTO public.organization_seat_user_generations(user_id)
        SELECT id FROM public.users WHERE id=ANY(people) ORDER BY id
        ON CONFLICT(user_id) DO UPDATE SET revision=organization_seat_user_generations.revision+1;

      IF TG_TABLE_NAME<>'organization_members' THEN
        SELECT array_agg(DISTINCT m.org_id ORDER BY m.org_id) INTO observed_organizations
          FROM public.organization_members m WHERE m.user_id=ANY(people);
        IF NOT coalesce(observed_organizations,'{}'::uuid[]) <@ coalesce(organization_ids,'{}'::uuid[]) THEN
          SELECT array_agg(DISTINCT id ORDER BY id) INTO organization_ids
            FROM unnest(organization_ids || observed_organizations) AS o(id);
          -- Release this attempt's locks before acquiring any newly discovered
          -- organization. The enlarged scope survives the subtransaction rollback.
          RAISE EXCEPTION 'seat refresh scope changed' USING ERRCODE='PZS01';
        END IF;
      END IF;
      FOR organization IN SELECT DISTINCT id FROM unnest(organization_ids) AS o(id) ORDER BY id LOOP
        PERFORM public.refresh_organization_member_seats(organization);
      END LOOP;
      EXIT;
    EXCEPTION WHEN SQLSTATE 'PZS01' THEN NULL;
    END;
  END LOOP;
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RAISE;
END;
$$;
-- zeros-expand-exception: privilege-tightening Trigger callers cannot invoke the definer with a fabricated table or row
REVOKE ALL ON FUNCTION refresh_changed_organization_seats() FROM PUBLIC;

-- These run before capability, execution and Creator-loss triggers on the same
-- write. A demotion must also record the benefit's end before any Hold check.
-- zeros-expand-exception: seat-trigger-order Keeps the existing staff benefit writer ahead of all authority readers
ALTER TRIGGER staff_pro_benefit_sync ON users RENAME TO a0_staff_pro_benefit_sync;
CREATE TRIGGER a1_organization_seat_refresh AFTER INSERT OR UPDATE OF org_id,user_id,created_at OR DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION refresh_changed_organization_seats();
CREATE TRIGGER a1_organization_seat_refresh AFTER INSERT OR UPDATE OR DELETE ON account_entitlements
  FOR EACH ROW EXECUTE FUNCTION refresh_changed_organization_seats();
CREATE TRIGGER a1_organization_seat_refresh AFTER INSERT OR UPDATE OR DELETE ON staff_pro_benefits
  FOR EACH ROW EXECUTE FUNCTION refresh_changed_organization_seats();

SELECT set_config('app.system','on',true);
INSERT INTO organization_seat_generations(org_id) SELECT id FROM organizations ORDER BY id;
INSERT INTO organization_seat_user_generations(user_id) SELECT id FROM users ORDER BY id;
INSERT INTO organization_member_seat_periods(org_id,user_id,pro_periods,hold_periods)
  SELECT * FROM public.organization_member_seat_periods_for(ARRAY(SELECT id FROM organizations ORDER BY id));
SELECT set_config('app.system','',true);

-- The same signatures serve N-1 callers. Default-limit reads only inspect
-- stored intervals: clock-only grants and expiries require no read-time write.
-- zeros-expand-exception: stored-seat-read Replaces repeated ranking with the atomically maintained seat intervals
CREATE OR REPLACE FUNCTION organization_member_seats(
  target_org_id uuid, member_limit integer, free_limit integer
) RETURNS TABLE (user_id uuid, seat text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.app_require_system();
  IF member_limit=10 AND free_limit=5 THEN
    RETURN QUERY SELECT m.user_id,CASE
      WHEN p.user_id IS NULL OR p.hold_periods @> now() THEN 'hold'
      WHEN p.pro_periods @> now() THEN 'pro' ELSE 'free' END
      FROM public.organization_members m LEFT JOIN public.organization_member_seat_periods p
        ON p.org_id=m.org_id AND p.user_id=m.user_id
      WHERE m.org_id=target_org_id;
  ELSE
    RETURN QUERY SELECT s.user_id,s.seat FROM public.organization_member_seats_at(target_org_id,member_limit,free_limit,now()) s;
  END IF;
END;
$$;
-- zeros-expand-exception: stored-seat-read Keeps the existing Hold predicate while failing closed on a missing member projection
CREATE OR REPLACE FUNCTION organization_member_on_hold(
  target_org_id uuid, target_user_id uuid, member_limit integer, free_limit integer
) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE held boolean;
BEGIN
  PERFORM public.app_require_system();
  IF member_limit=10 AND free_limit=5 THEN
    SELECT p.hold_periods @> now() INTO held FROM public.organization_member_seat_periods p
      WHERE p.org_id=target_org_id AND p.user_id=target_user_id;
    IF FOUND THEN RETURN held; END IF;
    RETURN EXISTS(SELECT 1 FROM public.organization_members m WHERE m.org_id=target_org_id AND m.user_id=target_user_id);
  END IF;
  RETURN EXISTS(SELECT 1 FROM public.organization_member_seats_at(target_org_id,member_limit,free_limit,now()) s
    WHERE s.user_id=target_user_id AND s.seat='hold');
END;
$$;
