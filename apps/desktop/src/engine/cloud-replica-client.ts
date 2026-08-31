import { createHash } from "node:crypto";

import type {
  CloudReplicaDeviceProof,
} from "./cloud-replica-device";
import {
  normalizeCloudReplicaPath,
  type CloudReplicaMutation,
} from "./cloud-replica-apply";
import type {
  CloudWorkspaceForkRecord,
  CloudWorkspaceForkRecordEvent,
} from "./cloud-workspace-fork-records";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const GRANT_PATTERN = /^zwr_[A-Za-z0-9_-]{43}$/;
const EXPORT_GRANT_PATTERN = /^zwe_[A-Za-z0-9_-]{43}$/;
const FULL_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
// A single content revision is atomic and may contain an 8 MiB mutation body;
// bootstrap pages can also carry 1,000 portable 4 KiB paths. Keep the response
// ceiling above both legal server shapes while retaining a hard memory bound.
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_SYMLINK_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 30_000;

export type CloudReplicaGrant = { token: string; expiresAt: string };

export type CloudReplicaRemoteState = {
  id: string;
  workspaceId: string;
  organizationId: string;
  deviceId: string;
  mode: "receive_only";
  desiredState: "active" | "paused" | "removed";
  observedState: string;
  workspaceAuthorityEpoch: number;
  grantEpoch: number;
  checkpointId: string | null;
  manifestRevision: number | null;
  eventCursor: number;
  ignorePolicySha256: string | null;
  clientManifestSha256: string | null;
  lastErrorCode: string | null;
};

export type CloudReplicaRemoteDevice = {
  id: string;
  label: string;
  platform: "macos" | "windows" | "linux";
  keyAlgorithm: "ed25519";
  keyFingerprint: string;
  keyVersion: number;
  trustState: string;
};

export type CloudReplicaBootstrapPage = {
  checkpointId: string;
  manifestRevision: number;
  manifestBlobId: string;
  integritySha256: string;
  fileCount: number;
  totalBytes: number;
  /** Present on current servers; null/absent is retained for rolling upgrade
   * and fork-import checkpoints that have no Git base metadata. */
  gitBaseCommit?: string | null;
  gitHeadRef?: string | null;
  entries: Array<Omit<CloudReplicaMutation, "revision" | "sequence">>;
  nextAfterPath: string | null;
};

export type CloudReplicaEventPage = {
  currentRevision: number;
  minimumRetainedRevision: number;
  snapshotRequired: boolean;
  fromRevision: number;
  toRevision: number;
  events: CloudReplicaMutation[];
  hasMore: boolean;
};

export interface CloudReplicaApi {
  renewGrant(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
  }): Promise<{ replica: CloudReplicaRemoteState; grant: CloudReplicaGrant }>;
  refreshSnapshot(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
  }): Promise<{ replica: CloudReplicaRemoteState; grant: CloudReplicaGrant }>;
  readBootstrap(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    grantToken: string;
    afterPath: string | null;
    limit: number;
  }): Promise<CloudReplicaBootstrapPage>;
  readEvents(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    grantToken: string;
    afterRevision: number;
    limit: number;
  }): Promise<CloudReplicaEventPage>;
  readBlob(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    grantToken: string;
    blobId: string;
    expectedSizeBytes: number;
  }): Promise<Uint8Array>;
  recordReceipt(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    grantToken: string;
    idempotencyKey: string;
    fromRevision: number;
    toRevision: number;
    manifestSha256: string;
    outcome: "applied" | "diverged" | "failed";
    errorCode: string | null;
  }): Promise<{ replica: CloudReplicaRemoteState; replayed: boolean }>;
}

export interface CloudReplicaManagementApi extends CloudReplicaApi {
  createReplica(input: {
    organizationId: string;
    workspaceId: string;
    pathLabel: string | null;
    ignorePolicySha256: string;
    idempotencyKey: string;
  }): Promise<{
    replica: CloudReplicaRemoteState;
    grant: CloudReplicaGrant;
    replayed: boolean;
  }>;
  changeReplicaState(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    operation: "pause" | "resume" | "remove";
    replaceDiverged?: boolean;
    idempotencyKey: string;
  }): Promise<{
    replica: CloudReplicaRemoteState;
    grant: CloudReplicaGrant | null;
    replayed: boolean;
  }>;
}

export type CloudWorkspaceForkImportEntry =
  | {
      operation: "upsert";
      path: string;
      entryType: "file" | "symlink";
      mode: 33188 | 33261 | 40960;
      blobId: string;
      contentSha256: string;
      sizeBytes: number;
    }
  | { operation: "delete"; path: string };

export type CloudWorkspaceForkManifestPage = {
  sourceCloudWorkspaceId: string;
  targetLocalWorkspaceId: string;
  checkpointId: string;
  contentRevision: number;
  recordRevision: number;
  includeChats: boolean;
  fileCount: number;
  totalBytes: number;
  gitBaseCommit: string;
  gitHeadRef: string | null;
  repository: {
    forge: "github.com";
    owner: string;
    name: string;
    revision: string;
  };
  entries: CloudWorkspaceForkImportEntry[];
  nextAfterPath: string | null;
};

export type CloudWorkspaceForkRecordPage = {
  recordRevision: number;
  events: CloudWorkspaceForkRecordEvent[];
  hasMore: boolean;
};

export interface CloudWorkspaceForkApi {
  createCloudFromLocal(input: {
    organizationId: string;
    name?: string;
    teamId?: string;
    repository: {
      forge: "github.com";
      owner: string;
      name: string;
      revision: string;
      githubInstallationId: string;
    };
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    sourceRevision: number;
    sourceSnapshotSha256: string;
    sourceGitHeadRef: string | null;
    includeChats: boolean;
    includeSettings: boolean;
    idempotencyKey: string;
  }): Promise<{
    workspaceId: string;
    lifecycleIntentId: string;
    forkIntentId: string;
    replayed: boolean;
  }>;
  uploadForkBlob(input: {
    organizationId: string;
    workspaceId: string;
    forkIntentId: string;
    bytes: Uint8Array;
  }): Promise<{
    id: string;
    plaintextSha256: string;
    plaintextBytes: number;
    reused: boolean;
  }>;
  stageForkEntries(input: {
    organizationId: string;
    workspaceId: string;
    forkIntentId: string;
    entries: readonly CloudWorkspaceForkImportEntry[];
  }): Promise<{ accepted: number }>;
  stageForkRecords(input: {
    organizationId: string;
    workspaceId: string;
    forkIntentId: string;
    records: readonly CloudWorkspaceForkRecord[];
  }): Promise<{ accepted: number }>;
  finalizeForkImport(input: {
    organizationId: string;
    workspaceId: string;
    forkIntentId: string;
    idempotencyKey: string;
  }): Promise<{ checkpointId: string; replayed: boolean }>;
  requestCloudToLocal(input: {
    organizationId: string;
    workspaceId: string;
    targetLocalWorkspaceId: string;
    includeChats: boolean;
    idempotencyKey: string;
  }): Promise<{
    forkIntentId: string;
    checkpointRequestId: string;
    replayed: boolean;
  }>;
  issueExportGrant(input: {
    organizationId: string;
    workspaceId: string;
    forkIntentId: string;
  }): Promise<{
    grantToken: string;
    deviceId: string;
    deviceKeyVersion: number;
    expiresAt: string;
  }>;
  readForkManifest(input: {
    organizationId: string;
    workspaceId: string;
    forkIntentId: string;
    grantToken: string;
    afterPath: string | null;
    limit: number;
  }): Promise<CloudWorkspaceForkManifestPage>;
  readForkRecords(input: {
    organizationId: string;
    workspaceId: string;
    forkIntentId: string;
    grantToken: string;
    afterRevision: number;
    limit: number;
  }): Promise<CloudWorkspaceForkRecordPage>;
  readForkBlob(input: {
    organizationId: string;
    workspaceId: string;
    forkIntentId: string;
    grantToken: string;
    blobId: string;
    expectedSizeBytes: number;
    expectedSha256: string;
  }): Promise<Uint8Array>;
}

