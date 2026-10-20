import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file="0172_cloud_owner_checkpoint_recovery.sql";
const sql=readFileSync(`apps/control-plane/migrations/${file}`,"utf8");
const previous=readFileSync("apps/control-plane/migrations/0171_cloud_final_save_recovery.sql","utf8");
function body(source:string,name:string) {
  const start=source.indexOf(`FUNCTION ${name}(`),end=source.indexOf("$$;",start)+3;
  return source.slice(start,end);
}

describe("owner discard expansion is exact and additive",()=>{
  it("admits only the reviewed private receipt and historical-disposition exceptions",()=>{
    expect(lintMigrationPhase(file,sql)).toEqual([]);
  });
  it("preserves every historical and physical erasure condition except the exact acknowledged recovery",()=>{
    for(const name of ["cloud_final_save_deletion_claimable","cloud_workspace_data_purge_authorized"]){
      const changed=body(sql,name).replace(/\n\s+AND NOT cloud_final_save_owner_discarded\((?:recovery\.)?lifecycle_intent_id\)/,"");
      expect(changed).toBe(body(previous,name));
    }
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION cloud_final_save_(?:proven|require_dispatch)\(/);
    expect(sql.match(/ALTER TABLE cloud_workspace_final_save_recoveries[^;]+;/g)).toEqual([
      "ALTER TABLE cloud_workspace_final_save_recoveries DROP CONSTRAINT cloud_workspace_final_save_recoveries_state_check;",
      "ALTER TABLE cloud_workspace_final_save_recoveries ADD CONSTRAINT cloud_workspace_final_save_recoveries_state_check\n  CHECK (state IN ('capturing','retrying','reconciling','blocked','proven','resolved','discarded'));",
    ]);
  });
  it.each([
    sql.replaceAll("AND NOT cloud_final_save_owner_discarded(recovery.lifecycle_intent_id)","AND false"),
    sql.replace("AND workspace.status='deleted' AND workspace.desired_state='deleted'","AND true"),
    sql.replace("REVOKE ALL ON cloud_workspace_owner_discard_receipts FROM PUBLIC,zeros_app;","REVOKE ALL ON cloud_workspaces FROM zeros_app;"),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g,""),
    `${sql}\nDELETE FROM cloud_workspace_final_save_recoveries;`,
  ])("rejects broadened exemptions and unrelated erasure",changed=>{
    expect(lintMigrationPhase(file,changed).length).toBeGreaterThan(0);
  });
  it("refuses borrowing these exceptions for another migration",()=>{
    expect(lintMigrationPhase("0173_unrelated.sql",sql).length).toBeGreaterThan(0);
  });
});
