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
