import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0146_cloud_provider_snapshot_recovery.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");
describe("provider snapshot recovery expand compatibility", () => {
  it("admits only the exact evidence widening while preserving setup evidence", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
  });
  it.each([
    sql.replace("setup_run_id IS NOT NULL", "true"),
    sql.replace("provider_snapshot_missing", "provider_snapshot_unavailable"),
    sql.replace("AND evidence_count=1", ""),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g, ""),
    `${sql}\nDROP TABLE cloud_workspace_restore_incidents;`,
  ])("refuses a broader evidence exception or destructive operation", changed => {
    expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
  });
  it("rejects the exception in any other migration", () => {
    expect(lintMigrationPhase("0145_unrelated.sql", sql).length).toBeGreaterThan(0);
  });
});
