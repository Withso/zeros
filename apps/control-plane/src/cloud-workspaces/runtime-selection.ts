import { RuntimeDescriptorSchema, type RuntimeDescriptor } from "./runtime-contract.js";
import type { Tx } from "../db.js";
import type { CloudRuntimeQualificationMode } from "./runtime-config.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { HttpError } from "../authz.js";
import { z } from "zod";

// Mirrored at the private protocol boundary (the control plane uses Zod 3).
const nativeCapabilitiesSchema = z.object({ version: z.literal(1), goals: z.boolean(),
  nativeFork: z.boolean(), transcriptFork: z.boolean(), nativeReview: z.boolean(),
  connectedApps: z.boolean(), multiAgent: z.boolean() }).strict();
export function runtimeNativeCapabilities(value: unknown) {
  const parsed = nativeCapabilitiesSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export class CloudRuntimeError extends HttpError {
  constructor(code: "cloud_runtime_revoked" | "cloud_runtime_unavailable") {
    super(409, code, code === "cloud_runtime_revoked"
      ? "This workspace runtime was revoked. Request an explicit runtime upgrade to continue."
      : "The pinned cloud runtime is unavailable. Request an explicit runtime upgrade to continue.");
  }
}

export type CloudRuntimePin = {
  runtimeId: string;
  manifestSha256: string;
  baseImageId: string;
  baseCompatibilityId: string;
  profile: "zeros-cloud-worker-v4";
  engineProtocolVersion: number;
};

export type CloudRuntimePinRow = {
  runtime_id: string | null;
  runtime_manifest_sha256: string | null;
  runtime_base_image_id: string | null;
  runtime_base_compatibility_id: string | null;
  runtime_profile: "zeros-cloud-worker-v4" | null;
  runtime_engine_protocol_version: number | null;
};

export function cloudRuntimePin(row: CloudRuntimePinRow): CloudRuntimePin | null {
  if (row.runtime_id === null) return null; // The database requires all six or none.
  return { runtimeId: row.runtime_id, manifestSha256: row.runtime_manifest_sha256!,
    baseImageId: row.runtime_base_image_id!, baseCompatibilityId: row.runtime_base_compatibility_id!,
    profile: row.runtime_profile!, engineProtocolVersion: row.runtime_engine_protocol_version! };
}

export function cloudRuntimePinValues(pin: CloudRuntimePin | null | undefined) {
  return [pin?.runtimeId ?? null, pin?.manifestSha256 ?? null, pin?.baseImageId ?? null,
    pin?.baseCompatibilityId ?? null, pin?.profile ?? null, pin?.engineProtocolVersion ?? null];
}

// Only repository-owned SQL expressions/parameter positions are passed here.
// Callers bind runtime, compatibility and credential kind before this predicate.
export function runtimeQualificationPredicate(mode: string, requireMcp = "false"): string {
  return `qualification.profile = 'zeros-cloud-worker-v4'
    AND qualification.enabled AND qualification.revoked_at IS NULL
    AND (qualification.evidence->>'mode' = 'full'
      OR (${mode}::text = 'smoke' AND qualification.evidence->>'mode' = 'smoke'))
    AND (NOT (${requireMcp}) OR qualification.mcp_qualified)`;
}

/** Shared by grant discovery and every execution/renewal admission. Callers
 * provide generation, engine and credential aliases; the v3 branch keeps its
 * image/contract identity while v4 requires the saved generation pin. */
export function runtimeCredentialQualificationJoin(mode: string, requireMcp: string): string {
  return `JOIN LATERAL (
    SELECT qualification.native_capabilities,qualification.mcp_qualified FROM cloud_agent_runtime_qualifications qualification
    WHERE generation.runtime_id IS NULL AND engine.runtime_id IS NULL
      AND qualification.provider=generation.provider::text AND qualification.image_ref=generation.image_ref
      AND qualification.runtime_contract_sha256=engine.agent_runtime_contract_sha256 AND qualification.profile=engine.agent_runtime_profile
      AND qualification.profile='zeros-cloud-worker-v3' AND qualification.credential_kind=credential.kind AND qualification.enabled
      AND (NOT (${requireMcp}) OR qualification.mcp_qualified)
    UNION ALL
    SELECT qualification.native_capabilities,qualification.mcp_qualified FROM cloud_runtime_qualifications qualification
    JOIN cloud_runtime_bundles bundle ON bundle.runtime_id=qualification.runtime_id AND bundle.revoked_at IS NULL
    JOIN cloud_runtime_base_images base ON base.base_image_id=generation.runtime_base_image_id
      AND base.base_compatibility_id=qualification.base_compatibility_id AND base.revoked_at IS NULL
    JOIN cloud_runtime_base_contracts contract ON contract.base_compatibility_id=base.base_compatibility_id AND contract.revoked_at IS NULL
    WHERE qualification.runtime_id=generation.runtime_id AND qualification.base_compatibility_id=generation.runtime_base_compatibility_id
      AND qualification.credential_kind=credential.kind AND ${runtimeQualificationPredicate(mode, requireMcp)}
      AND bundle.manifest_sha256=generation.runtime_manifest_sha256
      AND bundle.engine_protocol_version=generation.runtime_engine_protocol_version
      AND bundle.engine_protocol_version=${CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION}
      AND ROW(engine.runtime_id,engine.runtime_manifest_sha256,engine.runtime_base_image_id,
        engine.runtime_base_compatibility_id,engine.runtime_profile,engine.runtime_engine_protocol_version)
        = ROW(generation.runtime_id,generation.runtime_manifest_sha256,generation.runtime_base_image_id,
          generation.runtime_base_compatibility_id,generation.runtime_profile,generation.runtime_engine_protocol_version)
  ) qualification ON true`;
}

const REQUIRED_KINDS = ["claude-setup-token", "codex-chatgpt", "cursor-api-key"];
type BaseRow = { base_image_id: string; base_compatibility_id: string; image_ref: string;
  source_commit: string; architecture: "linux/amd64"; storage_mib: string | number };
type BundleRow = { runtime_id: string; manifest_sha256: string; archive_sha256: string;
  archive_bytes: string | number; expanded_bytes: string | number; object_key: string;
  source_commit: string; node_modules_abi: number; bootstrap_protocol_version: 1; engine_protocol_version: number };

function artifact(row: BundleRow): { descriptor: RuntimeDescriptor; objectKey: string } {
  const parsed = RuntimeDescriptorSchema.safeParse({ runtimeId: row.runtime_id, manifestSha256: row.manifest_sha256,
    archiveSha256: row.archive_sha256, archiveBytes: Number(row.archive_bytes), expandedBytes: Number(row.expanded_bytes),
    sourceCommit: row.source_commit, nodeModulesAbi: row.node_modules_abi,
    bootstrapProtocolVersion: row.bootstrap_protocol_version, engineProtocolVersion: row.engine_protocol_version });
  if (!parsed.success) throw new Error("Cloud runtime descriptor is invalid");
  return { descriptor: parsed.data, objectKey: row.object_key };
}

async function lockQualifications(tx: Tx, runtimeId: string, compatibilityId: string, mode: CloudRuntimeQualificationMode, kinds: readonly string[] = REQUIRED_KINDS) {
  const result = await tx.query(`SELECT qualification.credential_kind FROM cloud_runtime_qualifications qualification
    WHERE qualification.runtime_id=$1 AND qualification.base_compatibility_id=$2
      AND qualification.credential_kind=ANY($3::text[]) AND ${runtimeQualificationPredicate("$4")}
    ORDER BY qualification.credential_kind FOR SHARE OF qualification`, [runtimeId, compatibilityId, kinds, mode]);
  return kinds.length > 0 && result.rowCount === kinds.length;
}

/** The caller owns the organization admission transaction. Lock revocable
 * registry rows through generation INSERT; no provider/artifact I/O occurs here. */
export async function selectCloudRuntime(tx: Tx, mode: CloudRuntimeQualificationMode, baseImageId?: string, additionalKinds: readonly string[] = []) {
  // Automatic updates require every delegated kind in addition to the
  // existing three-kind floor. Other callers retain their default selection.
  const requiredKinds = [...new Set([...REQUIRED_KINDS, ...additionalKinds])];
  const base = (await tx.query<BaseRow>(`SELECT base.* FROM cloud_runtime_base_images base
    WHERE base.revoked_at IS NULL AND ($1::text IS NULL OR base.base_image_id=$1)
    ORDER BY base.approved_at DESC, base.base_image_id LIMIT 1 FOR SHARE OF base`, [baseImageId ?? null])).rows[0];
  if (!base) return null;
  if (!(await tx.query(`SELECT 1 FROM cloud_runtime_base_contracts contract
    WHERE contract.base_compatibility_id=$1 AND contract.revoked_at IS NULL FOR SHARE OF contract`,
  [base.base_compatibility_id])).rowCount) return null;
  const bundle = (await tx.query<BundleRow & { release_order: string }>(`SELECT bundle.*, release.release_order FROM cloud_runtime_channel_releases release
    JOIN cloud_runtime_bundles bundle ON bundle.runtime_id=release.runtime_id
    WHERE release.channel='alpha' AND release.confirmed_at IS NOT NULL AND release.revoked_at IS NULL
      AND bundle.revoked_at IS NULL AND bundle.engine_protocol_version=$1
      AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) AS required(kind) WHERE NOT EXISTS (
        SELECT 1 FROM cloud_runtime_qualifications qualification
        WHERE qualification.runtime_id=bundle.runtime_id AND qualification.base_compatibility_id=$3
          AND qualification.credential_kind=required.kind AND ${runtimeQualificationPredicate("$4")}
      ))
    ORDER BY release.release_order DESC LIMIT 1 FOR SHARE OF release, bundle`,
  [CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, requiredKinds, base.base_compatibility_id, mode])).rows[0];
  if (!bundle || !await lockQualifications(tx, bundle.runtime_id, base.base_compatibility_id, mode, requiredKinds)) return null;
  return { ...artifact(bundle), releaseOrder: BigInt(bundle.release_order), base: { id: base.base_image_id, compatibilityId: base.base_compatibility_id,
    imageRef: base.image_ref, sourceCommit: base.source_commit, architecture: base.architecture, storageMiB: Number(base.storage_mib) },
  pin: { runtimeId: bundle.runtime_id, manifestSha256: bundle.manifest_sha256,
    baseImageId: base.base_image_id, baseCompatibilityId: base.base_compatibility_id,
    profile: "zeros-cloud-worker-v4" as const, engineProtocolVersion: bundle.engine_protocol_version } };
}

/** Revalidate an existing pin without consulting either the create switch or
 * the current channel head. Ordinary resume and retry use this saved pin. */
export async function loadPinnedCloudRuntime(tx: Tx, pin: CloudRuntimePin, mode: CloudRuntimeQualificationMode) {
  const bundle = (await tx.query<BundleRow>(`SELECT bundle.* FROM cloud_runtime_bundles bundle
    JOIN cloud_runtime_base_images base ON base.base_image_id=$3 AND base.base_compatibility_id=$4
    JOIN cloud_runtime_base_contracts contract ON contract.base_compatibility_id=base.base_compatibility_id
    WHERE bundle.runtime_id=$1 AND bundle.manifest_sha256=$2 AND bundle.revoked_at IS NULL
      AND base.revoked_at IS NULL AND contract.revoked_at IS NULL
      AND bundle.engine_protocol_version=$5 AND bundle.engine_protocol_version=$6
    FOR SHARE OF base, contract, bundle`, [pin.runtimeId, pin.manifestSha256, pin.baseImageId, pin.baseCompatibilityId,
    pin.engineProtocolVersion, CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION])).rows[0];
  if (!bundle || pin.profile !== "zeros-cloud-worker-v4" || !await lockQualifications(tx, pin.runtimeId, pin.baseCompatibilityId, mode)) return null;
  return artifact(bundle);
}

/** Lifecycle admission keeps the saved pin and exposes an actionable refusal.
 * A successful read holds the same revocation locks as fresh setup admission. */
export async function requirePinnedCloudRuntime(tx: Tx, pin: CloudRuntimePin, mode: CloudRuntimeQualificationMode) {
  const runtime = await loadPinnedCloudRuntime(tx, pin, mode);
  if (runtime) return runtime;
  const revoked = await tx.query(`SELECT 1 FROM cloud_runtime_bundles WHERE runtime_id=$1 AND revoked_at IS NOT NULL
    UNION ALL SELECT 1 FROM cloud_runtime_base_images WHERE base_image_id=$2 AND revoked_at IS NOT NULL
    UNION ALL SELECT 1 FROM cloud_runtime_base_contracts WHERE base_compatibility_id=$3 AND revoked_at IS NOT NULL
    UNION ALL SELECT 1 FROM cloud_runtime_qualifications WHERE runtime_id=$1 AND base_compatibility_id=$3
      AND credential_kind=ANY($4::text[]) AND revoked_at IS NOT NULL`,
  [pin.runtimeId, pin.baseImageId, pin.baseCompatibilityId, REQUIRED_KINDS]);
  throw new CloudRuntimeError(revoked.rowCount ? "cloud_runtime_revoked" : "cloud_runtime_unavailable");
}