export interface CloudWorkspaceDesktopApi
  extends CloudReplicaManagementApi,
    CloudWorkspaceForkApi {}

/** Signing may remain synchronous for an in-process credential or cross the
 * private Electron host channel. The HTTP client awaits either shape so the
 * Ed25519 private key never needs to enter the engine process on desktop. */
export interface CloudReplicaProofSigner {
  readonly deviceId: string;
  proof(
    action: string,
    payload: unknown,
  ): CloudReplicaDeviceProof | Promise<CloudReplicaDeviceProof>;
}

export class CloudReplicaClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CloudReplicaClientError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function secureBaseUrl(value: string, allowInsecureLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cloud workspace control-plane URL is invalid");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(allowInsecureLoopback && url.protocol === "http:" && loopback)
  ) {
    throw new Error("Cloud workspace control-plane URL must use HTTPS");
  }
  if (
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("Cloud workspace control-plane URL must be an origin");
  }
  return url.origin;
}

function uuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new CloudReplicaClientError(0, "invalid_request", `${label} is invalid`);
  }
  return value;
}

function grant(value: string): string {
  if (!GRANT_PATTERN.test(value)) {
    throw new CloudReplicaClientError(0, "invalid_request", "Replica grant is invalid");
  }
  return value;
}

function exportGrant(value: string): string {
  if (!EXPORT_GRANT_PATTERN.test(value)) {
    throw new CloudReplicaClientError(0, "invalid_request", "Export grant is invalid");
  }
  return value;
}

function idempotency(value: string): string {
  if (!IDEMPOTENCY_PATTERN.test(value)) {
    throw new CloudReplicaClientError(
      0,
      "invalid_request",
      "Replica request identity is invalid",
    );
  }
  return value;
}

