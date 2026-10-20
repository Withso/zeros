import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0177_cloud_owner_discard_delete.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");
const previous = readFileSync("apps/control-plane/migrations/0175_cloud_unstarted_candidate_cleanup.sql", "utf8");
const original = readFileSync("apps/control-plane/migrations/0171_cloud_final_save_recovery.sql", "utf8");
function body(source: string, name: string) {
  const start = source.indexOf(`FUNCTION ${name}(`), end = source.indexOf("$$;", start) + 3;
  return source.slice(start, end);
}

describe("complete-loss Delete migration", () => {
  it("admits only the exact operator receipt, disposition, dispatch and erasure extensions", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
  });
  it("keeps existing dispatch and unsaved-failure guards byte-identical outside the new authority", () => {
    expect(body(sql,"cloud_final_save_dispatchable").replace(" OR cloud_owner_delete_current(target_intent_id)",""))
      .toBe(body(previous,"cloud_final_save_dispatchable"));
    expect(body(sql,"cloud_final_save_preserve_lifecycle").replace(" AND NOT cloud_owner_delete_current(OLD.id)",""))
      .toBe(body(original,"cloud_final_save_preserve_lifecycle"));
  });
  it("keeps all unresolved history and custody checks and never redefines final proof or physical purge", () => {
    const next = body(sql,"cloud_final_save_deletion_claimable");
    const marker = "        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_receipts receipt";
    const prefix = next.slice(0,next.indexOf(marker)).trimEnd();
    expect(prefix+")\n$$;").toBe(body(previous,"cloud_final_save_deletion_claimable"));
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION (?:cloud_final_save_proven|cloud_workspace_data_purge_authorized)\(/);
  });
  it.each([
    sql.replace("OR cloud_owner_delete_current(target_intent_id)","OR true"),
    sql.replace("AND NOT cloud_owner_delete_current(OLD.id)","AND false"),
    sql.replace("WHERE lifecycle_intent_id=target_intent_id)","WHERE true)"),
    sql.replaceAll("AND deletion.state='succeeded'","AND true"),
    sql.replace("FROM PUBLIC,zeros_app;","FROM PUBLIC;"),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g,""),
    `${sql}\nDELETE FROM cloud_workspace_final_save_recoveries;`,
  ])("rejects borrowing the reviewed exceptions to broaden authority", changed => {
    expect(lintMigrationPhase(file,changed).length).toBeGreaterThan(0);
  });
});
