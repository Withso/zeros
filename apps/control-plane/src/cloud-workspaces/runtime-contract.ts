import { z } from "zod";

// The control plane is an isolated Zod 3 build. These trust-boundary readers
// follow packages/protocol's v4 contracts; runtime-contract.test.ts runs the
// shared fixtures without pulling the desktop/package build into deployment.
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const runtimeId = z.string().regex(/^r1-[a-f0-9]{64}$/);
const compatibilityId = z.string().regex(/^bc1-[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const integer = z.number().int().nonnegative().safe();
const protocolVersion = z.number().int().min(1).max(65_535);
const sameIdentity = (value: { runtimeId: string; manifestSha256: string }) => value.runtimeId === `r1-${value.manifestSha256}`;

export const RuntimeDescriptorSchema = z.object({
  runtimeId, manifestSha256: digest, archiveSha256: digest,
  archiveBytes: integer.positive().max(2 * 1024 ** 3), expandedBytes: integer.positive().max(4 * 1024 ** 3),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), nodeModulesAbi: protocolVersion,
  bootstrapProtocolVersion: z.literal(1), engineProtocolVersion: protocolVersion,
}).strict().refine(sameIdentity);
export type RuntimeDescriptor = z.infer<typeof RuntimeDescriptorSchema>;
export const RUNTIME_INSTALL_MAX_ENCODED_BYTES = 64 * 1024;
const scope = {
  schema: z.literal("zeros.runtime-install/v1"), runtime: RuntimeDescriptorSchema,
  artifact: z.object({
    url: z.string().url().max(RUNTIME_INSTALL_MAX_ENCODED_BYTES).refine(value => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.hash;
      } catch { return false; }
    }),
    expiresAt: z.string().datetime({ offset: true }),
  }).strict(),
};
export const RuntimeInstallInputSchema = z.discriminatedUnion("purpose", [
  z.object({ ...scope, purpose: z.literal("workspace-setup"), setup: z.string().min(1) }).strict(),
  z.object({ ...scope, purpose: z.literal("build") }).strict(),
  z.object({ ...scope, purpose: z.literal("qualification") }).strict(),
]).refine(value => Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") * 4 / 3) <= RUNTIME_INSTALL_MAX_ENCODED_BYTES);

export const RuntimeBaseStatusSchema = z.object({
  schema: z.literal("zeros.base-status/v1"), baseCompatibilityId: compatibilityId, bootId: uuid,
  currentRuntimeId: runtimeId.nullable(), hostState: z.enum(["idle", "waiting_for_runtime", "stopped", "failed"]),
}).strict();

const witness = z.object({ runtimeId, manifestSha256: digest, baseCompatibilityId: compatibilityId,
  installerReceiptSha256: digest, bootId: uuid, supervisorSessionId: uuid }).strict();
export const CloudRuntimeWitnessSchema = witness.refine(sameIdentity);
export type CloudRuntimeWitness = z.infer<typeof CloudRuntimeWitnessSchema>;
export const CloudAgentRuntimeSchema = z.union([
  z.object({ profile: z.literal("zeros-cloud-worker-v3"), contractSha256: digest }).strict(),
  witness.extend({ profile: z.literal("zeros-cloud-worker-v4") }).strict().refine(sameIdentity),
]);
export type CloudAgentRuntime = z.infer<typeof CloudAgentRuntimeSchema>;
export type CloudRuntimeWitnessRow = { runtime_installer_receipt_sha256: string | null;
  runtime_boot_id: string | null; runtime_supervisor_session_id: string | null };

export function cloudRuntimeWitnessValues(value: CloudRuntimeWitness | null | undefined) {
  return [value?.installerReceiptSha256 ?? null, value?.bootId ?? null, value?.supervisorSessionId ?? null];
}

const constant = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
const installerStages = new Set(["validate_input", "lock", "check_space", "check_cache", "download", "verify_archive", "verify_manifest",
  "extract", "verify_tree", "publish_receipt", "switch_pointer", "start_host", "run_setup", "done"]);
const installerChecks = new Set(["input_schema", "input_too_large", "artifact_host", "artifact_expired", "lock_busy", "insufficient_space", "cache_conflict",
  "http_status", "download_truncated", "archive_digest", "archive_size", "manifest_digest", "manifest_schema", "bootstrap_protocol",
  "base_compatibility", "archive_paths", "archive_member_type", "file_inventory", "file_digest", "file_mode", "symlink_escape", "root_ownership", "hard_link", "cgroup_retired",
  "pointer_publish", "host_start", "setup_exit", "timeout", "process_signal", "diagnostic_missing"]);
export const ClosedDiagnosticSchema = z.object({
  schema: z.literal("zeros.diagnostic/v1"), component: z.enum(["bundle", "publication", "base", "bootstrap", "installer", "attester", "setup", "qualification", "cleanup", "build"]),
  stage: constant, ok: z.boolean(), exitCode: integer.max(255).nullable(), timedOut: z.boolean(), failedChecks: z.array(constant).max(32),
}).strict().refine(value => new Set(value.failedChecks).size === value.failedChecks.length &&
  (value.component !== "installer" || (installerStages.has(value.stage) && value.failedChecks.every(check => installerChecks.has(check)))));