function bearer(value: string | null): string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 32_768 ||
    // eslint-disable-next-line no-control-regex -- bearer header contract
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new CloudReplicaClientError(
      401,
      "signed_out",
      "A current account session is required",
    );
  }
  return value;
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^(?:0|[1-9][0-9]{0,15})$/.test(rawLength) || Number(rawLength) > maximum) {
      throw new Error("Cloud replica response is too large");
    }
  }
  if (!response.body) throw new Error("Cloud replica response is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Cloud replica response is too large");
    }
    chunks.push(chunk.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = await boundedBytes(response, MAX_JSON_BYTES);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

const SAFE_ERRORS: Readonly<Record<string, string>> = {
  workspace_fork_not_found: "Cloud workspace copy was not found",
  workspace_fork_not_ready: "Cloud workspace copy is not ready",
  workspace_fork_idempotency_conflict: "Cloud copy request identity was reused",
  workspace_fork_blob_unavailable: "Cloud copy content is unavailable",
  workspace_fork_import_conflict: "Cloud copy content changed during import",
  workspace_fork_export_unavailable: "Cloud workspace export is not ready",
  workspace_fork_device_proof_rejected: "Cloud device proof was rejected",
  workspace_fork_device_proof_replayed: "Cloud device proof was already used",
  workspace_fork_grant_rejected: "Cloud export access expired or was revoked",
  cloud_workspace_identity_conflict: "Cloud workspace identity is already in use",
  cloud_workspace_scope_not_found: "Cloud workspace access is not permitted",
  cloud_workspace_owner_required: "Only the cloud workspace owner can copy it",
  cloud_workspaces_not_allowed: "Cloud workspaces are not enabled for this account",
  cloud_account_entitlement_required: "A current Pro entitlement is required",
  cloud_organization_entitlement_required:
    "A current Organization cloud entitlement is required",
  organization_identity_not_ready: "Organization identity is still synchronizing",
  invalid_input: "Cloud workspace request is invalid",
  idempotency_key_required: "Cloud workspace request identity is invalid",
  workspace_replica_not_found: "Cloud replica was not found",
  workspace_replica_not_ready: "Cloud replica is not ready",
  workspace_replica_idempotency_conflict: "Replica request identity was reused",
  workspace_replica_device_key_conflict: "Cloud device key is already in use",
  workspace_replica_device_proof_rejected: "Cloud device proof was rejected",
  workspace_replica_device_proof_replayed: "Cloud device proof was already used",
  workspace_replica_grant_rejected: "Cloud replica access expired or was revoked",
  workspace_replica_cursor_conflict: "Cloud replica cursor changed",
  workspace_replica_bootstrap_required: "Cloud replica needs a fresh snapshot",
  workspace_replica_divergence_resolution_required:
    "Local changes must be preserved or replaced explicitly",
  workspace_replica_blob_unavailable: "Cloud replica content is unavailable",
  cloud_workspace_durability_not_configured:
    "Cloud workspace durable storage is unavailable",
  forbidden: "Cloud replica access is not permitted",
  rate_limited: "Too many cloud replica requests; try again shortly",
};

function responseError(response: Response, body: unknown): CloudReplicaClientError {
  const candidate =
    isRecord(body) && isRecord(body.error) && typeof body.error.code === "string"
      ? body.error.code
      : "request_failed";
  const code = Object.hasOwn(SAFE_ERRORS, candidate) ? candidate : "request_failed";
  return new CloudReplicaClientError(
    response.status,
    code,
    SAFE_ERRORS[code] ?? `Cloud replica request failed (${response.status})`,
  );
}

function natural(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function positive(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function nullableHash(value: unknown): string | null | undefined {
  return value === null
    ? null
    : typeof value === "string" && SHA256_PATTERN.test(value)
      ? value
      : undefined;
}

function parseReplica(value: unknown): CloudReplicaRemoteState {
  if (!isRecord(value)) throw new Error("Cloud replica response is invalid");
  const authority = positive(value.workspaceAuthorityEpoch);
  const grantEpoch = positive(value.grantEpoch);
  const cursor = natural(value.eventCursor);
  const manifestRevision =
    value.manifestRevision === null ? null : natural(value.manifestRevision);
  const ignoreHash = nullableHash(value.ignorePolicySha256);
  const clientHash = nullableHash(value.clientManifestSha256);
  if (
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.workspaceId !== "string" ||
    !UUID_PATTERN.test(value.workspaceId) ||
    typeof value.organizationId !== "string" ||
    !UUID_PATTERN.test(value.organizationId) ||
    typeof value.deviceId !== "string" ||
    !UUID_PATTERN.test(value.deviceId) ||
    value.mode !== "receive_only" ||
    !["active", "paused", "removed"].includes(String(value.desiredState)) ||
    ![
      "bootstrapping",
      "pending",
      "syncing",
      "in_sync",
      "diverged",
      "paused",
      "detached",
      "failed",
      "removed",
    ].includes(String(value.observedState)) ||
    authority === null ||
    grantEpoch === null ||
    cursor === null ||
    manifestRevision === null && value.manifestRevision !== null ||
    ignoreHash === undefined ||
    clientHash === undefined ||
    (value.checkpointId !== null &&
      (typeof value.checkpointId !== "string" || !UUID_PATTERN.test(value.checkpointId))) ||
    (value.lastErrorCode !== null && typeof value.lastErrorCode !== "string")
  ) {
    throw new Error("Cloud replica response is invalid");
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    organizationId: value.organizationId,
    deviceId: value.deviceId,
    mode: "receive_only",
    desiredState: value.desiredState as CloudReplicaRemoteState["desiredState"],
    observedState: value.observedState as string,
    workspaceAuthorityEpoch: authority,
    grantEpoch,
    checkpointId: value.checkpointId as string | null,
    manifestRevision,
    eventCursor: cursor,
    ignorePolicySha256: ignoreHash,
    clientManifestSha256: clientHash,
    lastErrorCode: value.lastErrorCode as string | null,
  };
}

function parseGrant(value: unknown): CloudReplicaGrant {
  if (
    !isRecord(value) ||
    typeof value.token !== "string" ||
    !GRANT_PATTERN.test(value.token) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(Date.parse(value.expiresAt)).toISOString() !== value.expiresAt
  ) {
    throw new Error("Cloud replica grant response is invalid");
  }
  return { token: value.token, expiresAt: value.expiresAt };
}

function parseDevice(value: unknown): CloudReplicaRemoteDevice {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.label !== "string" ||
    value.label.length < 1 ||
    !["macos", "windows", "linux"].includes(String(value.platform)) ||
    value.keyAlgorithm !== "ed25519" ||
    typeof value.keyFingerprint !== "string" ||
    !SHA256_PATTERN.test(value.keyFingerprint) ||
    positive(value.keyVersion) === null ||
    typeof value.trustState !== "string"
  ) {
    throw new Error("Cloud device response is invalid");
  }
  return {
    id: value.id,
    label: value.label,
    platform: value.platform as CloudReplicaRemoteDevice["platform"],
    keyAlgorithm: "ed25519",
    keyFingerprint: value.keyFingerprint,
    keyVersion: Number(value.keyVersion),
    trustState: value.trustState,
  };
}

function parseMutation(
  value: unknown,
  includeOrder: boolean,
): CloudReplicaMutation | Omit<CloudReplicaMutation, "revision" | "sequence"> {
  if (!isRecord(value)) throw new Error("Cloud replica mutation is invalid");
  const normalizedPath = normalizeCloudReplicaPath(String(value.path ?? ""));
  const operation = value.operation;
  const base = {
    path: normalizedPath,
    operation,
    entryType: value.entryType,
    mode: value.mode,
    blobId: value.blobId,
    contentSha256: value.contentSha256,
    sizeBytes: value.sizeBytes,
  };
  if (
    !["upsert", "delete"].includes(String(operation)) ||
    (operation === "delete" &&
      [base.entryType, base.mode, base.blobId, base.contentSha256, base.sizeBytes].some(
        (part) => part !== null,
      )) ||
    (operation === "upsert" &&
      (!(["file", "symlink"] as unknown[]).includes(base.entryType) ||
        !([33188, 33261, 40960] as unknown[]).includes(base.mode) ||
        (base.entryType === "symlink") !== (base.mode === 40960) ||
        typeof base.blobId !== "string" ||
        !UUID_PATTERN.test(base.blobId) ||
        typeof base.contentSha256 !== "string" ||
        !SHA256_PATTERN.test(base.contentSha256) ||
        natural(base.sizeBytes) === null ||
        Number(base.sizeBytes) > MAX_BLOB_BYTES ||
        (base.entryType === "symlink" &&
          (Number(base.sizeBytes) < 1 ||
            Number(base.sizeBytes) > MAX_SYMLINK_BYTES))))
  ) {
    throw new Error("Cloud replica mutation is invalid");
  }
  const mutation = base as Omit<CloudReplicaMutation, "revision" | "sequence">;
  if (!includeOrder) return mutation;
  const revision = positive(value.revision);
  const sequence = positive(value.sequence);
  if (revision === null || sequence === null) {
    throw new Error("Cloud replica mutation order is invalid");
  }
  return { ...mutation, revision, sequence };
}

function proofHeaders(proof: CloudReplicaDeviceProof): Record<string, string> {
  return {
    "x-zeros-device-id": proof.deviceId,
    "x-zeros-device-key-version": String(proof.keyVersion),
    "x-zeros-device-timestamp": String(proof.timestampMs),
    "x-zeros-device-nonce": proof.nonce,
    "x-zeros-device-signature": proof.signature,
  };
}

function exactIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : null;
}

function safeGithubName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 100 &&
    /^[A-Za-z0-9_.-]+$/.test(value)
  );
}

function safeReplicaPath(value: string, label: string): string {
  try {
    return normalizeCloudReplicaPath(value);
  } catch (error) {
    throw new CloudReplicaClientError(0, "invalid_response", `${label} is invalid`, {
      cause: error,
    });
  }
}

function parseForkEntry(value: unknown): CloudWorkspaceForkImportEntry {
  const mutation = parseMutation(value, false) as Omit<
    CloudReplicaMutation,
    "revision" | "sequence"
  >;
  return mutation.operation === "delete"
    ? { operation: "delete", path: mutation.path }
    : {
        operation: "upsert",
        path: mutation.path,
        entryType: mutation.entryType!,
        mode: mutation.mode!,
        blobId: mutation.blobId!,
        contentSha256: mutation.contentSha256!,
        sizeBytes: mutation.sizeBytes!,
      };
}

