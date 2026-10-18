import { createHash } from "node:crypto";

// Each reviewed migration lists its exact exempted statements by rule.
const reviewed: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "0136_cloud_runtime_transfers.sql": {
    "widen-check": [3, 4, 5].map(n =>
      `ALTER TABLE cloud_workspace_generation_transitions DROP CONSTRAINT cloud_workspace_generation_transitions_check${n};`),
    "nullable-enrollment": ["setup_run_id", "setup_execution_fence", "registration_grant_id"].map(column =>
      `ALTER TABLE cloud_workspace_engine_instances ALTER COLUMN ${column} DROP NOT NULL;`),
    "enrollment-trigger": ["cloud_engine_runtime_binding", "cloud_engine_current_setup_fence"].map(trigger =>
      `DROP TRIGGER ${trigger} ON cloud_workspace_engine_instances;`),
  },
  // 0004's default privileges grant zeros_app writes on every new table.
  "0152_cloud_capability_keys.sql": {
    "new-table-privileges": [
      "REVOKE ALL ON cloud_capability_signing_keys FROM PUBLIC, zeros_app;",
      "REVOKE ALL ON cloud_capability_key_changes FROM PUBLIC, zeros_app;",
      "REVOKE ALL ON cloud_capability_member_epochs FROM PUBLIC, zeros_app;",
      "REVOKE ALL ON cloud_capability_access_losses FROM PUBLIC, zeros_app;",
    ],
    // PUBLIC's default EXECUTE on functions created in the same migration.
    "privilege-tightening": [
      "preserve_cloud_capability_key()",
      "bump_cloud_capability_member_epoch(uuid, uuid)",
      "bump_cloud_capability_org_epochs(uuid)",
      "bump_cloud_capability_user_epochs(uuid)",
      "record_cloud_capability_access_loss(uuid, uuid, uuid)",
      "bump_cloud_capability_member_epoch_trigger()",
      "bump_cloud_capability_writer_slot_epoch()",
      "bump_cloud_capability_user_epochs_trigger()",
      "bump_cloud_capability_org_epochs_trigger()",
      "bump_cloud_capability_invitation_epoch()",
      "reject_cloud_capability_key_change_mutation()",
    ].map(signature => `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`),
    // A guard that rejects TRUNCATE cannot truncate.
    "truncate-guard": [`CREATE TRIGGER cloud_capability_key_changes_no_truncate
  BEFORE TRUNCATE ON cloud_capability_key_changes FOR EACH STATEMENT
  EXECUTE FUNCTION reject_cloud_capability_key_change_mutation();`],
  },
  "0151_cloud_authority_cache_invalidation.sql": {
    // PUBLIC's default EXECUTE on functions created in the same migration.
    "privilege-tightening": [
      "cloud_workspace_engine_authority_snapshot(uuid, uuid, integer, uuid, boolean)",
      "notify_cloud_authority_cache()",
    ].map(signature => `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`),
  },
  "0145_cloud_computer_named_snapshots.sql": {},
  "0146_cloud_provider_snapshot_recovery.sql": {},
  "0158_cloud_drift_inventory_pacing.sql": {},
  "0159_cloud_generation_authority_check.sql": {
    // PUBLIC's default EXECUTE on the function created in the same migration.
    "privilege-tightening": [
      "REVOKE ALL ON FUNCTION enqueue_cloud_workspace_generation_authority_check() FROM PUBLIC;",
    ],
  },
  "0155_cloud_capability_epoch_events.sql": {
    // PUBLIC's default EXECUTE on functions created in the same migration.
    "privilege-tightening": [
      "record_cloud_capability_epoch_event(uuid, uuid, jsonb)",
      "record_cloud_capability_epoch_event_trigger()",
    ].map(signature => `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`),
  },
  "0160_cloud_compute_lease_recheck.sql": {
    // PUBLIC's default EXECUTE on the function created in the same migration.
    "privilege-tightening": [
      "REVOKE ALL ON FUNCTION recheck_cloud_workspace_compute_leases() FROM PUBLIC;",
    ],
  },
  "0149_cloud_rollout_flags.sql": {
    // A guard that rejects TRUNCATE cannot truncate.
    "truncate-guard": [`CREATE TRIGGER cloud_rollout_flag_changes_no_truncate
  BEFORE TRUNCATE ON cloud_rollout_flag_changes FOR EACH STATEMENT
  EXECUTE FUNCTION reject_cloud_rollout_flag_change_mutation();`],
    // REVOKE only narrows the 0004 default DML grant and PUBLIC's EXECUTE.
    "privilege-tightening": [
      "REVOKE ALL ON FUNCTION reject_cloud_rollout_flag_change_mutation() FROM PUBLIC;",
      "REVOKE ALL ON cloud_rollout_flags FROM PUBLIC, zeros_app;",
      "REVOKE ALL ON cloud_rollout_flag_changes FROM PUBLIC, zeros_app;",
    ],
  },
  // The constraint is re-added at once with one more allowed purpose.
  "0141_cloud_runtime_images.sql": {
    "widen-check": ["ALTER TABLE cloud_builder_vm_operations DROP CONSTRAINT cloud_builder_vm_operations_purpose_check;"],
  },
  "0142_cloud_workspace_data_purge.sql": {
    "retain-transfer-audit": ["ALTER TABLE cloud_workspace_allocation_transfers DROP CONSTRAINT cloud_workspace_allocation_tr_transition_id_workspace_id_o_fkey;"],
  },
};
// Exact reviewed function body, including quoted SQL. Changing its semantics or
// even formatting requires updating this review pin and compatibility evidence.
const computerNamedPinDigest = "8ec827f17e5dd360032affa81051498682ab39b8c355284f5b341f30e8126258";
const providerRecoveryEvidenceDigest = "e5f93ac17017bc01286ac0e856530ed299bfb0307622f8f2b850d4d0590993ed";
const authorityDigest = "797f837c345244da5af77d503614c9ddf3abb03048998a0081b98a3c2512ab30";
const deletedBootPointerDigest = "9cff55a9f31819e2468f331b64d2ba978b0e1dd2bdb39d332dad892fe49fc562";
const authorityCacheExemptionDigest = "414aa4d5653660ef6eee4300d1e52889ba36e9ca26f325c12b574ad4b0ad86b7";

