-- 0004 granted DML on every table already present, including the migration
-- ledger. Runtime verification must not imply authority to rewrite evidence.
-- The stable database/migration owner retains upgrade authority.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.schema_migrations FROM zeros_app;
GRANT SELECT ON TABLE public.schema_migrations TO zeros_app;