function parseForkRecordEvent(value: unknown): CloudWorkspaceForkRecordEvent {
  if (!isRecord(value)) throw new Error("Cloud fork record is invalid");
  const revision = positive(value.revision);
  const occurredAt = exactIso(value.occurredAt);
  if (
    revision === null ||
    ![
      "workspace",
      "chat",
      "message",
      "turn",
      "agent_session",
      "run",
      "terminal",
      "design_transaction",
      "metadata",
    ].includes(String(value.entityKind)) ||
    typeof value.entityId !== "string" ||
    value.entityId.length < 1 ||
    Buffer.byteLength(value.entityId, "utf8") > 255 ||
    !["upsert", "tombstone"].includes(String(value.operation)) ||
    positive(value.schemaVersion) === null ||
    occurredAt === null ||
    (value.operation === "upsert") !== isRecord(value.document) ||
    (value.operation === "tombstone" && value.document !== null)
  ) {
    throw new Error("Cloud fork record is invalid");
  }
  return {
    revision,
    entityKind: value.entityKind as CloudWorkspaceForkRecordEvent["entityKind"],
    entityId: value.entityId,
    operation: value.operation as CloudWorkspaceForkRecordEvent["operation"],
    schemaVersion: Number(value.schemaVersion),
    document: value.document as Record<string, unknown> | null,
    occurredAt,
  };
}

export class HttpCloudReplicaApi implements CloudWorkspaceDesktopApi {
  private readonly baseUrl: string;
  private readonly requestFetch: typeof fetch;

  constructor(
    options: {
      baseUrl: string;
      getAccessToken: () => Promise<string | null>;
      signer: CloudReplicaProofSigner;
      fetch?: typeof fetch;
      allowInsecureLoopback?: boolean;
    },
  ) {
    this.baseUrl = secureBaseUrl(
      options.baseUrl,
      options.allowInsecureLoopback === true,
    );
    this.getAccessToken = options.getAccessToken;
    this.signer = options.signer;
    this.requestFetch = options.fetch ?? fetch;
  }

  private readonly getAccessToken: () => Promise<string | null>;
  private readonly signer: CloudReplicaProofSigner;

  private cloudWorkspacePath(input: {
    organizationId: string;
    workspaceId: string;
  }): string {
    return `/v1/organizations/${uuid(input.organizationId, "Organization")}/cloud-workspaces/${uuid(input.workspaceId, "Workspace")}`;
  }