/** Split only at top-level SQL semicolons. Dollar bodies, nested comments and
 * quoted values remain intact; an annotation inside a function cannot exempt
 * a nested destructive statement. The ordinary guard still inspects all body
 * statements in every segment that was not explicitly exempted. */
function statements(sql: string): { text: string; header: string }[] {
  const result: { text: string; header: string }[] = [];
  let start = 0, code = -1, i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i]!)) { i++; continue; }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error("Unterminated migration comment");
      continue;
    }
    if (code < 0) code = i;
    const quote = sql[i];
    if (quote === "'" || quote === '"') {
      const escaped = quote === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/[\w$]/.test(sql[i - 2] ?? "");
      i++;
      let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") { i += 2; continue; }
        if (sql[i++] === quote) {
          if (sql[i] === quote) { i++; continue; }
          closed = true; break;
        }
      }
      if (!closed) throw new Error("Unterminated migration quote");
      continue;
    }
    const dollar = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) throw new Error("Unterminated migration body");
      i = end + dollar.length; continue;
    }
    if (sql[i++] === ";") {
      result.push({ header: sql.slice(start, code), text: sql.slice(code, i) });
      start = i; code = -1;
    }
  }
  if (code >= 0) result.push({ header: sql.slice(start, code), text: sql.slice(code) });
  return result;
}

export function applyReviewedExpandExceptions(file: string, sql: string): string {
  if (!sql.includes("zeros-expand-exception:")) return sql;
  const exact = reviewed[file];
  if (!exact) throw new Error("Expand exceptions are reviewed only for listed migrations");
  let accepted = 0;
  const output = statements(sql).map(({ header, text }) => {
    const annotations = [...header.matchAll(/^-- zeros-expand-exception: ([a-z-]+) (\S[^\r\n]{15,})$/gm)];
    if (!annotations.length) return header + text;
    if (annotations.length !== 1) throw new Error("An expand exception must annotate exactly one statement");
    const rule = annotations[0]![1]!;
    const statement = text.replace(/\r\n/g, "\n").trim();
    const allowed = exact[rule]?.includes(statement) || (rule === "allocation-authority" && file === "0136_cloud_runtime_transfers.sql" &&
      createHash("sha256").update(statement).digest("hex") === authorityDigest) ||
      (rule === "deleted-boot-pointer" && file === "0142_cloud_workspace_data_purge.sql" &&
        createHash("sha256").update(statement).digest("hex") === deletedBootPointerDigest) ||
      (rule === "computer-named-pin" && file === "0145_cloud_computer_named_snapshots.sql" &&
        createHash("sha256").update(statement).digest("hex") === computerNamedPinDigest) ||
      (rule === "provider-recovery-evidence" && file === "0146_cloud_provider_snapshot_recovery.sql" &&
        createHash("sha256").update(statement).digest("hex") === providerRecoveryEvidenceDigest) ||
      (rule === "authority-cache-exemption" && file === "0158_cloud_drift_inventory_pacing.sql" &&
        createHash("sha256").update(statement).digest("hex") === authorityCacheExemptionDigest);
    if (!allowed) throw new Error("Expand exception does not match its exact reviewed statement");
    accepted++;
    return "\n";
  }).join("\n");
  if (accepted !== (sql.match(/zeros-expand-exception:/g)?.length ?? 0))
    throw new Error("Expand exception must be a complete annotation before a top-level statement");
  return output;
}
