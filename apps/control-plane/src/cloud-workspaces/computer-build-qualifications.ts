import { createHash } from "node:crypto";
import type { Tx } from "../db.js";
import { ROLLOUT_FLAGS_OFF, type RolloutFlagReader } from "../rollout-flags.js";
import { canonicalBuildQualification, CloudComputerBuildQualificationSchema, CloudComputerBuildSelectionSchema,
  type CloudComputerBuildQualification, type CloudComputerBuildSelection,
  type CloudComputerQualificationSelection } from "./computer-build-qualification-contract.js";
import { loadPinnedCloudRuntime } from "./runtime-selection.js";
import type { CloudRuntimeQualificationMode } from "./runtime-config.js";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest();
function unavailable(): never { throw new Error("cloud_computer_build_qualification_unavailable"); }
type EvidenceRow = { id: string; canonical_evidence: string; evidence_sha256: Buffer; revoked_at: Date | null };
type BuildRow = {
  config_id: string; runtime_id: string; base_image_id: string; state: string; stage: string;
  worker_fence: string; helper_fence: string | null; deadline_at: Date | null; cancel_requested_at: Date | null;
  handoff_at: Date | null; started_at: Date | null; completed_at: Date | null;
  template_state: string; account_scope: string | null; billing_org: string | null; provider_resource_id: string | null;
  builder_operation_key: string | null; protected_contract_digest: Buffer | null; manifest_sha256: Buffer | null;
  stopped_at: Date | null;
};

/** Callers own the organization/build admission transaction. These locks must
 * remain held through publication; no external I/O belongs in this module. */
async function lockBuild(tx: Tx, org: string, buildId: string, write = false): Promise<BuildRow> {
  const row = (await tx.query<BuildRow>(`SELECT build.*,template.state AS template_state,template.account_scope,
    template.billing_org,template.provider_resource_id,template.builder_operation_key,template.protected_contract_digest,
    template.manifest_sha256,template.stopped_at FROM cloud_computer_v2_builds build
    JOIN cloud_computer_templates template ON template.build_id=build.id AND template.org_id=build.org_id
    WHERE build.id=$1 AND build.org_id=$2 FOR ${write ? "UPDATE" : "SHARE"} OF build,template`, [buildId, org])).rows[0];
  return row ?? unavailable();
}
async function readEvidence(tx: Tx, org: string, buildId: string): Promise<EvidenceRow | undefined> {
  // Never filter revocation/eligibility here: that would turn rejection into
  // "no proof was ever recorded" and silently select the legacy path.
  return (await tx.query<EvidenceRow>(`SELECT id,canonical_evidence,evidence_sha256,revoked_at
    FROM cloud_computer_build_qualifications WHERE build_id=$1 AND org_id=$2 FOR SHARE`, [buildId, org])).rows[0];
}
function parseEvidence(row: EvidenceRow): CloudComputerBuildQualification {
  try {
    const evidence = CloudComputerBuildQualificationSchema.parse(JSON.parse(row.canonical_evidence));
    if (canonicalBuildQualification(evidence) !== row.canonical_evidence ||
      !hash(row.canonical_evidence).equals(row.evidence_sha256)) unavailable();
    return evidence;
  } catch { return unavailable(); }
}
function bindBuild(build: BuildRow, evidence: CloudComputerBuildQualification) {
  if (build.config_id !== evidence.scope.configId || build.runtime_id !== evidence.runtime.runtimeId ||
    build.base_image_id !== evidence.base.baseImageId || build.account_scope !== evidence.scope.accountScope ||
    build.billing_org !== evidence.scope.billingOrg || build.provider_resource_id !== evidence.builder.sandboxId ||
    build.builder_operation_key !== evidence.builder.operationKey || Number(build.helper_fence) !== evidence.builder.helperFence ||
    evidence.builder.workerFence > Number(build.worker_fence) ||
    build.protected_contract_digest?.toString("hex") !== evidence.base.protectedContractSha256) unavailable();
}
async function validateRegistry(tx: Tx, evidence: CloudComputerBuildQualification, mode: CloudRuntimeQualificationMode) {
  const runtime = await loadPinnedCloudRuntime(tx, { ...evidence.runtime, ...evidence.base, profile: "zeros-cloud-worker-v4" }, mode);
  if (!runtime || runtime.descriptor.archiveSha256 !== evidence.runtime.archiveSha256) unavailable();
  const base = (await tx.query(`SELECT 1 FROM cloud_runtime_base_images base
    JOIN cloud_runtime_base_contracts contract USING(base_compatibility_id)
    WHERE base.base_image_id=$1 AND base.source_commit=$2 AND base.architecture=$3
      AND contract.contract_sha256=$4 AND base.approved_at<=clock_timestamp()`,
  [evidence.base.baseImageId, evidence.base.sourceCommit, evidence.base.architecture, evidence.base.compatibilitySha256])).rowCount;
  if (!base) unavailable();
}

