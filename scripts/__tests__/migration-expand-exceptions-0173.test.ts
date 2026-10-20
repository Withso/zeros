import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file="0173_cloud_owner_recovery_safety_stop.sql";
const sql=readFileSync(`apps/control-plane/migrations/${file}`,"utf8");

describe("owner recovery safety Stop expansion",()=>{
  it("admits only the exact receipt extensions and private predicate privileges",()=>{
    expect(lintMigrationPhase(file,sql)).toEqual([]);
  });
  it("does not replace final proof, dispatch, loss evidence or physical erasure gates",()=>{
    expect(sql).not.toMatch(/(?:UPDATE|DELETE FROM|ALTER TABLE) cloud_workspace_provider_loss_attestations\b/);
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION (?:cloud_final_save_(?:proven|require_dispatch|deletion_claimable)|cloud_workspace_data_purge_authorized)\(/);
    expect(sql.match(/ALTER TABLE ([a-z_]+)/g)?.every(row=>row==="ALTER TABLE cloud_workspace_owner_discard_receipts")).toBe(true);
  });
  it.each([
    sql.replace("FROM PUBLIC;","FROM zeros_app;"),
    sql.replace("stop_intent_id=target_intent_id OR safety_stop_intent_id=target_intent_id","true"),
    sql.replace("NEW.loss_lookup_observed_at BETWEEN clock_timestamp()-interval '15 minutes' AND clock_timestamp()","true"),
    sql.replace("NEW.safety_stop_intent_id IS NOT NULL AND NOT EXISTS (","false AND NOT EXISTS ("),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g,""),
    `${sql}\nDELETE FROM cloud_workspace_final_save_recoveries;`,
  ])("rejects borrowing the privilege exception for other work",changed=>{
    expect(lintMigrationPhase(file,changed).length).toBeGreaterThan(0);
  });
});
