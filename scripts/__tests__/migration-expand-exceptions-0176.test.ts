import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file="0176_cloud_checkpoint_history_recovery.sql";
const sql=readFileSync(`apps/control-plane/migrations/${file}`,"utf8");

describe("owner checkpoint history expansion",()=>{
  it("admits only the exact additive history and operator-retry exceptions",()=>{
    expect(lintMigrationPhase(file,sql)).toEqual([]);
  });
  it("does not replace final-save proof, dispatch, erasure or positive provider-loss gates",()=>{
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION (?:cloud_final_save_(?:proven|require_dispatch|deletion_claimable)|cloud_workspace_data_purge_authorized|cloud_provider_allocation_lost)\(/);
    expect(sql).not.toMatch(/(?:UPDATE|DELETE FROM|ALTER TABLE) cloud_workspace_provider_loss_attestations\b/);
  });
  it.each([
    sql.replace("NEW.requested_by IS NULL AND NOT NEW.affects_workspace","true"),
    sql.replace("NEW.generation_transition_id,NEW.workspace_id,NEW.org_id,NEW.generation","NEW.generation_transition_id,NEW.workspace_id,NEW.org_id,1"),
    sql.replace("FROM PUBLIC;","FROM zeros_app;"),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g,""),
    `${sql}\nDELETE FROM cloud_workspace_final_save_recoveries;`,
  ])("refuses borrowing a reviewed exception for another mutation",changed=>{
    expect(changed).not.toBe(sql);
    expect(lintMigrationPhase(file,changed).length).toBeGreaterThan(0);
  });
});