/** Dormant producer boundary. The full build helper will call this after its
 * complete probes and cleanup; no workspace producer uses it in this slice. */
export async function recordComputerBuildQualification(tx: Tx, input: {
  evidence: unknown; workerFence: number; qualificationMode?: CloudRuntimeQualificationMode;
}): Promise<{ qualificationId: string; evidenceSha256: string }> {
  const parsed = CloudComputerBuildQualificationSchema.safeParse(input.evidence);
  if (!parsed.success || !Number.isSafeInteger(input.workerFence)) unavailable();
  const evidence = parsed.data, scope = evidence.scope;
  const build = await lockBuild(tx, scope.organizationId, scope.buildId, true);
  bindBuild(build, evidence);
  if (build.state !== "running" || build.stage !== "integrity" || build.template_state !== "pending" ||
    build.cancel_requested_at || build.handoff_at || Number(build.worker_fence) !== input.workerFence || !build.started_at ||
    Date.parse(evidence.qualifiedAt) < build.started_at.getTime()) unavailable();
  await validateRegistry(tx, evidence, input.qualificationMode ?? "full");
  const journal = (await tx.query(`SELECT 1 FROM cloud_builder_vm_operations WHERE account_scope=$1 AND operation_key=$2
    AND purpose='computer-build' AND sandbox_id=$3 AND state='ready' FOR SHARE`,
  [scope.accountScope, evidence.builder.operationKey, evidence.builder.sandboxId])).rowCount;
  if (!journal) unavailable();
  const canonical = canonicalBuildQualification(evidence), digest = hash(canonical);
  let row = await readEvidence(tx, scope.organizationId, scope.buildId);
  if (!row) {
    // The original producer must hold the current fence. A later handoff can
    // reread identical acknowledged evidence, but cannot invent its result.
    if (evidence.builder.workerFence !== input.workerFence) unavailable();
    row = (await tx.query<EvidenceRow>(`INSERT INTO cloud_computer_build_qualifications
      (build_id,config_id,org_id,runtime_id,runtime_manifest_sha256,base_image_id,base_compatibility_id,canonical_evidence,evidence_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,canonical_evidence,evidence_sha256,revoked_at`,
    [scope.buildId, scope.configId, scope.organizationId, evidence.runtime.runtimeId, evidence.runtime.manifestSha256,
      evidence.base.baseImageId, evidence.base.baseCompatibilityId, canonical, digest])).rows[0];
  }
  if (!row || row.revoked_at || row.canonical_evidence !== canonical || !row.evidence_sha256.equals(digest)) unavailable();
  // INSERT (or a lock before it) can wait. Transaction-start now() is not a
  // freshness witness; check the current clock after all waits, before commit.
  if (!(await tx.query(`SELECT 1 FROM cloud_computer_v2_builds WHERE id=$1
    AND deadline_at>clock_timestamp() AND $2::timestamptz<=clock_timestamp()`, [scope.buildId, evidence.qualifiedAt])).rowCount) unavailable();
  return { qualificationId: row.id, evidenceSha256: digest.toString("hex") };
}

export type ComputerBuildQualificationInput = {
  organizationId: string; buildId: string; configId: string; runtimeId: string; baseImageId: string; baseCompatibilityId: string;
  channel: CloudComputerBuildQualification["scope"]["channel"]; accountScope: string; billingOrg: string;
  policySha256: string; resourcePolicySha256: string; runnerVersion?: 1;
  runtimeVersion?: 1; baseVersion?: 1; qualificationMode?: CloudRuntimeQualificationMode;
};

