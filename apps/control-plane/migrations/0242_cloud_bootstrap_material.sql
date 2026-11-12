-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_execution_contexts ADD COLUMN bootstrap_material_issued boolean;

-- Older replicas also write material. The delivery receipt must survive their
-- writes and subsequent erasure before a retry can prove nothing was issued.
CREATE FUNCTION capture_cloud_bootstrap_material() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.material IS NOT NULL OR (TG_OP='UPDATE' AND
      (OLD.material IS NOT NULL OR OLD.bootstrap_material_issued IS TRUE)) THEN
    NEW.bootstrap_material_issued := true;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_bootstrap_material BEFORE INSERT OR UPDATE OF material,bootstrap_material_issued,state,user_id
  ON cloud_v2_execution_contexts FOR EACH ROW WHEN (NEW.kind='bootstrap')
  EXECUTE FUNCTION capture_cloud_bootstrap_material();

-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from the new bootstrap material receipt trigger
REVOKE ALL ON FUNCTION capture_cloud_bootstrap_material() FROM PUBLIC;
