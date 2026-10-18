import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const directory = "apps/control-plane/migrations";
const file = "0158_cloud_drift_inventory_pacing.sql";
const sql = readFileSync(`${directory}/${file}`, "utf8");
const original = readFileSync(`${directory}/0151_cloud_authority_cache_invalidation.sql`, "utf8");
const notifyFunction = (source: string) =>
  /CREATE (?:OR REPLACE )?FUNCTION notify_cloud_authority_cache\(\)[\s\S]*?\nEND \$\$;/.exec(source)![0].replace(/\s+/g, " ");
describe("drift pacing expand compatibility", () => {
  it("replaces only 0151's notify function, widened by the two new bookkeeping columns", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
    expect(sql.match(/zeros-expand-exception:/g)).toHaveLength(1);
    expect(sql.match(/CREATE OR REPLACE/g)).toHaveLength(1);
    const before = "'next_drift_check_at', 'updated_at'";
    expect(notifyFunction(original).split(before)).toHaveLength(3);
    expect(notifyFunction(sql)).toBe(notifyFunction(original)
      .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
      .replaceAll(before, "'next_drift_check_at', 'drift_paced_until', 'drift_inspect_requested', 'updated_at'"));
  });
  it.each([
    sql.replace("'drift_inspect_requested', 'updated_at'", "'drift_inspect_requested', 'provider_resource_id', 'updated_at'"),
    sql.replace("PERFORM pg_notify('zeros_cloud_authority_cache', '*');", "NULL;"),
    sql.replace("authority-cache-exemption", "computer-named-pin"),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/, ""),
    `${sql}\nCREATE OR REPLACE FUNCTION cloud_drift_restore_jobs() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`,
    `${sql}\nDROP TRIGGER cloud_drift_restore_jobs ON cloud_workspace_restore_incidents;`,
  ])("refuses a broader exemption, another replacement or a destructive statement", changed => {
    expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
  });
  it("rejects the exception in any other migration", () => {
    expect(lintMigrationPhase("0154_unrelated.sql", sql).length).toBeGreaterThan(0);
  });
});
