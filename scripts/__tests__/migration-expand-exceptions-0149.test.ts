import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const directory = "apps/control-plane/migrations";
const file = "0149_cloud_rollout_flags.sql";
const sql = readFileSync(`${directory}/${file}`, "utf8");

describe("reviewed rollout-flag expand exception", () => {
  it("accepts the shipped migration, whose only exceptions narrow its own new tables", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
    expect(sql.match(/zeros-expand-exception:/g)).toHaveLength(2);
  });

  it.each([
    ["an unannotated revoke", sql.replace(/-- zeros-expand-exception: new-table-privileges[^\n]+\n/, "")],
    ["another table", sql.replace("REVOKE ALL ON cloud_rollout_flags FROM", "REVOKE ALL ON organizations FROM")],
    ["a truncate trigger", `${sql}\nCREATE TRIGGER t BEFORE TRUNCATE ON cloud_rollout_flags FOR EACH STATEMENT EXECUTE FUNCTION f();`],
  ])("rejects %s", (_label, changed) => {
    expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
  });

  it("does not let another migration borrow the list", () => {
    expect(lintMigrationPhase("0150_other.sql", sql).length).toBeGreaterThan(0);
  });

  it("lints every shipped migration clean", () => {
    const findings = readdirSync(directory).filter(name => name.endsWith(".sql")).sort()
      .flatMap(name => lintMigrationPhase(name, readFileSync(`${directory}/${name}`, "utf8")));
    expect(findings).toEqual([]);
  });
});
