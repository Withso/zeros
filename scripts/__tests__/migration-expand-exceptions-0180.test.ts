import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0180_cloud_initial_delete_periodic_checkpoint.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");
const original = readFileSync("apps/control-plane/migrations/0179_cloud_initial_delete_capture.sql", "utf8");
const periodic = `
      AND NOT (c.reason='periodic' AND c.generation=1 AND c.state='durable' AND c.invalidated_at IS NULL
        AND c.authority_epoch=w.authority_epoch AND c.created_at>=e.registered_at))`;
function source(text: string, marker: string) {
  const start = text.indexOf(marker);
  return text.slice(start, text.indexOf("$$;", start) + 3);
}

describe("initial Delete periodic checkpoint migration", () => {
  it("replaces only the checkpoint clause of the reviewed first-source function", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
    const replaced = source(sql, "CREATE OR REPLACE FUNCTION cloud_initial_delete_capture_source(");
    expect(replaced.replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION").replace(periodic, ")"))
      .toBe(source(original, "CREATE FUNCTION cloud_initial_delete_capture_source("));
  });

  it("changes no other function, table, privilege or row", () => {
    expect(sql.match(/CREATE (?:OR REPLACE )?(?:FUNCTION|TABLE|TRIGGER|POLICY)/g)).toEqual(["CREATE OR REPLACE FUNCTION"]);
    expect(sql).not.toMatch(/\b(?:GRANT|REVOKE|INSERT|UPDATE|DELETE|ALTER|DROP)\b/);
  });

  it.each([
    sql.replace("c.reason='periodic'", "c.reason IN ('periodic','manual')"),
    sql.replace(" AND c.created_at>=e.registered_at", ""),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g, ""),
    `${sql}\nDELETE FROM workspace_checkpoints;`,
  ])("rejects an unreviewed expansion", changed => {
    expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
  });
});