  private workspacePath(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
  }): string {
    return `${this.cloudWorkspacePath(input)}/replicas/${uuid(input.replicaId, "Replica")}`;
  }

  private forkPath(input: {
    organizationId: string;
    workspaceId: string;
    forkIntentId: string;
  }): string {
    return `${this.cloudWorkspacePath(input)}/forks/${uuid(input.forkIntentId, "Fork")}`;
  }

  private async request(input: {
    method: "GET" | "POST" | "PUT" | "PATCH";
    path: string;
    action?: string;
    payload?: unknown;
    body?: unknown;
    binaryBody?: Uint8Array;
    grantToken?: string;
    exportGrantToken?: string;
    idempotencyKey?: string;
    timeoutMs?: number;
  }): Promise<Response> {
    if (input.body !== undefined && input.binaryBody !== undefined) {
      throw new CloudReplicaClientError(
        0,
        "invalid_request",
        "Cloud request body is invalid",
      );
    }
    const token = bearer(await this.getAccessToken());
    const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 120_000
    ) {
      throw new CloudReplicaClientError(0, "invalid_request", "Cloud timeout is invalid");
    }
    const jsonBody =
      input.body === undefined ? null : JSON.stringify(input.body);
    if (input.body !== undefined && typeof jsonBody !== "string") {
      throw new CloudReplicaClientError(0, "invalid_request", "Cloud request body is invalid");
    }
    const proof = input.action
      ? await this.signer.proof(input.action, input.payload)
      : null;
    const binary =
      input.binaryBody === undefined ? null : Buffer.from(input.binaryBody);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.requestFetch(`${this.baseUrl}${input.path}`, {
        method: input.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, application/octet-stream",
          "cache-control": "no-store",
          ...(proof ? proofHeaders(proof) : {}),
          ...(input.body === undefined
            ? binary
              ? {
                  "content-type": "application/octet-stream",
                  "content-length": String(binary.length),
                }
              : {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(jsonBody!, "utf8")),
              }),
          ...(input.grantToken
            ? { "x-zeros-replica-grant": grant(input.grantToken) }
            : {}),
          ...(input.exportGrantToken
            ? { "x-zeros-export-grant": exportGrant(input.exportGrantToken) }
            : {}),
          ...(input.idempotencyKey
            ? { "idempotency-key": idempotency(input.idempotencyKey) }
            : {}),
        },
        body:
          input.body === undefined ? (binary ?? undefined) : jsonBody!,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      throw new CloudReplicaClientError(
        0,
        "network_error",
        "Cloud workspace service is unavailable",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
      binary?.fill(0);
    }
  }

  private async json<T>(input: Parameters<HttpCloudReplicaApi["request"]>[0]): Promise<T> {
    const response = await this.request(input);
    let body: unknown;
    try {
      body = await boundedJson(response);
    } catch (error) {
      throw new CloudReplicaClientError(
        response.status,
        "invalid_response",
        "Cloud replica service returned an invalid response",
        { cause: error },
      );
    }
    if (!response.ok) throw responseError(response, body);
    return body as T;
  }

  async createCloudFromLocal(
    input: Parameters<CloudWorkspaceForkApi["createCloudFromLocal"]>[0],
  ) {
    uuid(input.organizationId, "Organization");
    uuid(input.sourceWorkspaceId, "Source workspace");
    uuid(input.targetWorkspaceId, "Target workspace");
    uuid(input.repository.githubInstallationId, "GitHub installation");
    if (
      input.sourceWorkspaceId === input.targetWorkspaceId ||
      natural(input.sourceRevision) === null ||
      !SHA256_PATTERN.test(input.sourceSnapshotSha256) ||
      !FULL_COMMIT_PATTERN.test(input.repository.revision) ||
      input.repository.forge !== "github.com" ||
      !safeGithubName(input.repository.owner) ||
      !safeGithubName(input.repository.name) ||
      (input.name !== undefined &&
        (input.name.trim() !== input.name || input.name.length < 1 || input.name.length > 120)) ||
      (input.teamId !== undefined && !UUID_PATTERN.test(input.teamId)) ||
      (input.sourceGitHeadRef !== null &&
        (input.sourceGitHeadRef.length < 1 ||
          input.sourceGitHeadRef.length > 512 ||
          // eslint-disable-next-line no-control-regex -- Git refs reject C0, space, and DEL
          /[\u0000-\u0020\u007f]/u.test(input.sourceGitHeadRef)))
    ) {
      throw new CloudReplicaClientError(0, "invalid_request", "Cloud copy input is invalid");
    }
    const body = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
      repository: input.repository,
      forkFromLocal: {
        sourceWorkspaceId: input.sourceWorkspaceId,
        targetWorkspaceId: input.targetWorkspaceId,
        sourceRevision: input.sourceRevision,
        sourceSnapshotSha256: input.sourceSnapshotSha256,
        sourceGitBaseCommit: input.repository.revision,
        sourceGitHeadRef: input.sourceGitHeadRef,
        includeChats: input.includeChats,
        includeSettings: input.includeSettings,
      },
    };
    const value = await this.json<unknown>({
      method: "POST",
      path: `/v1/organizations/${input.organizationId}/cloud-workspaces`,
      body,
      idempotencyKey: input.idempotencyKey,
    });
    if (
      !isRecord(value) ||
      !isRecord(value.workspace) ||
      !isRecord(value.intent) ||
      !isRecord(value.fork) ||
      value.workspace.id !== input.targetWorkspaceId ||
      value.workspace.organizationId !== input.organizationId ||
      typeof value.intent.id !== "string" ||
      !UUID_PATTERN.test(value.intent.id) ||
      typeof value.fork.id !== "string" ||
      !UUID_PATTERN.test(value.fork.id) ||
      value.fork.operation !== "local_to_cloud" ||
      value.fork.sourceLocalWorkspaceId !== input.sourceWorkspaceId ||
      value.fork.targetCloudWorkspaceId !== input.targetWorkspaceId ||
      typeof value.replayed !== "boolean"
    ) {
      throw new CloudReplicaClientError(0, "invalid_response", "Cloud copy response is invalid");
    }
    return {
      workspaceId: input.targetWorkspaceId,
      lifecycleIntentId: value.intent.id,
      forkIntentId: value.fork.id,
      replayed: value.replayed,
    };
  }

  async uploadForkBlob(
    input: Parameters<CloudWorkspaceForkApi["uploadForkBlob"]>[0],
  ) {
    if (input.bytes.byteLength > MAX_BLOB_BYTES) {
      throw new CloudReplicaClientError(0, "invalid_request", "Fork blob is too large");
    }
    const expectedSha256 = createHash("sha256").update(input.bytes).digest("hex");
    const value = await this.json<unknown>({
      method: "POST",
      path: `${this.forkPath(input)}/import/blobs`,
      binaryBody: input.bytes,
      timeoutMs: 120_000,
    });
    if (!isRecord(value) || !isRecord(value.blob)) {
      throw new CloudReplicaClientError(0, "invalid_response", "Fork blob response is invalid");
    }
    const bytes = natural(value.blob.plaintextBytes);
    if (
      typeof value.blob.id !== "string" ||
      !UUID_PATTERN.test(value.blob.id) ||
      value.blob.plaintextSha256 !== expectedSha256 ||
      bytes !== input.bytes.byteLength ||
      typeof value.blob.reused !== "boolean"
    ) {
      throw new CloudReplicaClientError(0, "invalid_response", "Fork blob response is invalid");
    }
    return {
      id: value.blob.id,
      plaintextSha256: expectedSha256,
      plaintextBytes: bytes,
      reused: value.blob.reused,
    };
  }

  async stageForkEntries(
    input: Parameters<CloudWorkspaceForkApi["stageForkEntries"]>[0],
  ) {
    if (input.entries.length < 1 || input.entries.length > 1_000) {
      throw new CloudReplicaClientError(0, "invalid_request", "Fork entry batch is invalid");
    }
    const value = await this.json<unknown>({
      method: "PUT",
      path: `${this.forkPath(input)}/import/entries`,
      body: { entries: input.entries },
    });
    if (!isRecord(value) || value.accepted !== input.entries.length) {
      throw new CloudReplicaClientError(0, "invalid_response", "Fork entry response is invalid");
    }
    return { accepted: input.entries.length };
  }

  async stageForkRecords(
    input: Parameters<CloudWorkspaceForkApi["stageForkRecords"]>[0],
  ) {
    if (input.records.length < 1 || input.records.length > 20) {
      throw new CloudReplicaClientError(0, "invalid_request", "Fork record batch is invalid");
    }
    const value = await this.json<unknown>({
      method: "PUT",
      path: `${this.forkPath(input)}/import/records`,
      body: { records: input.records },
    });
    if (!isRecord(value) || value.accepted !== input.records.length) {
      throw new CloudReplicaClientError(0, "invalid_response", "Fork record response is invalid");
    }
    return { accepted: input.records.length };
  }

  async finalizeForkImport(
    input: Parameters<CloudWorkspaceForkApi["finalizeForkImport"]>[0],
  ) {
    const value = await this.json<unknown>({
      method: "POST",
      path: `${this.forkPath(input)}/import/finalize`,
      idempotencyKey: input.idempotencyKey,
    });
    if (
      !isRecord(value) ||
      typeof value.checkpointId !== "string" ||
      !UUID_PATTERN.test(value.checkpointId) ||
      typeof value.replayed !== "boolean"
    ) {
      throw new CloudReplicaClientError(0, "invalid_response", "Fork finalize response is invalid");
    }
    return { checkpointId: value.checkpointId, replayed: value.replayed };
  }

  async requestCloudToLocal(
    input: Parameters<CloudWorkspaceForkApi["requestCloudToLocal"]>[0],
  ) {
    if (
      !UUID_PATTERN.test(input.targetLocalWorkspaceId) ||
      input.targetLocalWorkspaceId === input.workspaceId
    ) {
      throw new CloudReplicaClientError(0, "invalid_request", "Local copy identity is invalid");
    }
    const value = await this.json<unknown>({
      method: "POST",
      path: `${this.cloudWorkspacePath(input)}/forks/cloud-to-local`,
      body: {
        targetLocalWorkspaceId: input.targetLocalWorkspaceId,
        includeChats: input.includeChats,
      },
      idempotencyKey: input.idempotencyKey,
    });
    if (
      !isRecord(value) ||
      typeof value.forkIntentId !== "string" ||
      !UUID_PATTERN.test(value.forkIntentId) ||
      typeof value.checkpointRequestId !== "string" ||
      !UUID_PATTERN.test(value.checkpointRequestId) ||
      typeof value.replayed !== "boolean"
    ) {
      throw new CloudReplicaClientError(0, "invalid_response", "Local copy response is invalid");
    }
    return {
      forkIntentId: value.forkIntentId,
      checkpointRequestId: value.checkpointRequestId,
      replayed: value.replayed,
    };
  }

  async issueExportGrant(
    input: Parameters<CloudWorkspaceForkApi["issueExportGrant"]>[0],
  ) {
    const payload = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      forkIntentId: input.forkIntentId,
    };
    const value = await this.json<unknown>({
      method: "POST",
      path: `${this.forkPath(input)}/export/grant`,
      action: "fork.export.grant",
      payload,
    });
    const expiresAt = isRecord(value) ? exactIso(value.expiresAt) : null;
    if (
      !isRecord(value) ||
      typeof value.grantToken !== "string" ||
      !EXPORT_GRANT_PATTERN.test(value.grantToken) ||
      value.deviceId !== this.signer.deviceId ||
      positive(value.deviceKeyVersion) === null ||
      expiresAt === null ||
      Date.parse(expiresAt) <= Date.now()
    ) {
      throw new CloudReplicaClientError(0, "invalid_response", "Export grant response is invalid");
    }
    return {
      grantToken: value.grantToken,
      deviceId: value.deviceId,
      deviceKeyVersion: Number(value.deviceKeyVersion),
      expiresAt,
    };
  }

  async readForkManifest(
    input: Parameters<CloudWorkspaceForkApi["readForkManifest"]>[0],
  ): Promise<CloudWorkspaceForkManifestPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new CloudReplicaClientError(0, "invalid_request", "Export page size is invalid");
    }
    const afterPath =
      input.afterPath === null
        ? null
        : safeReplicaPath(input.afterPath, "Export cursor");
    const payload = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      forkIntentId: input.forkIntentId,
      afterPath,
      limit: input.limit,
    };
    const cursor = afterPath
      ? `&after=${Buffer.from(afterPath, "utf8").toString("base64url")}`
      : "";
    const value = await this.json<unknown>({
      method: "GET",
      path: `${this.forkPath(input)}/export/manifest?limit=${input.limit}${cursor}`,
      action: "fork.export.manifest.read",
      payload,
      exportGrantToken: input.grantToken,
    });
    if (!isRecord(value) || !Array.isArray(value.entries) || !isRecord(value.repository)) {
      throw new CloudReplicaClientError(0, "invalid_response", "Export manifest is invalid");
    }
    const contentRevision = natural(value.contentRevision);
    const recordRevision = natural(value.recordRevision);
    const fileCount = natural(value.fileCount);
    const totalBytes = natural(value.totalBytes);
    if (
      value.sourceCloudWorkspaceId !== input.workspaceId ||
      typeof value.targetLocalWorkspaceId !== "string" ||
      !UUID_PATTERN.test(value.targetLocalWorkspaceId) ||
      typeof value.checkpointId !== "string" ||
      !UUID_PATTERN.test(value.checkpointId) ||
      contentRevision === null ||
      recordRevision === null ||
      typeof value.includeChats !== "boolean" ||
      fileCount === null ||
      totalBytes === null ||
      typeof value.gitBaseCommit !== "string" ||
      !FULL_COMMIT_PATTERN.test(value.gitBaseCommit) ||
      (value.gitHeadRef !== null &&
        (typeof value.gitHeadRef !== "string" || value.gitHeadRef.length > 512)) ||
      value.repository.forge !== "github.com" ||
      !safeGithubName(value.repository.owner) ||
      !safeGithubName(value.repository.name) ||
      typeof value.repository.revision !== "string" ||
      value.repository.revision.length < 1 ||
      value.repository.revision.length > 512 ||
      (value.nextAfterPath !== null && typeof value.nextAfterPath !== "string")
    ) {
      throw new CloudReplicaClientError(0, "invalid_response", "Export manifest is invalid");
    }
    let entries: CloudWorkspaceForkImportEntry[];
    try {
      entries = value.entries.map(parseForkEntry);
    } catch (error) {
      throw new CloudReplicaClientError(0, "invalid_response", "Export manifest is invalid", {
        cause: error,
      });
    }
    const nextAfterPath =
      value.nextAfterPath === null
        ? null
        : safeReplicaPath(value.nextAfterPath as string, "Export cursor");
    const uniquePaths = new Set(entries.map((entry) => entry.path));
    if (
      uniquePaths.size !== entries.length ||
      (afterPath !== null && entries.some((entry) => entry.path === afterPath)) ||
      (nextAfterPath !== null &&
        (entries.length === 0 || nextAfterPath !== entries.at(-1)!.path))
    ) {
      throw new CloudReplicaClientError(0, "invalid_response", "Export manifest is invalid");
    }
    return {
      sourceCloudWorkspaceId: input.workspaceId,
      targetLocalWorkspaceId: value.targetLocalWorkspaceId,
      checkpointId: value.checkpointId,
      contentRevision,
      recordRevision,
      includeChats: value.includeChats,
      fileCount,
      totalBytes,
      gitBaseCommit: value.gitBaseCommit,
      gitHeadRef: value.gitHeadRef as string | null,
      repository: {
        forge: "github.com",
        owner: value.repository.owner,
        name: value.repository.name,
        revision: value.repository.revision,
      },
      entries,
      nextAfterPath,
    };
  }

  async readForkRecords(
    input: Parameters<CloudWorkspaceForkApi["readForkRecords"]>[0],
  ): Promise<CloudWorkspaceForkRecordPage> {
    if (
      natural(input.afterRevision) === null ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 20
    ) {
      throw new CloudReplicaClientError(0, "invalid_request", "Export record cursor is invalid");
    }
    const payload = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      forkIntentId: input.forkIntentId,
      afterRevision: input.afterRevision,
      limit: input.limit,
    };
    const value = await this.json<unknown>({
      method: "GET",
      path: `${this.forkPath(input)}/export/records?afterRevision=${input.afterRevision}&limit=${input.limit}`,
      action: "fork.export.records.read",
      payload,
      exportGrantToken: input.grantToken,
    });
    if (!isRecord(value) || !Array.isArray(value.events) || typeof value.hasMore !== "boolean") {
      throw new CloudReplicaClientError(0, "invalid_response", "Export records are invalid");
    }
    const recordRevision = natural(value.recordRevision);
    let events: CloudWorkspaceForkRecordEvent[];
    try {
      events = value.events.map(parseForkRecordEvent);
    } catch (error) {
      throw new CloudReplicaClientError(0, "invalid_response", "Export records are invalid", {
        cause: error,
      });
    }
    let previous = input.afterRevision;
    if (
      recordRevision === null ||
      input.afterRevision > recordRevision ||
      events.some((event) => {
        const invalid = event.revision <= previous || event.revision > recordRevision;
        previous = event.revision;
        return invalid;
      }) ||
      (value.hasMore && events.length === 0)
    ) {
      throw new CloudReplicaClientError(0, "invalid_response", "Export records are invalid");
    }
    return { recordRevision, events, hasMore: value.hasMore };
  }

  async readForkBlob(
    input: Parameters<CloudWorkspaceForkApi["readForkBlob"]>[0],
  ): Promise<Uint8Array> {
    uuid(input.blobId, "Blob");
    if (
      !Number.isSafeInteger(input.expectedSizeBytes) ||
      input.expectedSizeBytes < 0 ||
      input.expectedSizeBytes > MAX_BLOB_BYTES ||
      !SHA256_PATTERN.test(input.expectedSha256)
    ) {
      throw new CloudReplicaClientError(0, "invalid_request", "Export blob input is invalid");
    }
    const payload = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      forkIntentId: input.forkIntentId,
      blobId: input.blobId,
    };
    const response = await this.request({
      method: "GET",
      path: `${this.forkPath(input)}/export/blobs/${input.blobId}`,
      action: "fork.export.blob.read",
      payload,
      exportGrantToken: input.grantToken,
      timeoutMs: 120_000,
    });
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await boundedJson(response);
      } catch {
        // Only the mapped error below crosses the engine boundary.
      }
      throw responseError(response, body);
    }
    if (response.headers.get("content-length") !== String(input.expectedSizeBytes)) {
      throw new CloudReplicaClientError(0, "invalid_response", "Export blob length is invalid");
    }
    const bytes = await boundedBytes(response, input.expectedSizeBytes);
    if (
      bytes.byteLength !== input.expectedSizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== input.expectedSha256
    ) {
      bytes.fill(0);
      throw new CloudReplicaClientError(0, "invalid_response", "Export blob integrity is invalid");
    }
    return bytes;
  }

  async readBootstrap(input: Parameters<CloudReplicaApi["readBootstrap"]>[0]) {
    const payload = { afterPath: input.afterPath, limit: input.limit };
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000
    ) {
      throw new CloudReplicaClientError(0, "invalid_request", "Bootstrap limit is invalid");
    }
    const cursor = input.afterPath
      ? `&after=${Buffer.from(input.afterPath, "utf8").toString("base64url")}`
      : "";
    const value = await this.json<unknown>({
      method: "GET",
      path: `${this.workspacePath(input)}/bootstrap?limit=${input.limit}${cursor}`,
      action: "replica.bootstrap.read",
      payload,
      grantToken: input.grantToken,
    });
    if (!isRecord(value) || !Array.isArray(value.entries)) {
      throw new CloudReplicaClientError(0, "invalid_response", "Bootstrap response is invalid");
    }
    const revision = natural(value.manifestRevision);
    const fileCount = natural(value.fileCount);
    const totalBytes = natural(value.totalBytes);
    const gitBaseCommit =
      value.gitBaseCommit === undefined || value.gitBaseCommit === null
        ? null
        : typeof value.gitBaseCommit === "string" &&
            /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.gitBaseCommit)
          ? value.gitBaseCommit
          : undefined;
    const gitHeadRef =
      value.gitHeadRef === undefined || value.gitHeadRef === null
        ? null
        : typeof value.gitHeadRef === "string" &&
            value.gitHeadRef.length >= 1 &&
            value.gitHeadRef.length <= 512 &&
            // eslint-disable-next-line no-control-regex -- Git refs reject C0 and DEL
            !/[\u0000-\u001f\u007f]/u.test(value.gitHeadRef)
          ? value.gitHeadRef
          : undefined;
    if (
      typeof value.checkpointId !== "string" ||
      !UUID_PATTERN.test(value.checkpointId) ||
      revision === null ||
      typeof value.manifestBlobId !== "string" ||
      !UUID_PATTERN.test(value.manifestBlobId) ||
      typeof value.integritySha256 !== "string" ||
      !SHA256_PATTERN.test(value.integritySha256) ||
      fileCount === null ||
      totalBytes === null ||
      gitBaseCommit === undefined ||
      gitHeadRef === undefined ||
      (value.nextAfterPath !== null && typeof value.nextAfterPath !== "string")
    ) {
      throw new CloudReplicaClientError(0, "invalid_response", "Bootstrap response is invalid");
    }
    return {
      checkpointId: value.checkpointId,
      manifestRevision: revision,
      manifestBlobId: value.manifestBlobId,
      integritySha256: value.integritySha256,
      fileCount,
      totalBytes,
      gitBaseCommit,
      gitHeadRef,
      entries: value.entries.map((entry) => parseMutation(entry, false)) as CloudReplicaBootstrapPage["entries"],
      nextAfterPath: value.nextAfterPath as string | null,
    };
  }

  async createReplica(input: {
    organizationId: string;
    workspaceId: string;
    pathLabel: string | null;
    ignorePolicySha256: string;
    idempotencyKey: string;
  }): Promise<{
    replica: CloudReplicaRemoteState;
    grant: CloudReplicaGrant;
    replayed: boolean;
  }> {
    if (!SHA256_PATTERN.test(input.ignorePolicySha256)) {
      throw new CloudReplicaClientError(0, "invalid_request", "Ignore policy is invalid");
    }
    const body = {
      pathLabel: input.pathLabel,
      ignorePolicySha256: input.ignorePolicySha256,
    };
    const payload = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      ...body,
      idempotencyKey: input.idempotencyKey,
    };
    const value = await this.json<unknown>({
      method: "POST",
      path: `/v1/organizations/${uuid(input.organizationId, "Organization")}/cloud-workspaces/${uuid(input.workspaceId, "Workspace")}/replicas`,
      action: "replica.create",
      payload,
      body,
      idempotencyKey: input.idempotencyKey,
    });
    if (!isRecord(value) || typeof value.replayed !== "boolean") {
      throw new CloudReplicaClientError(0, "invalid_response", "Replica response is invalid");
    }
    return {
      replica: parseReplica(value.replica),
      grant: parseGrant(value.grant),
      replayed: value.replayed,
    };
  }

  async rotateDeviceKey(input: {
    newPublicKey: string;
    idempotencyKey: string;
  }): Promise<{ device: CloudReplicaRemoteDevice; replayed: boolean }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.newPublicKey)) {
      throw new CloudReplicaClientError(0, "invalid_request", "Device key is invalid");
    }
    const payload = {
      newPublicKey: input.newPublicKey,
      idempotencyKey: input.idempotencyKey,
    };
    const value = await this.json<unknown>({
      method: "PATCH",
      path: `/v1/devices/${this.signer.deviceId}/key`,
      action: "device.rotate",
      payload,
      body: { newPublicKey: input.newPublicKey },
      idempotencyKey: input.idempotencyKey,
    });
    if (!isRecord(value) || typeof value.replayed !== "boolean") {
      throw new CloudReplicaClientError(0, "invalid_response", "Device response is invalid");
    }
    return { device: parseDevice(value.device), replayed: value.replayed };
  }

  async changeReplicaState(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    operation: "pause" | "resume" | "remove";
    replaceDiverged?: boolean;
    idempotencyKey: string;
  }): Promise<{
    replica: CloudReplicaRemoteState;
    grant: CloudReplicaGrant | null;
    replayed: boolean;
  }> {
    const payload = {
      operation: input.operation,
      replaceDiverged: input.replaceDiverged === true,
      idempotencyKey: input.idempotencyKey,
    };
    const body =
      input.operation === "resume"
        ? { replaceDiverged: input.replaceDiverged === true }
        : undefined;
    const value = await this.json<unknown>({
      method: "POST",
      path: `${this.workspacePath(input)}/${input.operation}`,
      action: `replica.${input.operation}`,
      payload,
      ...(body ? { body } : {}),
      idempotencyKey: input.idempotencyKey,
    });
    if (!isRecord(value) || typeof value.replayed !== "boolean") {
      throw new CloudReplicaClientError(0, "invalid_response", "Replica state response is invalid");
    }
    return {
      replica: parseReplica(value.replica),
      grant: value.grant === null ? null : parseGrant(value.grant),
      replayed: value.replayed,
    };
  }

  async refreshSnapshot(input: Parameters<CloudReplicaApi["refreshSnapshot"]>[0]) {
    const payload = { replicaId: input.replicaId };
    const value = await this.json<unknown>({
      method: "POST",
      path: `${this.workspacePath(input)}/snapshot`,
      action: "replica.snapshot",
      payload,
    });
    if (!isRecord(value)) {
      throw new CloudReplicaClientError(0, "invalid_response", "Snapshot response is invalid");
    }
    return { replica: parseReplica(value.replica), grant: parseGrant(value.grant) };
  }

  async renewGrant(input: Parameters<CloudReplicaApi["renewGrant"]>[0]) {
    const payload = { replicaId: input.replicaId };
    const value = await this.json<unknown>({
      method: "POST",
      path: `${this.workspacePath(input)}/grants`,
      action: "replica.grant",
      payload,
    });
    if (!isRecord(value)) {
      throw new CloudReplicaClientError(0, "invalid_response", "Grant response is invalid");
    }
    return { replica: parseReplica(value.replica), grant: parseGrant(value.grant) };
  }

  async readEvents(input: Parameters<CloudReplicaApi["readEvents"]>[0]) {
    const payload = { afterRevision: input.afterRevision, limit: input.limit };
    if (
      natural(input.afterRevision) === null ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200
    ) {
      throw new CloudReplicaClientError(0, "invalid_request", "Event cursor is invalid");
    }
    const value = await this.json<unknown>({
      method: "GET",
      path: `${this.workspacePath(input)}/events?afterRevision=${input.afterRevision}&limit=${input.limit}`,
      action: "replica.events.read",
      payload,
      grantToken: input.grantToken,
    });
    if (!isRecord(value) || !Array.isArray(value.events)) {
      throw new CloudReplicaClientError(0, "invalid_response", "Event response is invalid");
    }
    const current = natural(value.currentRevision);
    const minimum = natural(value.minimumRetainedRevision);
    const from = natural(value.fromRevision);
    const to = natural(value.toRevision);
    if (
      current === null ||
      minimum === null ||
      from === null ||
      to === null ||
      typeof value.snapshotRequired !== "boolean" ||
      typeof value.hasMore !== "boolean"
    ) {
      throw new CloudReplicaClientError(0, "invalid_response", "Event response is invalid");
    }
    return {
      currentRevision: current,
      minimumRetainedRevision: minimum,
      snapshotRequired: value.snapshotRequired,
      fromRevision: from,
      toRevision: to,
      events: value.events.map((event) => parseMutation(event, true)) as CloudReplicaMutation[],
      hasMore: value.hasMore,
    };
  }

  async readBlob(input: Parameters<CloudReplicaApi["readBlob"]>[0]) {
    uuid(input.blobId, "Blob");
    if (
      !Number.isSafeInteger(input.expectedSizeBytes) ||
      input.expectedSizeBytes < 0 ||
      input.expectedSizeBytes > MAX_BLOB_BYTES
    ) {
      throw new CloudReplicaClientError(0, "invalid_request", "Blob size is invalid");
    }
    const payload = { blobId: input.blobId };
    const response = await this.request({
      method: "GET",
      path: `${this.workspacePath(input)}/blobs/${input.blobId}`,
      action: "replica.blob.read",
      payload,
      grantToken: input.grantToken,
    });
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await boundedJson(response);
      } catch {
        // Safe mapped error below; never reflect the provider body.
      }
      throw responseError(response, body);
    }
    const declared = response.headers.get("content-length");
    if (declared !== String(input.expectedSizeBytes)) {
      throw new CloudReplicaClientError(0, "invalid_response", "Blob length is invalid");
    }
    const bytes = await boundedBytes(response, input.expectedSizeBytes);
    if (bytes.byteLength !== input.expectedSizeBytes) {
      throw new CloudReplicaClientError(0, "invalid_response", "Blob length is invalid");
    }
    return bytes;
  }

  async recordReceipt(input: Parameters<CloudReplicaApi["recordReceipt"]>[0]) {
    const body = {
      fromRevision: input.fromRevision,
      toRevision: input.toRevision,
      manifestSha256: input.manifestSha256,
      outcome: input.outcome,
      errorCode: input.errorCode,
    };
    const payload = { ...body, idempotencyKey: input.idempotencyKey };
    const value = await this.json<unknown>({
      method: "POST",
      path: `${this.workspacePath(input)}/receipts`,
      action: "replica.receipt",
      payload,
      body,
      grantToken: input.grantToken,
      idempotencyKey: input.idempotencyKey,
    });
    if (!isRecord(value) || typeof value.replayed !== "boolean") {
      throw new CloudReplicaClientError(0, "invalid_response", "Receipt response is invalid");
    }
    return { replica: parseReplica(value.replica), replayed: value.replayed };
  }
}

