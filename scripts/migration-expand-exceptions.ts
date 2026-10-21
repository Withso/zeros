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
  "0165_cloud_capability_actor_sessions.sql": {
    "nullable-enrollment": ["ALTER TABLE cloud_workspace_actor_sessions ALTER COLUMN token_hash DROP NOT NULL;"],
    "widen-check": ["ALTER TABLE cloud_workspace_actor_sessions DROP CONSTRAINT cloud_actor_source_session_required;"],
    "privilege-tightening": [
      "preserve_cloud_capability_actor_session()",
      "cloud_capability_actor_signing_keys_live(text[])",
      "cloud_workspace_actor_session_source_live(cloud_workspace_actor_sessions, text, boolean, boolean)",
    ].map(signature => `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`),
  },
  "0162_cloud_workspace_mandatory_drains.sql": {
    // PUBLIC's default EXECUTE on functions created in the same migration.
    "privilege-tightening": [
      "cloud_workspace_drain_is_mandatory(uuid)",
      "cloud_workspace_preserve_capture_deadline()",
      "cloud_workspace_preserve_mandatory_drain()",
      "cloud_workspace_preserve_mandatory_wake()",
      "cloud_workspace_require_retired_wake_source()",
    ].map(signature => `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`),
  },
  "0166_cloud_accepted_work.sql": {
    // PUBLIC's default EXECUTE on the new system-only key fence.
    "privilege-tightening": [
      "REVOKE ALL ON FUNCTION cloud_accepted_work_key_live(text) FROM PUBLIC;",
    ],
  },
  "0169_cloud_compute_observation_rechecks.sql": {
    // This runtime trigger purges only new scheduling data at the existing
    // workspace erasure boundary. It neither deletes during expansion nor
    // changes retention of any pre-existing table.
    "new-scheduling-purge": [`CREATE FUNCTION purge_cloud_compute_rechecks() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  DELETE FROM cloud_workspace_compute_rechecks WHERE workspace_id=NEW.id AND org_id=NEW.org_id;
  RETURN NEW;
END $$;`],
  },
  "0171_cloud_final_save_recovery.sql": {
    // These constraints are replaced immediately with the legacy states plus
    // finite successor attempts. Neither statement removes an authority fence.
    "widen-check": [
      "ALTER TABLE workspace_checkpoint_requests DROP CONSTRAINT workspace_checkpoint_requests_state_check;",
      "ALTER TABLE workspace_checkpoint_requests DROP CONSTRAINT workspace_checkpoint_requests_check1;",
    ],
    "privilege-tightening": [
      "ensure_cloud_final_save_recovery(uuid)",
      "cloud_final_save_admitted()",
      "cloud_final_save_request_link()",
      "cloud_final_save_attempt_immutable()",
      "cloud_final_save_proven(uuid)",
      "cloud_final_save_adopt_proof(uuid)",
      "cloud_final_save_committed()",
      "cloud_final_save_require_dispatch()",
      "cloud_final_save_preserve_lifecycle()",
      "cloud_final_save_preserve_transition()",
      "cloud_final_save_preserve_candidate()",
      "cloud_final_save_source_immutable()",
      "cloud_final_save_attempt_settled()",
      "cloud_final_save_jobs()",
      "cloud_final_save_dispatch_claimed()",
      "cloud_final_save_hold_source()",
      "cloud_final_save_failure_audit()",
      "cloud_final_save_deletion_claimable(uuid,uuid)",
      "cloud_final_save_protect_erasure()",
      "cloud_final_save_request_erasure()",
      "cloud_final_save_request_erased()",
      "cloud_accepted_lifecycle_scope()",
      "cloud_restart_prerequisite_scope()",
      "cloud_restart_ready(uuid)",
      "cloud_workspace_accepted_lifecycle(uuid,uuid)",
      "cloud_accepted_lifecycle_changed()",
    ].map(signature => `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`),
  },
  "0172_cloud_owner_checkpoint_recovery.sql": {
    "widen-check": ["ALTER TABLE cloud_workspace_final_save_recoveries DROP CONSTRAINT cloud_workspace_final_save_recoveries_state_check;"],
    "new-table-privileges": ["REVOKE ALL ON cloud_workspace_owner_discard_receipts FROM PUBLIC,zeros_app;"],
    "truncate-guard": [`CREATE TRIGGER cloud_owner_discard_no_truncate BEFORE TRUNCATE ON cloud_workspace_owner_discard_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION guard_cloud_owner_discard_receipt();`],
    "privilege-tightening": [`REVOKE ALL ON FUNCTION guard_cloud_owner_discard_receipt(),require_cloud_owner_discard_transition(),cloud_owner_discard_retire_intent(),
  cloud_owner_discard_hold_capture(),cloud_owner_discard_skip_lost_cleanup(),cloud_final_save_owner_discarded(uuid) FROM PUBLIC;`],
  },
  "0173_cloud_owner_recovery_safety_stop.sql": {
    "privilege-tightening": [`REVOKE ALL ON FUNCTION cloud_owner_discard_recovery_digest(uuid),
  cloud_owner_discard_safety_stop_matches(uuid,uuid,integer,uuid,uuid,uuid,uuid,bytea) FROM PUBLIC;`],
  },
  "0175_cloud_unstarted_candidate_cleanup.sql": {
    "widen-check": ["ALTER TABLE cloud_workspace_final_save_recoveries DROP CONSTRAINT cloud_workspace_final_save_recoveries_state_check;"],
    "new-table-privileges": ["REVOKE UPDATE,DELETE,TRUNCATE ON cloud_workspace_unstarted_candidate_cleanup FROM PUBLIC,zeros_app;"],
    "truncate-guard": [`CREATE TRIGGER cloud_unstarted_candidate_no_truncate BEFORE TRUNCATE ON cloud_workspace_unstarted_candidate_cleanup
  FOR EACH STATEMENT EXECUTE FUNCTION guard_cloud_unstarted_candidate_receipt();`],
    "privilege-tightening": [`REVOKE ALL ON FUNCTION cloud_unstarted_candidate_source(uuid),cloud_unstarted_candidate_current(uuid),guard_cloud_unstarted_candidate_receipt(),
  cloud_unstarted_candidate_hold_capture(),adopt_cloud_unstarted_candidate_cleanup(uuid),cloud_unstarted_candidate_hold_source(),
  cloud_final_save_dispatchable(uuid),require_cloud_unstarted_candidate_retirement() FROM PUBLIC;`],
  },
  "0179_cloud_initial_delete_capture.sql": {
    "initial-delete-capture-privileges": ["REVOKE ALL ON cloud_workspace_initial_delete_captures FROM PUBLIC,zeros_app;"],
    "truncate-guard": [`CREATE TRIGGER cloud_initial_delete_capture_no_truncate BEFORE TRUNCATE ON cloud_workspace_initial_delete_captures
  FOR EACH STATEMENT EXECUTE FUNCTION guard_cloud_initial_delete_capture();`],
    "privilege-tightening": [`REVOKE ALL ON FUNCTION cloud_initial_delete_capture_source(uuid,boolean),guard_cloud_initial_delete_capture(),
  require_cloud_initial_delete_capture(),admit_cloud_initial_delete_capture(uuid,bytea,boolean) FROM PUBLIC;`],
  },
  "0178_cloud_owner_existing_delete.sql": {},
  "0177_cloud_owner_discard_delete.sql": {
    "new-table-privileges": ["REVOKE ALL ON cloud_workspace_owner_delete_receipts,cloud_workspace_owner_delete_dispositions FROM PUBLIC,zeros_app;"],
    "truncate-guard": [
      `CREATE TRIGGER cloud_owner_delete_receipt_no_truncate BEFORE TRUNCATE ON cloud_workspace_owner_delete_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION guard_cloud_owner_delete_receipt();`,
      `CREATE TRIGGER cloud_owner_delete_disposition_no_truncate BEFORE TRUNCATE ON cloud_workspace_owner_delete_dispositions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_cloud_owner_delete_disposition();`,
    ],
    "privilege-tightening": [`REVOKE ALL ON FUNCTION cloud_owner_delete_source(uuid),guard_cloud_owner_delete_receipt(),guard_cloud_owner_delete_disposition(),
  cloud_owner_delete_current(uuid),cloud_owner_delete_hold_intent(),require_cloud_owner_delete_atomic(),cloud_owner_delete_hold_source(),
  cloud_owner_delete_lock_recovery_source(),cloud_owner_delete_hold_capture_facts(),cloud_owner_delete_hold_data() FROM PUBLIC;`],
  },
  "0174_cloud_lifecycle_scheduling.sql": {
    "privilege-tightening": [
      "cloud_lifecycle_allocation_wait_status(uuid)",
      "preserve_cloud_lifecycle_allocation_wait()",
      "require_cloud_lifecycle_allocation_dependency()",
      "cloud_lifecycle_allocation_wait_jobs()",
      "cloud_lifecycle_allocation_settled_jobs()",
      "cloud_lifecycle_allocation_scope_jobs()",
      "retire_cloud_lifecycle_allocation_wait()",
      "purge_cloud_lifecycle_allocation_waits()",
    ].map(signature => `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`),
    // Only the new scheduling data follows the pre-existing erasure boundary.
    "new-scheduling-purge": [`CREATE FUNCTION purge_cloud_lifecycle_allocation_waits() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  DELETE FROM cloud_workspace_lifecycle_allocation_waits WHERE workspace_id=NEW.id AND org_id=NEW.org_id;
  RETURN NEW;
END $$;`],
  },
  "0176_cloud_checkpoint_history_recovery.sql": {
    "widen-check": ["ALTER TABLE cloud_agent_credential_source_retirements DROP CONSTRAINT cloud_agent_credential_source_retirements_proof_kind_check;"],
    "new-table-privileges": [
      "REVOKE ALL ON cloud_workspace_owner_recovery_retries FROM PUBLIC,zeros_app;",
      "REVOKE UPDATE,TRUNCATE ON cloud_agent_checkpoint_history_snapshots FROM PUBLIC,zeros_app;",
    ],
    "truncate-guard": [
      `CREATE TRIGGER cloud_owner_recovery_retry_no_truncate BEFORE TRUNCATE ON cloud_workspace_owner_recovery_retries
  FOR EACH STATEMENT EXECUTE FUNCTION preserve_cloud_owner_recovery_retry();`,
      `CREATE TRIGGER cloud_checkpoint_history_snapshot_no_truncate BEFORE TRUNCATE ON cloud_agent_checkpoint_history_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION preserve_cloud_checkpoint_history_snapshot();`,
    ],
    "privilege-tightening": [
      "REVOKE ALL ON FUNCTION cloud_owner_discard_history_receipt(uuid),preserve_cloud_checkpoint_history_snapshot() FROM PUBLIC;",
      `REVOKE ALL ON FUNCTION cloud_owner_recovery_retry_ready(uuid,uuid,uuid,uuid),preserve_cloud_owner_recovery_retry(),
  require_cloud_owner_recovery_retry_transition(),cloud_owner_discard_transition_receipt(uuid,uuid,uuid,integer) FROM PUBLIC;`,
    ],
    // N-1 cleanup writers may skip only the original positively lost source
    // through an immutable operator retry of its exact discard transition.
    "owner-retry-lost-cleanup": [`CREATE OR REPLACE FUNCTION cloud_owner_discard_skip_lost_cleanup() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.operation IN ('stop','delete') AND NEW.requested_by IS NULL AND NOT NEW.affects_workspace
    AND cloud_owner_discard_transition_receipt(NEW.generation_transition_id,NEW.workspace_id,NEW.org_id,NEW.generation) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;`],
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
// New recovery metadata is erased only after the existing request erasure is
// authorized. The replacement purge predicate retains the existing fences and
// additionally refuses unsaved recoveries or unresolved provider dispatches.
const finalSavePurgeDigest = "06350d1e7c16d53a5dd4b49171ff868755547a455e12fc92e1419dca28d86da1";
const finalSavePurgeAuthorityDigest = "1ffca4f787df85c473fe19c450b7cac2729c504aac4853f54a5d8a1f21b0dfee";
// 0172 changes only the unresolved-history predicates: an exact owner-only
// discard is a separate disposition, never final proof or dispatch authority.
const ownerDiscardHistoryDigest = "b51397a2eba733a22244bab9ca0059e0ad2e9f64b75992922f98b6ffd695b5df";
const ownerDiscardPurgeDigest = "552d05c7361c026239ef4b08f72ff6f2e6a5514a1a334e52f8e07d4a80a44318";
// Optional 0173 companions retain v1 receipt behavior and add only the exact
// safety Stop disposition. Pin whole statements, including every refusal.
const ownerDiscardSafetyDigests: Record<string,string> = {
  "owner-discard-safety-guard": "431be2403d3b46db9f60e943da9fac9799ee75b387058091420d188a0066e4c7",
  "owner-discard-safety-disposition": "59c024f127915c9ec65528fc7bf32bf23c7e4cde107541ef99734269663bf9d5",
  "owner-discard-safety-retirement": "674a58e6886c9341a1d8ddde10eec3dea1da964e08ef70f82faa0a1331b57aff",
  "owner-discard-safety-transition": "6468791de8211c3fdf74a0678d419ca5dc65275f894ea5bd81563e5422a1bb3f",
};

// These whole statements preserve real save proof and the existing provider
// retirement/erasure gates, adding only exact never-started candidate custody.
const unstartedCandidateDigests: Record<string,string> = {
  "candidate-dispatch": "09044968651f6f51f34f1ab4d59eae410615930dc11f3fa73294cd766dd0801e",
  "candidate-history": "a35f1bea1be1d8960ab3fec7a5ee23e5e3c81ca78608b18bb33fa16dec8e56a6",
  "candidate-purge": "cde2e5c569b87bfd6adc2bd373f954db82c661c55df557c336054ef649968f0f",
};

// Explicit complete loss permits one ordinary Delete. Pin only these scoped
// extensions; checkpoint proof and physical data-purge authority stay intact.
const ownerDeleteDigests: Record<string,string> = {
  "owner-delete-disposition": "08da6b4a619fe610dedf0b426655d18d2929c6c97e7ce04aa5fb118dfead01c9",
  "owner-delete-dispatch": "46cf98bf6c907f4da51b586f5263c50f8152d2d3be240256595e131dcfbe34e8",
  "owner-delete-failure": "97dd1238301f36de9a27188a8637289ed8ce7a0c7bac854c184281712471667f",
  "owner-delete-erasure": "f9ad30f4845bbb178eede1256a90014ae24f3c473dd525d967395d438529b184",
};

// One first-source completion retains the complete pre-binding recovery.
const initialDeleteSourceDigest = "73ff2ed9852c36aff906dc03c688e7bb1036d83db04c7f533f88979b22916a5b";

// Exact additions retain prior save proof and physical-purge authority.
const ownerExistingDeleteDigests: Record<string,string> = {
  "new-table-privileges": "5dcd878e4e2935bddcf73f215d27bd635dde05c6ecea4e29b07911e0ed542699",
  "truncate-guard": "94c229ad90475d9cf2c51ea2534669c2465b63d3adc5fc3677145e93172c942a",
  "privilege-tightening": "278774e5015f08a153b37fc287b31c7de58781684701fa299a43af6ba4eda15d",
  "retired-stop-enrollment": "0d2ee62ce3ee74c6b70e4d3a4659b5cdc2294f80990ad6ad3c231bcd8764be07",
  "existing-delete-disposition": "7868657bef6e6df6b152e35fa83c4640d88c8977fdb3d4a088279a38b5933614",
  "existing-delete-dispatch": "3b94db9135e9f621335c2dd4d47d31b66d12bdb0b261cdb8d6e53cb9e28c6433",
  "existing-delete-failure": "34425ace259b828584dc44bdedc4a23bbcc656a0ce02dfa25ae193d9b9783f68",
  "existing-delete-erasure": "b1486df5cbb74afeb49e1d2b63c2f5ee5db1332cdcb6f6544bbedabbabd9f0db",
  "existing-delete-source-hold": "a3d84af36e73438c73537c690e97f6fdd1c76b905c63a966be6037bf1d0f4833",
  "existing-delete-capture-hold": "f6a39e1eaa5b9806bcb729cd8806f313ca9ace516a42e346ea94cf25d529b3ed",
  "existing-delete-data-hold": "0258ee7a3527eb0834a4cf6b51706d624a1fed430f7e2d702374930f5dfcabc6",
};

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
        createHash("sha256").update(statement).digest("hex") === authorityCacheExemptionDigest) ||
      (rule === "final-save-purge" && file === "0171_cloud_final_save_recovery.sql" &&
        createHash("sha256").update(statement).digest("hex") === finalSavePurgeDigest) ||
      (rule === "final-save-purge-authority" && file === "0171_cloud_final_save_recovery.sql" &&
        createHash("sha256").update(statement).digest("hex") === finalSavePurgeAuthorityDigest) ||
      (rule === "owner-discard-history" && file === "0172_cloud_owner_checkpoint_recovery.sql" &&
        createHash("sha256").update(statement).digest("hex") === ownerDiscardHistoryDigest) ||
      (rule === "owner-discard-purge" && file === "0172_cloud_owner_checkpoint_recovery.sql" &&
        createHash("sha256").update(statement).digest("hex") === ownerDiscardPurgeDigest) ||
      (file === "0173_cloud_owner_recovery_safety_stop.sql" &&
        createHash("sha256").update(statement).digest("hex") === ownerDiscardSafetyDigests[rule]) ||
      (file === "0175_cloud_unstarted_candidate_cleanup.sql" &&
        createHash("sha256").update(statement).digest("hex") === unstartedCandidateDigests[rule]) ||
      (file === "0177_cloud_owner_discard_delete.sql" &&
        createHash("sha256").update(statement).digest("hex") === ownerDeleteDigests[rule]) ||
      (file === "0179_cloud_initial_delete_capture.sql" && rule === "initial-delete-source" &&
        createHash("sha256").update(statement).digest("hex") === initialDeleteSourceDigest) ||
      (file === "0178_cloud_owner_existing_delete.sql" &&
        createHash("sha256").update(statement).digest("hex") === ownerExistingDeleteDigests[rule]);
    if (!allowed) throw new Error("Expand exception does not match its exact reviewed statement");
    accepted++;
    return "\n";
  }).join("\n");
  if (accepted !== (sql.match(/zeros-expand-exception:/g)?.length ?? 0))
    throw new Error("Expand exception must be a complete annotation before a top-level statement");
  return output;
}
