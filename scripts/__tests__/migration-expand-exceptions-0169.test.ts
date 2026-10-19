import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0169_cloud_compute_observation_rechecks.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

describe("compute observation scheduling expansion", () => {
  it("permits only exact scoped erasure of the newly added scheduling data", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
  });
  it.each([
    sql.replace("DELETE FROM cloud_workspace_compute_rechecks", "DELETE FROM managed_compute_allocation_leases"),
    sql.replace(" WHERE workspace_id=NEW.id AND org_id=NEW.org_id", ""),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g, ""),
    `${sql}\nDELETE FROM cloud_workspace_compute_rechecks;`,
  ])("rejects broader cleanup or an unannotated deletion", changed => {
    expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
  });
  it("refuses reuse by another migration", () => {
    expect(lintMigrationPhase("0171_unrelated.sql", sql).length).toBeGreaterThan(0);
  });
});