/** Registration runs before a device id exists, so it is bearer-authenticated
 * but intentionally has no device proof. The returned identity must be bound
 * to the pending safeStorage key before a signed client is constructed. */
export class HttpCloudReplicaEnrollmentClient {
  private readonly baseUrl: string;
  private readonly requestFetch: typeof fetch;

  constructor(
    private readonly options: {
      baseUrl: string;
      getAccessToken: () => Promise<string | null>;
      fetch?: typeof fetch;
      allowInsecureLoopback?: boolean;
    },
  ) {
    this.baseUrl = secureBaseUrl(
      options.baseUrl,
      options.allowInsecureLoopback === true,
    );
    this.requestFetch = options.fetch ?? fetch;
  }

  async registerDevice(input: {
    label: string;
    platform: "macos" | "windows" | "linux";
    publicKey: string;
    idempotencyKey: string;
  }): Promise<{ device: CloudReplicaRemoteDevice; replayed: boolean }> {
    if (
      input.label.trim() !== input.label ||
      input.label.length < 1 ||
      input.label.length > 120 ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.publicKey)
    ) {
      throw new CloudReplicaClientError(0, "invalid_request", "Device input is invalid");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.requestFetch(`${this.baseUrl}/v1/devices`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer(await this.options.getAccessToken())}`,
          accept: "application/json",
          "content-type": "application/json",
          "cache-control": "no-store",
          "idempotency-key": idempotency(input.idempotencyKey),
        },
        body: JSON.stringify({
          label: input.label,
          platform: input.platform,
          publicKey: input.publicKey,
        }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      throw new CloudReplicaClientError(
        0,
        "network_error",
        "Cloud device registration is unavailable",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
    let value: unknown;
    try {
      value = await boundedJson(response);
    } catch (error) {
      throw new CloudReplicaClientError(
        response.status,
        "invalid_response",
        "Cloud device service returned an invalid response",
        { cause: error },
      );
    }
    if (!response.ok) throw responseError(response, value);
    if (!isRecord(value) || typeof value.replayed !== "boolean") {
      throw new CloudReplicaClientError(0, "invalid_response", "Device response is invalid");
    }
    return { device: parseDevice(value.device), replayed: value.replayed };
  }
}
