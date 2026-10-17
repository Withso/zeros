import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const directory = "apps/control-plane/migrations";
const file = "0149_cloud_rollout_flags.sql";
const sql = readFileSync(`${directory}/${file}`, "utf8");
describe("rollout flags expand compatibility", () => {
  it("admits only the exact truncate guard and privilege tightening", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
  });
  it.each([
    sql.replace("BEFORE TRUNCATE ON cloud_rollout_flag_changes", "AFTER TRUNCATE ON cloud_rollout_flags"),
    sql.replace("REVOKE ALL ON cloud_rollout_flags FROM PUBLIC, zeros_app;", "REVOKE ALL ON cloud_workspaces FROM PUBLIC, zeros_app;"),
    `${sql}\nREVOKE ALL ON cloud_workspace_lifecycle_intents FROM zeros_app;`,
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g, ""),
    `${sql}\nTRUNCATE cloud_rollout_flags;`,
  ])("refuses a broader exception or a real destructive statement", changed => {
    expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
  });
  it("rejects the exceptions in any other migration", () => {
    expect(lintMigrationPhase("0148_unrelated.sql", sql).length).toBeGreaterThan(0);
  });
  it("lints every shipped migration clean", () => {
    const findings = readdirSync(directory).filter(name => name.endsWith(".sql")).sort()
      .flatMap(name => lintMigrationPhase(name, readFileSync(`${directory}/${name}`, "utf8")));
    expect(findings).toEqual([]);
  });
});
