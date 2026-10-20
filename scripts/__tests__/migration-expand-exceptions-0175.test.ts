import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0175_cloud_unstarted_candidate_cleanup.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");
const previous = readFileSync("apps/control-plane/migrations/0172_cloud_owner_checkpoint_recovery.sql", "utf8");
function body(source: string, name: string) {
  const start = source.indexOf(`FUNCTION ${name}(`), end = source.indexOf("$$;", start) + 3;
  return source.slice(start, end);
}

describe("never-started candidate cleanup expansion", () => {
  it("admits only the exact private receipt and dispatch/history exceptions", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
  });
  it("preserves all original history, current-save, custody and physical-erasure predicates", () => {
    for (const name of ["cloud_final_save_deletion_claimable", "cloud_workspace_data_purge_authorized"]) {
      const changed = body(sql, name).replace(/\n\s+AND NOT EXISTS \(SELECT 1 FROM cloud_workspace_unstarted_candidate_cleanup receipt\n\s+WHERE receipt.lifecycle_intent_id=(?:recovery|cloud_workspace_final_save_recoveries).lifecycle_intent_id\)/, "");
      expect(changed).toBe(body(previous, name));
    }
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION cloud_final_save_proven\(/);
    expect(sql).toContain("state IN ('capturing','retrying','reconciling','blocked','proven','resolved','discarded','not_required')");
  });
  it.each([
    sql.replace("IF NOT cloud_final_save_dispatchable(NEW.id)", "IF false"),
    sql.replace("AND workspace.status='deleted' AND workspace.desired_state='deleted'", "AND true"),
    sql.replace("WHERE receipt.lifecycle_intent_id=recovery.lifecycle_intent_id", "WHERE true"),
    sql.replace("FROM PUBLIC;", "FROM zeros_app;"),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g, ""),
    `${sql}\nDELETE FROM cloud_workspace_final_save_recoveries;`,
  ])("rejects borrowing the reviewed exceptions for broader authority", changed => {
    expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
  });
});
