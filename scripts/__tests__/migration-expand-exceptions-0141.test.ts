import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0141_cloud_runtime_images.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");
const drop = "ALTER TABLE cloud_builder_vm_operations DROP CONSTRAINT cloud_builder_vm_operations_purpose_check;";

describe("reviewed runtime-image expand exception", () => {
  it("accepts the shipped migration, whose only exception widens the builder purposes", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
    expect(sql.match(/zeros-expand-exception:/g)).toHaveLength(1);
    expect(sql).toContain(drop);
  });

  it.each([
    ["an unannotated drop", sql.replace(/-- zeros-expand-exception: widen-check[^\n]+\n/, "")],
    ["another constraint", sql.replace("cloud_builder_vm_operations_purpose_check;", "cloud_builder_create_closed_unallocated;")],
    ["an added destructive statement", `${sql}\nDROP TABLE cloud_runtime_images;`],
    ["another rule name", sql.replace("zeros-expand-exception: widen-check", "zeros-expand-exception: nullable-enrollment")],
  ])("rejects %s", (_label, changed) => {
    expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
  });

  it("does not let other migrations borrow either reviewed list", () => {
    expect(lintMigrationPhase("0142_other.sql", sql).length).toBeGreaterThan(0);
    const transfers = readFileSync("apps/control-plane/migrations/0136_cloud_runtime_transfers.sql", "utf8");
    expect(lintMigrationPhase("0136_cloud_runtime_transfers.sql", transfers)).toEqual([]);
    expect(lintMigrationPhase(file, `-- zeros-migration: expand\n-- zeros-expand-exception: widen-check Borrowed from the transfer review.\n` +
      "ALTER TABLE cloud_workspace_generation_transitions DROP CONSTRAINT cloud_workspace_generation_transitions_check3;").length).toBeGreaterThan(0);
  });
});
