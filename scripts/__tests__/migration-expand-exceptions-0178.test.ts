import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file="0178_cloud_owner_existing_delete.sql";
const sql=readFileSync(`apps/control-plane/migrations/${file}`,"utf8");
const previous=readFileSync("apps/control-plane/migrations/0177_cloud_owner_discard_delete.sql","utf8");
const original=readFileSync("apps/control-plane/migrations/0171_cloud_final_save_recovery.sql","utf8");
function body(source:string,name:string) {
  const start=source.indexOf(`FUNCTION ${name}(`),end=source.indexOf("$$;",start)+3;
  return source.slice(start,end);
}
describe("existing Delete loss migration", () => {
  it("admits only the exact new receipt and erasure extensions", () => {
    expect(lintMigrationPhase(file,sql)).toEqual([]);
  });
  it("retains prior enrollment, dispatch, disposition and failure authority", () => {
    expect(body(sql,"ensure_cloud_final_save_recovery").replace("    AND NOT cloud_final_save_retired_compute_stop(intent.id)\n",""))
      .toBe(body(original,"ensure_cloud_final_save_recovery"));
    expect(body(sql,"cloud_final_save_dispatchable").replace(" OR cloud_owner_existing_delete_current(target_intent_id)",""))
      .toBe(body(previous,"cloud_final_save_dispatchable"));
    expect(body(sql,"cloud_final_save_preserve_lifecycle").replace(" AND NOT cloud_owner_existing_delete_current(OLD.id)",""))
      .toBe(body(previous,"cloud_final_save_preserve_lifecycle"));
    expect(body(sql,"cloud_final_save_owner_discarded").replace("\n    OR EXISTS (SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts WHERE recovery_intent_id=target_intent_id)",""))
      .toBe(body(previous,"cloud_final_save_owner_discarded"));
  });
  it("retains physical purge and final-save proof without redefining either", () => {
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION (?:cloud_final_save_proven|cloud_workspace_data_purge_authorized)\(/);
    const marker="        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts receipt";
    const next=body(sql,"cloud_final_save_deletion_claimable")
      .replace("        AND NOT cloud_final_save_retired_compute_stop(intent.id)\n","")
      .replace("        AND NOT cloud_owner_delete_captured_idle_history(intent.id)\n","");
    expect(next.slice(0,next.indexOf(marker)).trimEnd()+")\n$$;").toBe(body(previous,"cloud_final_save_deletion_claimable"));
  });
  it.each([
    sql.replace("OR cloud_owner_existing_delete_current(target_intent_id)","OR true"),
    sql.replace("AND NOT cloud_owner_existing_delete_current(OLD.id)","AND false"),
    sql.replace("AND NOT cloud_final_save_retired_compute_stop(intent.id)","AND false"),
    sql.replace("AND NOT cloud_owner_delete_captured_idle_history(intent.id)","AND false"),
    sql.replace("FROM PUBLIC,zeros_app;","FROM PUBLIC;"),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g,""),
    `${sql}\nDELETE FROM cloud_workspace_final_save_recoveries;`,
  ])("rejects changes outside the reviewed exceptions", changed => {
    expect(lintMigrationPhase(file,changed).length).toBeGreaterThan(0);
  });
});
