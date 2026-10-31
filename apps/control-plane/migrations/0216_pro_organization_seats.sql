-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Pro organizations admit a bounded number of members (owner included) and only
-- some of them without Pro. A member without Pro beyond that allowance is on
-- Hold: still a member, without the organization's chats and cloud workspaces.
-- Seats are derived from memberships and entitlements on every read, never
-- stored, so a Pro grant, a lapse or a departure rebalances every path at once.
-- The application owns the limits and passes them in.
--
-- Seats read every member's entitlement. Under a user's row security they would
-- answer from a partial view, so they refuse to run outside system context.
-- The SQL functions are schema-qualified rather than pinned to a search path so
-- the planner can inline them into the cloud authority clause.

CREATE FUNCTION app_require_system() RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT coalesce(public.app_is_system(), false) THEN
    RAISE EXCEPTION 'system context required' USING ERRCODE = '42501';
  END IF;
  RETURN true;
END;
$$;

-- Pro as account_pro_entitlement (0182) grants it, without the staff benefit:
-- staff accounts need their own grant. Account status is not consulted, so a
-- member keeps their seat through an account-deletion grace period and a
-- restore never displaces anyone.
CREATE FUNCTION account_entitlement_pro_at(e public.account_entitlements, at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT e.plan = 'pro' AND e.cloud_workspaces_allowed
     AND (e.status IN ('active', 'trialing') OR (e.status = 'cancelled' AND e.valid_until IS NOT NULL))
     AND e.valid_from <= at AND (e.valid_until IS NULL OR e.valid_until > at)
$$;

-- When Pro last ended. A write that ends live Pro records its own time; a
-- window that closes by itself ends Pro at its close.
ALTER TABLE account_entitlements ADD COLUMN pro_ended_at timestamptz;

CREATE FUNCTION account_entitlement_pro_ended_at(e public.account_entitlements, at timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN e.valid_until <= at AND public.account_entitlement_pro_at(e, e.valid_from)
              THEN greatest(e.pro_ended_at, e.valid_until) ELSE e.pro_ended_at END
$$;

-- Rows that already lost Pro lost it no later than their last change. Forced
-- row security hides every row from the migration role outside system context.
SELECT set_config('app.system', 'on', true);
UPDATE account_entitlements e SET pro_ended_at = least(e.updated_at, e.valid_until)
WHERE e.plan = 'pro' AND NOT public.account_entitlement_pro_at(e, e.valid_from);
SELECT set_config('app.system', '', true);

-- A recorded end never moves earlier, so no later write (a future-dated grant,
-- a cancellation of an expired grant, a backdated window) can rank its member
-- ahead of members already holding free seats.
CREATE FUNCTION account_entitlements_record_pro_end() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  written timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.pro_ended_at := NULL;
  ELSIF public.account_entitlement_pro_at(OLD, written)
        AND NOT public.account_entitlement_pro_at(NEW, written) THEN
    NEW.pro_ended_at := written;
  ELSE
    NEW.pro_ended_at := public.account_entitlement_pro_ended_at(OLD, written);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_entitlements_record_pro_end
  BEFORE INSERT OR UPDATE ON account_entitlements
  FOR EACH ROW EXECUTE FUNCTION account_entitlements_record_pro_end();

CREATE FUNCTION account_pro_active(target_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.account_entitlements e
    WHERE e.user_id = target_user_id AND public.account_entitlement_pro_at(e, now())
      AND (public.app_is_system() OR target_user_id = public.app_current_user()))
$$;

-- A member without Pro takes a free seat in the order they last became free:
-- when they joined or when their Pro ended, whichever is later. The earliest
-- hold the free seats and the rest wait on Hold, so a released seat goes to
-- whoever has waited longest and a lapse never displaces a member already
-- free. Members beyond the overall limit, which only directory sync can add,
-- are held as well.
CREATE FUNCTION organization_member_seats(
  target_org_id uuid, member_limit integer, free_limit integer
) RETURNS TABLE (user_id uuid, seat text)
LANGUAGE sql STABLE AS $$
  WITH members AS (
    SELECT m.user_id,
           coalesce(public.account_entitlement_pro_at(e, now()), false) AS pro,
           row_number() OVER (ORDER BY m.created_at, m.user_id) <= member_limit AS admitted,
           greatest(m.created_at, public.account_entitlement_pro_ended_at(e, now())) AS free_since
    FROM public.organization_members m
    LEFT JOIN public.account_entitlements e ON e.user_id = m.user_id
    WHERE m.org_id = target_org_id AND public.app_require_system()
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
  END
  FROM ranked
$$;

-- Called per row by the cloud authority clause. A member with Pro among the
-- first member_limit is never held, which answers almost every workspace
-- creator without ranking the whole organization; a function call keeps its
-- plan cached where an inlined subquery would be planned on every request.
CREATE FUNCTION organization_member_on_hold(
  target_org_id uuid, target_user_id uuid, member_limit integer, free_limit integer
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN public.account_pro_active(target_user_id) AND (
      SELECT count(*) FROM public.organization_members me
      JOIN public.organization_members earlier ON earlier.org_id = me.org_id
        AND (earlier.created_at, earlier.user_id) < (me.created_at, me.user_id)
      WHERE me.org_id = target_org_id AND me.user_id = target_user_id) < member_limit
    THEN false
    ELSE EXISTS (
      SELECT 1 FROM public.organization_member_seats(target_org_id, member_limit, free_limit) s
      WHERE s.user_id = target_user_id AND s.seat = 'hold')
  END
$$;
