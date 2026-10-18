import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0162_cloud_workspace_mandatory_drains.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");
describe("mandatory drains expand compatibility", () => {
  it("admits only privilege tightening on functions first created in this migration", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
  });
  it.each([
    sql.replace("REVOKE ALL ON FUNCTION cloud_workspace_drain_is_mandatory(uuid) FROM PUBLIC;",
      "REVOKE ALL ON FUNCTION cloud_workspace_drain_is_mandatory(uuid) FROM zeros_app;"),
    sql.replace("REVOKE ALL ON FUNCTION cloud_workspace_preserve_mandatory_wake() FROM PUBLIC;",
      "REVOKE ALL ON cloud_workspace_lifecycle_intents FROM PUBLIC;"),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g, ""),
    `${sql}\nREVOKE ALL ON cloud_workspaces FROM zeros_app;`,
    `${sql}\nDROP TABLE cloud_workspace_lifecycle_intents;`,
  ])("rejects a broader revoke, missing annotation or destructive statement", changed => {
    expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
  });
  it("rejects these exceptions in any other migration", () => {
    expect(lintMigrationPhase("0163_unrelated.sql", sql).length).toBeGreaterThan(0);
  });
});
