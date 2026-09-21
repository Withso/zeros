-- A provider image/compute class belongs to the accepted generation. NULL is
-- the existing serialized contract (Daytona container; Boat native VM).
ALTER TABLE cloud_workspace_generations
  ADD COLUMN sandbox_class text CHECK (
    sandbox_class IS NULL OR
    (provider = 'daytona' AND sandbox_class IN ('container', 'linux-vm'))
  );

CREATE FUNCTION preserve_cloud_generation_sandbox_class()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.sandbox_class IS DISTINCT FROM OLD.sandbox_class THEN
    RAISE EXCEPTION 'cloud generation sandbox class is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION preserve_cloud_generation_sandbox_class() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION preserve_cloud_generation_sandbox_class() TO zeros_app;
CREATE TRIGGER cloud_generation_sandbox_class_immutable
  BEFORE UPDATE OF sandbox_class ON cloud_workspace_generations
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_generation_sandbox_class();
