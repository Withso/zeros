import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0123_example.sql", expand = (sql: string) => `-- zeros-migration: expand\n${sql}`;
describe("migration-phase CI lint", () => {
  it("keeps every released 0001–0121 migration legacy and requires a first-line phase on newer files", () => {
    expect(lintMigrationPhase("0121_legacy.sql", "ALTER TABLE example DROP COLUMN legacy;")).toEqual([]);
    expect(lintMigrationPhase(file, "ALTER TABLE example ADD COLUMN nullable text;")[0]).toMatch(/must start/);
    expect(lintMigrationPhase(file, "-- description\n-- zeros-migration: expand\nSELECT 1;")[0]).toMatch(/must start/);
    expect(lintMigrationPhase(file, "-- zeros-migration: legacy\nSELECT 1;")[0]).toMatch(/must start/);
  });
  it.each([
    "DROP TABLE example;", "ALTER TABLE example DROP COLUMN legacy;", "ALTER TABLE example DROP CONSTRAINT example_check;",
    "ALTER TABLE example DROP legacy;", "ALTER TABLE example RENAME TO changed;", "ALTER TABLE example RENAME COLUMN old TO newer;",
    'ALTER TABLE "example" ALTER COLUMN "value" TYPE integer;', "ALTER TABLE example ALTER value SET DATA TYPE uuid;",
    "ALTER TABLE example ALTER COLUMN value SET NOT NULL;", "TRUNCATE example;", "DELETE FROM example;",
    "ALTER TABLE example ADD COLUMN required text NOT NULL;", "ALTER TABLE example SET SCHEMA archived;",
    "REVOKE SELECT ON example FROM zeros_app;", "CREATE OR REPLACE FUNCTION existing() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;",
    "DO $body$ BEGIN ALTER TABLE example DROP COLUMN old; END $body$;", "DO $$ BEGIN EXECUTE 'ALTER TABLE example DROP COLUMN old'; END $$;",
    "DO $$ BEGIN DO $nested$ BEGIN DROP TABLE example; END $nested$; END $$;",
  ])("rejects a destructive expand statement: %s", sql => {
    expect(lintMigrationPhase(file, expand(sql)).length).toBeGreaterThan(0);
  });
  it.each([
    "CREATE TRIGGER audit_change BEFORE UPDATE OR DELETE ON example FOR EACH ROW EXECUTE FUNCTION audit_change();",
    "CREATE TRIGGER audit_change AFTER INSERT OR DELETE ON example FOR EACH ROW EXECUTE PROCEDURE audit_change();",
    "CREATE TRIGGER audit_change BEFORE INSERT ON example FOR EACH ROW EXECUTE FUNCTION audit_change();",
    "CREATE CONSTRAINT TRIGGER audit_change AFTER DELETE ON example DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION audit_change();",
    "CREATE TRIGGER audit_change INSTEAD OF DELETE ON example FOR EACH ROW EXECUTE FUNCTION audit_change();",
    "DO $$ BEGIN CREATE TRIGGER audit_change BEFORE DELETE ON example FOR EACH ROW EXECUTE FUNCTION audit_change(); END $$;",
    "DO $$ BEGIN IF true THEN CREATE TRIGGER audit_change BEFORE DELETE ON example FOR EACH ROW EXECUTE FUNCTION audit_change(); END IF; END $$;",
    "DO $$ BEGIN IF true THEN CREATE POLICY delete_own ON example FOR DELETE USING (true); END IF; END $$;",
    "DO $$ BEGIN IF EXISTS (SELECT 1 FROM example e JOIN child c ON c.parent_id = e.id) THEN GRANT EXECUTE ON FUNCTION audit_change() TO zeros_app; END IF; END $$;",
    "CREATE FUNCTION grant_execution() RETURNS void LANGUAGE SQL AS $$ GRANT EXECUTE ON FUNCTION audit_change() TO zeros_app; $$;",
    "CREATE POLICY delete_own ON example FOR DELETE TO zeros_app USING (true);",
    "GRANT SELECT, INSERT, UPDATE, DELETE ON example TO zeros_app;",
  ])("accepts a non-destructive DELETE or trigger EXECUTE clause: %s", sql => {
    expect(lintMigrationPhase(file, expand(sql))).toEqual([]);
  });
  it.each(["CASCADE", "RESTRICT", "SET NULL", "SET DEFAULT", "NO ACTION"])("accepts foreign-key referential actions: %s", action => {
    expect(lintMigrationPhase(file, expand(`CREATE TABLE child (parent_id integer REFERENCES example(id) ON DELETE ${action} ON UPDATE ${action});`))).toEqual([]);
    expect(lintMigrationPhase(file, expand(`ALTER TABLE child ADD CONSTRAINT child_parent FOREIGN KEY (parent_id) REFERENCES example(id) ON UPDATE ${action} ON DELETE ${action};`))).toEqual([]);
  });
  it.each([
    "DELETE;",
    "DELETE FROM example;",
    "WITH d AS (DELETE FROM example RETURNING 1) SELECT 1;",
    "CREATE FUNCTION dangerous() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM example; END $$;",
    "CREATE FUNCTION dangerous() RETURNS void LANGUAGE SQL AS $$ DELETE FROM example; $$;",
    "DO $$ BEGIN DELETE FROM example; END $$;",
    "CREATE FUNCTION dangerous() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM example; RETURN OLD; END $$; CREATE TRIGGER audit_change AFTER DELETE ON example FOR EACH ROW EXECUTE FUNCTION dangerous();",
    "CREATE TRIGGER audit_change AFTER DELETE ON example FOR EACH ROW EXECUTE FUNCTION dangerous(); CREATE FUNCTION dangerous() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM example; RETURN OLD; END $$;",
    "GRANT DELETE ON example TO zeros_app; DELETE FROM example;",
    "CREATE POLICY delete_own ON example FOR DELETE USING (true); WITH d AS (DELETE FROM example RETURNING 1) SELECT 1;",
    "CREATE TABLE child (parent_id integer REFERENCES example(id) ON DELETE CASCADE); DELETE FROM example;",
  ])("still rejects DELETE statements without borrowing another statement's context: %s", sql => {
    expect(lintMigrationPhase(file, expand(sql))).toContain(`${file}: expand migrations may not contain DELETE.`);
  });
  it.each([
    "DO $$ BEGIN EXECUTE 'DROP TABLE example'; END $$;",
    "CREATE FUNCTION dangerous() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'DROP TABLE example'; END $$;",
    "CREATE TRIGGER audit_change AFTER DELETE ON example FOR EACH ROW EXECUTE FUNCTION audit_change(); DO $$ BEGIN EXECUTE 'DROP TABLE example'; END $$;",
    "GRANT EXECUTE ON FUNCTION audit_change() TO zeros_app; DO $$ BEGIN EXECUTE 'DROP TABLE example'; END $$;",
  ])("still rejects dynamic EXECUTE in executable bodies: %s", sql => {
    expect(lintMigrationPhase(file, expand(sql))).toContain(`${file}: expand migrations may not contain dynamic SQL EXECUTE.`);
  });
  it("keeps REVOKE forbidden alongside permitted grants", () => {
    expect(lintMigrationPhase(file, expand("GRANT DELETE ON example TO zeros_app; REVOKE DELETE ON example FROM zeros_app;"))).toContain(`${file}: expand migrations may not contain REVOKE.`);
  });
  it("ignores comments and literal or quoted-identifier keywords", () => {
    expect(lintMigrationPhase(file, expand(`
      -- DROP TABLE ignored;
      /* RENAME /* SET NOT NULL */ ignored */
      CREATE TABLE "DROP" ("RENAME" text DEFAULT 'DROP TABLE hidden');
      SELECT $$DROP TABLE literal$$;
      ALTER TABLE example ADD COLUMN extra text;
    `))).toEqual([]);
  });
  it.each([
    "DO 'BEGIN DROP TABLE example; END';",
    "DO E'BEGIN DROP TABLE example; END';",
    "DO U&'BEGIN DROP TABLE example; END';",
    "DO LANGUAGE plpgsql 'BEGIN DROP TABLE example; END';",
    "CREATE FUNCTION dangerous() RETURNS void LANGUAGE plpgsql AS 'BEGIN DROP TABLE example; END';",
    "CREATE FUNCTION dangerous() RETURNS void LANGUAGE plpgsql AS U&'BEGIN DROP TABLE example; END';",
    "CREATE PROCEDURE dangerous() LANGUAGE plpgsql AS E'BEGIN DROP TABLE example; END';",
    "DO $$ BEGIN DO 'BEGIN DROP TABLE example; END'; END $$;",
    "DO 'BEGIN PERFORM 1; END';",
  ])("requires inspectable dollar quoting for executable expand bodies: %s", sql => {
    expect(lintMigrationPhase(file, expand(sql))[0]).toMatch(/dollar quot/i);
  });
  it("keeps non-executable strings opaque within additive function declarations", () => {
    expect(lintMigrationPhase(file, expand(`
      CREATE FUNCTION additive(message text DEFAULT E'DROP TABLE literal', documentation text DEFAULT $literal$DROP TABLE literal$literal$) RETURNS text
      LANGUAGE SQL AS $$ SELECT message; $$;
      COMMENT ON FUNCTION additive(text, text) IS U&'DROP TABLE documentation';
      INSERT INTO example (value) VALUES ('safe') ON CONFLICT (value) DO UPDATE SET value = 'DROP TABLE literal';
    `))).toEqual([]);
  });
  it("accepts the additive phase ledger and non-null columns with compatible defaults", () => {
    expect(lintMigrationPhase("0122_migration_phases.sql", expand("SET LOCAL lock_timeout = '5s'; ALTER TABLE schema_migrations ADD COLUMN phase text NOT NULL DEFAULT 'legacy';"))).toEqual([]);
    expect(lintMigrationPhase(file, expand("ALTER TABLE example ADD COLUMN phase text NOT NULL DEFAULT 'legacy';"))).toEqual([]);
  });
  it("does not mistake a foreign-key SET DEFAULT action for a new column's default", () => {
    expect(lintMigrationPhase(file, expand("ALTER TABLE child ADD COLUMN parent_id integer NOT NULL REFERENCES example(id) ON DELETE SET DEFAULT;"))).toContain(`${file}: expand migrations may not contain ADD NOT NULL without a compatible DEFAULT.`);
    expect(lintMigrationPhase(file, expand("ALTER TABLE child ADD COLUMN parent_id integer NOT NULL DEFAULT 1 REFERENCES example(id) ON DELETE SET DEFAULT;"))).toEqual([]);
  });
  it("allows least-privilege function execution grants without allowing dynamic SQL execution", () => {
    expect(lintMigrationPhase(file, expand("CREATE FUNCTION new_addition() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$; GRANT EXECUTE ON FUNCTION new_addition() TO zeros_app;"))).toEqual([]);
    expect(lintMigrationPhase(file, expand("GRANT EXECUTE ON FUNCTION new_addition() TO zeros_app; DO $$ BEGIN EXECUTE 'DROP TABLE example'; END $$;"))).not.toEqual([]);
  });
  it("requires a real UTC not-before date on contract files but permits destructive SQL there", () => {
    expect(lintMigrationPhase(file, "-- zeros-migration: contract\nDROP TABLE example;")[0]).toMatch(/zeros-contract-after/);
    for (const date of ["2026-02-30", "2026-13-01", "2026-1-01", "tomorrow"]) {
      expect(lintMigrationPhase(file, `-- zeros-migration: contract\n-- zeros-contract-after: ${date}\nDROP TABLE example;`).length).toBeGreaterThan(0);
    }
    expect(lintMigrationPhase(file, "-- zeros-migration: contract\n-- zeros-contract-after: 2026-12-01\nDROP TABLE example;")).toEqual([]);
  });
});
