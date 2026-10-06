import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0136_cloud_runtime_transfers.sql";
const statement = "ALTER TABLE cloud_workspace_engine_instances ALTER COLUMN setup_run_id DROP NOT NULL;";
const annotated = `-- zeros-expand-exception: nullable-enrollment Existing rows retain the validated legacy requirement.\n${statement}`;
const expand = (sql: string) => `-- zeros-migration: expand\n${sql}`;

describe("reviewed runtime-transfer expand exceptions", () => {
  it("accepts only the named statement with its annotation in 0136", () => {
    expect(lintMigrationPhase(file, expand(annotated))).toEqual([]);
    expect(lintMigrationPhase("0135_other.sql", expand(annotated)).length).toBeGreaterThan(0);
    expect(lintMigrationPhase(file, expand(statement)).length).toBeGreaterThan(0);
    expect(lintMigrationPhase(file, expand(annotated.replace("setup_run_id DROP", "account_user_id DROP"))).length).toBeGreaterThan(0);
  });
  it.each([
    `${annotated}\nDROP TABLE users;`,
    annotated.replace(";", ", DROP COLUMN id;"),
    `DO $$ BEGIN\n${annotated}\nEND $$;`,
    `CREATE FUNCTION malicious() RETURNS void LANGUAGE sql AS $$\n${annotated}\n$$;`,
    annotated.replace("nullable-enrollment", "anything"),
    annotated.replace("Existing rows retain the validated legacy requirement.", ""),
    `-- zeros-expand-exception: nullable-enrollment Unattached annotation after statement.\nSELECT 1;`,
    `SELECT $$\n${annotated}\n$$;\n${statement}`,
    `/* outer /* nested */ -- zeros-expand-exception: nullable-enrollment Hidden annotation. */\n${statement}`,
  ])("rejects an altered, nested, misplaced or unannotated statement", sql => {
    expect(lintMigrationPhase(file, expand(sql)).length).toBeGreaterThan(0);
  });
  it("pins the whole compute-authority body and retains the default guard for all other statements", () => {
    const sql = readFileSync("apps/control-plane/migrations/0136_cloud_runtime_transfers.sql", "utf8");
    expect(lintMigrationPhase(file, sql)).toEqual([]);
    expect(lintMigrationPhase(file, sql.replace("lease.funded_until > clock_timestamp()", "true")).length).toBeGreaterThan(0);
    expect(lintMigrationPhase(file, sql.replace("public.cloud_workspace_compute_authority_live", "public.anything_else")).length).toBeGreaterThan(0);
    expect(lintMigrationPhase(file, sql.replace(/-- zeros-expand-exception: widen-check[^\n]+\n/, "")).length).toBeGreaterThan(0);
    expect(lintMigrationPhase(file, sql + "\nTRUNCATE users;").length).toBeGreaterThan(0);
  });
});