/** Dormant selection, for an already authorized exact saved source. Missing
 * evidence may select full qualification. Recorded but invalid evidence never
 * does. A required selection is a pinned attempt and ignores rollout changes. */
export async function selectComputerBuildQualification(tx: Tx, input: ComputerBuildQualificationInput,
  options: { flags?: RolloutFlagReader; required?: CloudComputerBuildSelection } = {}): Promise<CloudComputerQualificationSelection> {
  const required = options.required === undefined ? undefined : CloudComputerBuildSelectionSchema.safeParse(options.required);
  if (required && !required.success) unavailable();
  const supported = input.runtimeVersion === 1 && input.baseVersion === 1;
  if (required && !supported) unavailable();
  const build = await lockBuild(tx, input.organizationId, input.buildId);
  if (build.config_id !== input.configId || build.base_image_id !== input.baseImageId ||
    build.account_scope !== input.accountScope || build.billing_org !== input.billingOrg) unavailable();
  const row = await readEvidence(tx, input.organizationId, input.buildId);
  if (!row || build.runtime_id !== input.runtimeId) {
    if (required) unavailable();
    return { mode: "full" }; // A newly selected runtime needs its own qualification.
  }
  const evidence = parseEvidence(row);
  bindBuild(build, evidence);
  if (row.revoked_at) unavailable();
  // An operator rollback disables new selections; it cannot rehabilitate a
  // revoked proof, or change an already selected attempt's qualification mode.
  if (!required && (!(options.flags ?? ROLLOUT_FLAGS_OFF).enabled(input.organizationId, "build_qualification") ||
    !supported)) return { mode: "full" };
  if (evidence.scope.channel !== input.channel || evidence.base.baseCompatibilityId !== input.baseCompatibilityId ||
    evidence.policy.sha256 !== input.policySha256 || evidence.policy.resourcePolicySha256 !== input.resourcePolicySha256 ||
    evidence.policy.runnerVersion !== input.runnerVersion || build.state !== "succeeded" || build.stage !== "done" ||
    !build.completed_at || build.cancel_requested_at || build.template_state !== "ready" || !build.stopped_at ||
    build.manifest_sha256?.toString("hex") !== evidence.sanitationManifestSha256) unavailable();
  await validateRegistry(tx, evidence, input.qualificationMode ?? "full");
  const snapshot = (await tx.query<{ snapshot_name: string; snapshot_id: string; tree_sha256: Buffer }>(
    `SELECT snapshot_name,snapshot_id,tree_sha256 FROM cloud_computer_template_snapshots
    WHERE build_id=$1 AND org_id=$2 AND state='ready' AND channel=$3 AND account_scope=$4 AND billing_org=$5
      AND source_sandbox_id=$6 AND manifest_sha256=$7 AND verified_at IS NOT NULL AND ready_at IS NOT NULL
      AND snapshot_id IS NOT NULL AND tree_sha256 IS NOT NULL FOR SHARE`,
  [input.buildId, input.organizationId, input.channel, input.accountScope, input.billingOrg,
    evidence.builder.sandboxId, Buffer.from(evidence.sanitationManifestSha256, "hex")])).rows[0];
  if (!snapshot) unavailable();
  const selection = CloudComputerBuildSelectionSchema.parse({ mode: "build", qualificationId: row.id,
    evidenceSha256: row.evidence_sha256.toString("hex"), evidence,
    snapshot: { name: snapshot.snapshot_name, snapshotId: snapshot.snapshot_id, treeSha256: snapshot.tree_sha256.toString("hex") } });
  if (required?.success && (required.data.qualificationId !== selection.qualificationId ||
    required.data.evidenceSha256 !== selection.evidenceSha256 || canonicalBuildQualification(required.data.evidence) !== row.canonical_evidence ||
    required.data.snapshot.name !== selection.snapshot.name || required.data.snapshot.snapshotId !== selection.snapshot.snapshotId ||
    required.data.snapshot.treeSha256 !== selection.snapshot.treeSha256)) unavailable();
  return selection;
}
