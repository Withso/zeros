import { createHash } from "node:crypto";
import path from "node:path";

import type Database from "better-sqlite3";

import type {
  CloudReplicaApplyJournal,
  CloudReplicaLocalEntry,
  CloudReplicaLocalStateStore,
} from "./cloud-replica-apply";
import { normalizeCloudReplicaPath } from "./cloud-replica-apply";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type CloudReplicaIgnorePolicy = {
  version: 1;
  /** Exact portable paths or directory prefixes, without a trailing slash. */
  excludePrefixes: string[];
};

export const DEFAULT_CLOUD_REPLICA_IGNORE_POLICY: CloudReplicaIgnorePolicy = {
  version: 1,
  excludePrefixes: [],
};

export type CloudDeviceRegistration = {
  accountUserId: string;
  deviceId: string;
  keyVersion: number;
  publicKey: string;
  keyFingerprint: string;
  registeredAt: number;
  updatedAt: number;
};

export type CloudReplicaLocalState = {
  replicaId: string;
  workspaceId: string;
  organizationId: string;
  accountUserId: string;
  deviceId: string;
  rootPath: string;
  desiredState: "active" | "paused" | "removed";
  observedState:
    | "bootstrapping"
    | "pending"
    | "syncing"
    | "in_sync"
    | "diverged"
    | "paused"
    | "detached"
    | "failed"
    | "removed";
  checkpointId: string | null;
  manifestRevision: number | null;
  eventCursor: number;
  workspaceAuthorityEpoch: number;
  grantEpoch: number;
  ignorePolicy: unknown;
  ignorePolicySha256: string;
  clientManifestSha256: string | null;
  lastErrorCode: string | null;
};

export class CloudReplicaStateError extends Error {
  constructor(
    public readonly code:
      | "invalid_state"
      | "not_found"
      | "identity_conflict"
      | "cursor_conflict",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CloudReplicaStateError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function cloudReplicaIgnorePolicySha256(policy: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(parseCloudReplicaIgnorePolicy(policy)), "utf8")
    .digest("hex");
}

export function parseCloudReplicaIgnorePolicy(
  value: unknown,
): CloudReplicaIgnorePolicy {
  const keys =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort().join("\0")
      : "";
  // Compatibility with the Phase-2 prototype policy already persisted by
  // internal builds. It meant exactly the baseline exclusions and no custom
  // prefixes; preserve that meaning while all new writes use the explicit
  // shape below.
  if (
    keys === "version" &&
    (value as { version?: unknown }).version === 1
  ) {
    return { version: 1, excludePrefixes: [] };
  }
  if (
    keys === ["defaults", "version"].sort().join("\0") &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { defaults?: unknown }).defaults) &&
    (value as { defaults: unknown[] }).defaults.length <= 128 &&
    (value as { defaults: unknown[] }).defaults.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= 255 &&
        // eslint-disable-next-line no-control-regex -- ignore prefixes reject C0 and DEL
        !/[\u0000-\u001f\u007f]/u.test(entry),
    )
  ) {
    return { version: 1, excludePrefixes: [] };
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    keys !==
      ["excludePrefixes", "version"].sort().join("\0") ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { excludePrefixes?: unknown }).excludePrefixes)
  ) {
    throw new CloudReplicaStateError(
      "invalid_state",
      "Replica ignore policy is invalid",
    );
  }
  const raw = (value as { excludePrefixes: unknown[] }).excludePrefixes;
  if (raw.length > 128 || raw.some((entry) => typeof entry !== "string")) {
    throw new CloudReplicaStateError(
      "invalid_state",
      "Replica ignore policy is invalid",
    );
  }
  const normalized = raw.map((entry) => normalizeCloudReplicaPath(entry as string));
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== raw.length) {
    throw new CloudReplicaStateError(
      "invalid_state",
      "Replica ignore policy contains duplicate paths",
    );
  }
  return { version: 1, excludePrefixes: unique };
}

export function cloudReplicaPathIncluded(
  policy: CloudReplicaIgnorePolicy,
  candidate: string,
): boolean {
  const normalized = normalizeCloudReplicaPath(candidate);
  return !policy.excludePrefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  if (
    !path.isAbsolute(rootPath) ||
    resolved !== rootPath ||
    resolved === path.parse(resolved).root ||
    // eslint-disable-next-line no-control-regex -- replica roots reject C0 and DEL
    /[\u0000-\u001f\u007f]/u.test(rootPath)
  ) {
    throw new CloudReplicaStateError("invalid_state", "Replica root is invalid");
  }
  return resolved;
}

type RegistrationRow = {
  account_user_id: string;
  device_id: string;
  key_version: number;
  public_key: string;
  key_fingerprint: string;
  registered_at: number;
  updated_at: number;
};

function registrationDocument(row: RegistrationRow): CloudDeviceRegistration {
  return {
    accountUserId: row.account_user_id,
    deviceId: row.device_id,
    keyVersion: row.key_version,
    publicKey: row.public_key,
    keyFingerprint: row.key_fingerprint,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

type ReplicaRow = {
  replica_id: string;
  workspace_id: string;
  organization_id: string;
  account_user_id: string;
  device_id: string;
  root_path: string;
  desired_state: CloudReplicaLocalState["desiredState"];
  observed_state: CloudReplicaLocalState["observedState"];
  checkpoint_id: string | null;
  manifest_revision: number | null;
  event_cursor: number;
  workspace_authority_epoch: number;
  grant_epoch: number;
  ignore_policy_json: string;
  ignore_policy_sha256: string;
  client_manifest_sha256: string | null;
  last_error_code: string | null;
};

function replicaDocument(row: ReplicaRow): CloudReplicaLocalState {
  let ignorePolicy: unknown;
  try {
    ignorePolicy = JSON.parse(row.ignore_policy_json) as unknown;
  } catch {
    throw new CloudReplicaStateError(
      "invalid_state",
      "Replica ignore policy is corrupt",
    );
  }
  return {
    replicaId: row.replica_id,
    workspaceId: row.workspace_id,
    organizationId: row.organization_id,
    accountUserId: row.account_user_id,
    deviceId: row.device_id,
    rootPath: row.root_path,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    checkpointId: row.checkpoint_id,
    manifestRevision: row.manifest_revision,
    eventCursor: row.event_cursor,
    workspaceAuthorityEpoch: row.workspace_authority_epoch,
    grantEpoch: row.grant_epoch,
    ignorePolicy,
    ignorePolicySha256: row.ignore_policy_sha256,
    clientManifestSha256: row.client_manifest_sha256,
    lastErrorCode: row.last_error_code,
  };
}

const REPLICA_COLUMNS = `
  replica_id, workspace_id, organization_id, account_user_id, device_id,
  root_path, desired_state, observed_state, checkpoint_id, manifest_revision,
  event_cursor, workspace_authority_epoch, grant_epoch, ignore_policy_json,
  ignore_policy_sha256, client_manifest_sha256, last_error_code`;

/** Engine-owned, device-private replica metadata. The Electron host owns the
 * Ed25519 private key and bearer grant; this store deliberately accepts only
 * public identity and non-secret cursor/projection state. */
export class DatabaseCloudReplicaState {
  constructor(private readonly db: Database.Database) {}

  registration(accountUserId: string): CloudDeviceRegistration | null {
    const row = this.db
      .prepare(
        `SELECT account_user_id, device_id, key_version, public_key,
                key_fingerprint, registered_at, updated_at
         FROM cloud_device_registrations WHERE account_user_id = ?`,
      )
      .get(accountUserId) as RegistrationRow | undefined;
    return row ? registrationDocument(row) : null;
  }

  recordRegistration(input: {
    accountUserId: string;
    deviceId: string;
    keyVersion: number;
    publicKey: string;
  }): CloudDeviceRegistration {
    if (
      !UUID_PATTERN.test(input.accountUserId) ||
      !UUID_PATTERN.test(input.deviceId) ||
      !positiveInteger(input.keyVersion) ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.publicKey)
    ) {
      throw new CloudReplicaStateError(
        "invalid_state",
        "Device registration is invalid",
      );
    }
    const raw = Buffer.from(input.publicKey, "base64url");
    if (raw.length !== 32 || raw.toString("base64url") !== input.publicKey) {
      raw.fill(0);
      throw new CloudReplicaStateError(
        "invalid_state",
        "Device public key is invalid",
      );
    }
    const fingerprint = createHash("sha256").update(raw).digest("hex");
    raw.fill(0);
    const now = Date.now();
    const current = this.registration(input.accountUserId);
    if (current && current.deviceId !== input.deviceId) {
      throw new CloudReplicaStateError(
        "identity_conflict",
        "A different cloud device is already bound to this account",
      );
    }
    this.db
      .prepare(
        `INSERT INTO cloud_device_registrations (
           account_user_id, device_id, key_version, public_key,
           key_fingerprint, registered_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_user_id) DO UPDATE SET
           key_version = excluded.key_version,
           public_key = excluded.public_key,
           key_fingerprint = excluded.key_fingerprint,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.accountUserId,
        input.deviceId,
        input.keyVersion,
        input.publicKey,
        fingerprint,
        current?.registeredAt ?? now,
        now,
      );
    return this.registration(input.accountUserId)!;
  }

  createReplica(input: {
    replicaId: string;
    workspaceId: string;
    organizationId: string;
    accountUserId: string;
    deviceId: string;
    rootPath: string;
    checkpointId: string;
    manifestRevision: number;
    workspaceAuthorityEpoch: number;
    grantEpoch: number;
    ignorePolicy: unknown;
  }): CloudReplicaLocalState {
    if (
      ![
        input.replicaId,
        input.workspaceId,
        input.organizationId,
        input.accountUserId,
        input.deviceId,
        input.checkpointId,
      ].every((value) => UUID_PATTERN.test(value)) ||
      !Number.isSafeInteger(input.manifestRevision) ||
      input.manifestRevision < 0 ||
      !positiveInteger(input.workspaceAuthorityEpoch) ||
      !positiveInteger(input.grantEpoch)
    ) {
      throw new CloudReplicaStateError("invalid_state", "Replica identity is invalid");
    }
    const registration = this.registration(input.accountUserId);
    if (!registration || registration.deviceId !== input.deviceId) {
      throw new CloudReplicaStateError(
        "identity_conflict",
        "Replica device is not registered for this account",
      );
    }
    const policy = canonicalJson(parseCloudReplicaIgnorePolicy(input.ignorePolicy));
    const policySha256 = createHash("sha256").update(policy, "utf8").digest("hex");
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO cloud_replica_local_state (
             replica_id, workspace_id, organization_id, account_user_id,
             device_id, root_path, desired_state, observed_state,
             checkpoint_id, manifest_revision, event_cursor,
             workspace_authority_epoch, grant_epoch, ignore_policy_json,
             ignore_policy_sha256, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'bootstrapping', ?, ?, 0,
                     ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.replicaId,
          input.workspaceId,
          input.organizationId,
          input.accountUserId,
          input.deviceId,
          canonicalRoot(input.rootPath),
          input.checkpointId,
          input.manifestRevision,
          input.workspaceAuthorityEpoch,
          input.grantEpoch,
          policy,
          policySha256,
          now,
          now,
        );
    } catch (error) {
      throw new CloudReplicaStateError(
        "identity_conflict",
        "Replica identity or local path is already registered",
        { cause: error },
      );
    }
    return this.replica(input.replicaId)!;
  }

  replica(replicaId: string): CloudReplicaLocalState | null {
    const row = this.db
      .prepare(`SELECT ${REPLICA_COLUMNS} FROM cloud_replica_local_state WHERE replica_id = ?`)
      .get(replicaId) as ReplicaRow | undefined;
    return row ? replicaDocument(row) : null;
  }

  activeReplicas(filter?: {
    accountUserId?: string;
    deviceId?: string;
  }): CloudReplicaLocalState[] {
    return this.replicas({ ...filter, desiredState: "active" });
  }

  replicas(filter?: {
    accountUserId?: string;
    deviceId?: string;
    desiredState?: CloudReplicaLocalState["desiredState"];
  }): CloudReplicaLocalState[] {
    const predicates: string[] = [];
    const parameters: string[] = [];
    if (filter?.accountUserId) {
      predicates.push("account_user_id = ?");
      parameters.push(filter.accountUserId);
    }
    if (filter?.deviceId) {
      predicates.push("device_id = ?");
      parameters.push(filter.deviceId);
    }
    if (filter?.desiredState) {
      predicates.push("desired_state = ?");
      parameters.push(filter.desiredState);
    }
    return (
      this.db
        .prepare(
          `SELECT ${REPLICA_COLUMNS} FROM cloud_replica_local_state
           ${predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : ""}
           ORDER BY updated_at, replica_id`,
        )
        .all(...parameters) as ReplicaRow[]
    ).map(replicaDocument);
  }

  relocateReplica(replicaId: string, rootPath: string): CloudReplicaLocalState {
    const current = this.replica(replicaId);
    if (!current) {
      throw new CloudReplicaStateError("not_found", "Local replica was not found");
    }
    if (current.desiredState === "active") {
      throw new CloudReplicaStateError(
        "invalid_state",
        "Pause a cloud replica before relocating it",
      );
    }
    try {
      this.db
        .prepare(
          `UPDATE cloud_replica_local_state
           SET root_path = ?, observed_state = 'detached', updated_at = ?
           WHERE replica_id = ? AND desired_state <> 'active'`,
        )
        .run(canonicalRoot(rootPath), Date.now(), replicaId);
    } catch (error) {
      throw new CloudReplicaStateError(
        "identity_conflict",
        "Replica path is already registered",
        { cause: error },
      );
    }
    return this.replica(replicaId)!;
  }

  openDivergences(replicaId: string): Array<{
    path: string;
    detectedAt: number;
    expectedSha256: string | null;
    observedSha256: string | null;
    cloudSha256: string | null;
  }> {
    if (!this.replica(replicaId)) {
      throw new CloudReplicaStateError("not_found", "Local replica was not found");
    }
    return (
      this.db
        .prepare(
          `SELECT normalized_path, detected_at, expected_sha256,
                  observed_sha256, cloud_sha256
           FROM cloud_replica_divergences
           WHERE replica_id = ? AND resolution IS NULL
           ORDER BY detected_at, normalized_path`,
        )
        .all(replicaId) as Array<{
        normalized_path: string;
        detected_at: number;
        expected_sha256: string | null;
        observed_sha256: string | null;
        cloud_sha256: string | null;
      }>
    ).map((row) => ({
      path: row.normalized_path,
      detectedAt: row.detected_at,
      expectedSha256: row.expected_sha256,
      observedSha256: row.observed_sha256,
      cloudSha256: row.cloud_sha256,
    }));
  }

  hasOpenDivergences(replicaId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM cloud_replica_divergences
           WHERE replica_id = ? AND resolution IS NULL LIMIT 1`,
        )
        .get(replicaId),
    );
  }

  resolveDivergences(input: {
    replicaId: string;
    paths: readonly { path: string; detectedAt: number }[];
    resolution: "replace_from_cloud" | "saved_as_copy" | "removed_local";
  }): CloudReplicaLocalState {
    const current = this.replica(input.replicaId);
    if (!current) {
      throw new CloudReplicaStateError("not_found", "Local replica was not found");
    }
    const unique = new Set(input.paths.map((entry) => entry.path));
    if (
      input.paths.length < 1 ||
      unique.size !== input.paths.length ||
      input.paths.some(
        (entry) =>
          normalizeCloudReplicaPath(entry.path) !== entry.path ||
          !Number.isSafeInteger(entry.detectedAt) ||
          entry.detectedAt < 0,
      )
    ) {
      throw new CloudReplicaStateError(
        "invalid_state",
        "Replica divergence resolution is invalid",
      );
    }
    this.db.transaction(() => {
      const resolve = this.db.prepare(
        `UPDATE cloud_replica_divergences
         SET resolution = ?, resolved_at = ?
         WHERE replica_id = ? AND normalized_path = ? AND detected_at = ?
           AND resolution IS NULL`,
      );
      const removeProjection = this.db.prepare(
        `DELETE FROM cloud_replica_entries
         WHERE replica_id = ? AND normalized_path = ?`,
      );
      const now = Date.now();
      for (const entry of input.paths) {
        const result = resolve.run(
          input.resolution,
          now,
          input.replicaId,
          entry.path,
          entry.detectedAt,
        );
        if (result.changes !== 1) {
          throw new CloudReplicaStateError(
            "cursor_conflict",
            "Replica divergence changed during resolution",
          );
        }
        // The next cloud page is authoritative for the replacement. Forgetting
        // the prior projection makes a missing target a safe first apply while
        // the preserved copy remains outside the replica root.
        removeProjection.run(input.replicaId, entry.path);
      }
      const stillOpen = this.db
        .prepare(
          `SELECT 1 FROM cloud_replica_divergences
           WHERE replica_id = ? AND resolution IS NULL LIMIT 1`,
        )
        .get(input.replicaId);
      if (!stillOpen) {
        this.db
          .prepare(
            `UPDATE cloud_replica_local_state
             SET observed_state = CASE
                   WHEN desired_state = 'active' THEN 'syncing'
                   WHEN desired_state = 'paused' THEN 'paused'
                   ELSE observed_state
                 END,
                 last_error_code = NULL, updated_at = ?
             WHERE replica_id = ?`,
          )
          .run(now, input.replicaId);
      }
    })();
    return this.replica(input.replicaId)!;
  }

  updateRemoteState(input: {
    replicaId: string;
    desiredState: CloudReplicaLocalState["desiredState"];
    observedState: CloudReplicaLocalState["observedState"];
    workspaceAuthorityEpoch: number;
    grantEpoch: number;
    checkpointId?: string | null;
    manifestRevision?: number | null;
    lastErrorCode?: string | null;
  }): CloudReplicaLocalState {
    if (
      !positiveInteger(input.workspaceAuthorityEpoch) ||
      !positiveInteger(input.grantEpoch)
    ) {
      throw new CloudReplicaStateError("invalid_state", "Replica epoch is invalid");
    }
    this.assertRemoteAuthority(input);
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE cloud_replica_local_state SET
           desired_state = ?, observed_state = ?, workspace_authority_epoch = ?,
           grant_epoch = ?, checkpoint_id = COALESCE(?, checkpoint_id),
           manifest_revision = COALESCE(?, manifest_revision),
           last_error_code = ?,
           removed_at = CASE WHEN ? = 'removed' THEN ? ELSE NULL END,
           updated_at = ?
         WHERE replica_id = ?
           AND workspace_authority_epoch <= ?
           AND grant_epoch <= ?
           AND (grant_epoch < ? OR desired_state = ?)`,
      )
      .run(
        input.desiredState,
        input.observedState,
        input.workspaceAuthorityEpoch,
        input.grantEpoch,
        input.checkpointId ?? null,
        input.manifestRevision ?? null,
        input.lastErrorCode ?? null,
        input.desiredState,
        now,
        now,
        input.replicaId,
        input.workspaceAuthorityEpoch,
        input.grantEpoch,
        input.grantEpoch,
        input.desiredState,
      );
    if (result.changes !== 1) {
      if (this.replica(input.replicaId)) {
        throw new CloudReplicaStateError(
          "cursor_conflict",
          "Replica authority epoch moved backwards",
        );
      }
      throw new CloudReplicaStateError("not_found", "Local replica was not found");
    }
    return this.replica(input.replicaId)!;
  }

  assertRemoteAuthority(input: {
    replicaId: string;
    desiredState: CloudReplicaLocalState["desiredState"];
    workspaceAuthorityEpoch: number;
    grantEpoch: number;
  }): CloudReplicaLocalState {
    if (
      !positiveInteger(input.workspaceAuthorityEpoch) ||
      !positiveInteger(input.grantEpoch)
    ) {
      throw new CloudReplicaStateError("invalid_state", "Replica epoch is invalid");
    }
    const current = this.replica(input.replicaId);
    if (!current) {
      throw new CloudReplicaStateError("not_found", "Local replica was not found");
    }
    if (
      current.workspaceAuthorityEpoch > input.workspaceAuthorityEpoch ||
      current.grantEpoch > input.grantEpoch ||
      (current.grantEpoch === input.grantEpoch &&
        current.desiredState !== input.desiredState)
    ) {
      throw new CloudReplicaStateError(
        "cursor_conflict",
        "Replica authority epoch moved backwards",
      );
    }
    return current;
  }

  advanceReceipt(input: {
    replicaId: string;
    fromRevision: number;
    toRevision: number;
    manifestSha256: string;
    observedState: "syncing" | "in_sync";
  }): CloudReplicaLocalState {
    if (
      !Number.isSafeInteger(input.fromRevision) ||
      input.fromRevision < 0 ||
      !Number.isSafeInteger(input.toRevision) ||
      input.toRevision < input.fromRevision ||
      !SHA256_PATTERN.test(input.manifestSha256)
    ) {
      throw new CloudReplicaStateError("invalid_state", "Replica receipt is invalid");
    }
    const result = this.db
      .prepare(
        `UPDATE cloud_replica_local_state
         SET event_cursor = ?, client_manifest_sha256 = ?, observed_state = ?,
             last_error_code = NULL, updated_at = ?
         WHERE replica_id = ? AND event_cursor = ? AND desired_state = 'active'`,
      )
      .run(
        input.toRevision,
        input.manifestSha256,
        input.observedState,
        Date.now(),
        input.replicaId,
        input.fromRevision,
      );
    if (result.changes !== 1) {
      throw new CloudReplicaStateError(
        "cursor_conflict",
        "Local replica cursor changed during receipt",
      );
    }
    return this.replica(input.replicaId)!;
  }

  resetForSnapshot(input: {
    replicaId: string;
    checkpointId: string;
    manifestRevision: number;
    workspaceAuthorityEpoch: number;
    grantEpoch: number;
  }): CloudReplicaLocalState {
    if (
      !UUID_PATTERN.test(input.checkpointId) ||
      !Number.isSafeInteger(input.manifestRevision) ||
      input.manifestRevision < 0 ||
      !positiveInteger(input.workspaceAuthorityEpoch) ||
      !positiveInteger(input.grantEpoch)
    ) {
      throw new CloudReplicaStateError("invalid_state", "Snapshot state is invalid");
    }
    this.assertRemoteAuthority({
      ...input,
      desiredState: "active",
    });
    const result = this.db
      .prepare(
        `UPDATE cloud_replica_local_state SET
           checkpoint_id = ?, manifest_revision = ?, event_cursor = 0,
           workspace_authority_epoch = ?, grant_epoch = ?,
           observed_state = 'bootstrapping', client_manifest_sha256 = NULL,
           last_error_code = NULL, updated_at = ?
         WHERE replica_id = ? AND desired_state = 'active'
           AND workspace_authority_epoch <= ?
           AND grant_epoch <= ?`,
      )
      .run(
        input.checkpointId,
        input.manifestRevision,
        input.workspaceAuthorityEpoch,
        input.grantEpoch,
        Date.now(),
        input.replicaId,
        input.workspaceAuthorityEpoch,
        input.grantEpoch,
      );
    if (result.changes !== 1) {
      const current = this.replica(input.replicaId);
      if (
        current &&
        (current.workspaceAuthorityEpoch > input.workspaceAuthorityEpoch ||
          current.grantEpoch > input.grantEpoch)
      ) {
        throw new CloudReplicaStateError(
          "cursor_conflict",
          "Replica authority epoch moved backwards",
        );
      }
      throw new CloudReplicaStateError("not_found", "Active local replica was not found");
    }
    return this.replica(input.replicaId)!;
  }

  adoptRemoteCursor(input: {
    replicaId: string;
    fromRevision: number;
    toRevision: number;
    manifestSha256: string;
    observedState: "syncing" | "in_sync";
  }): CloudReplicaLocalState {
    // Same CAS as an ordinary receipt, intentionally named separately at the
    // call site: this is allowed only after renewing a grant proves that the
    // server already accepted a response-lost receipt whose manifest equals
    // the complete on-disk projection.
    return this.advanceReceipt(input);
  }

  markFailed(replicaId: string, errorCode: string): void {
    if (!/^[a-z][a-z0-9_]{2,127}$/.test(errorCode)) {
      throw new CloudReplicaStateError("invalid_state", "Replica error is invalid");
    }
    const result = this.db
      .prepare(
        `UPDATE cloud_replica_local_state
         SET observed_state = 'failed', last_error_code = ?, updated_at = ?
         WHERE replica_id = ? AND desired_state <> 'removed'`,
      )
      .run(errorCode, Date.now(), replicaId);
    if (result.changes !== 1) {
      throw new CloudReplicaStateError("not_found", "Local replica was not found");
    }
  }

  markDetached(replicaId: string, errorCode: string): CloudReplicaLocalState {
    if (!/^[a-z][a-z0-9_]{2,127}$/.test(errorCode)) {
      throw new CloudReplicaStateError("invalid_state", "Replica error is invalid");
    }
    const result = this.db
      .prepare(
        `UPDATE cloud_replica_local_state
         SET desired_state = 'paused', observed_state = 'detached',
             last_error_code = ?, updated_at = ?
         WHERE replica_id = ? AND desired_state <> 'removed'`,
      )
      .run(errorCode, Date.now(), replicaId);
    if (result.changes !== 1) {
      throw new CloudReplicaStateError("not_found", "Local replica was not found");
    }
    return this.replica(replicaId)!;
  }

  projection(replicaId: string): CloudReplicaLocalStateStore {
    if (!this.replica(replicaId)) {
      throw new CloudReplicaStateError("not_found", "Local replica was not found");
    }
    return new SqliteCloudReplicaProjection(this.db, replicaId);
  }

  projectionEntries(replicaId: string): CloudReplicaLocalEntry[] {
    if (!this.replica(replicaId)) {
      throw new CloudReplicaStateError("not_found", "Local replica was not found");
    }
    const rows = this.db
      .prepare(
        `SELECT normalized_path, portable_path_key, revision, entry_type, mode,
                content_sha256, size_bytes
         FROM cloud_replica_entries WHERE replica_id = ?
         ORDER BY normalized_path COLLATE BINARY`,
      )
      .all(replicaId) as Array<{
      normalized_path: string;
      portable_path_key: string;
      revision: number;
      entry_type: "file" | "symlink";
      mode: 33188 | 33261 | 40960;
      content_sha256: string;
      size_bytes: number;
    }>;
    return rows.map((row) => ({
      path: row.normalized_path,
      portablePathKey: row.portable_path_key,
      revision: row.revision,
      entryType: row.entry_type,
      mode: row.mode,
      contentSha256: row.content_sha256,
      sizeBytes: row.size_bytes,
    }));
  }
}

class SqliteCloudReplicaProjection implements CloudReplicaLocalStateStore {
  constructor(
    private readonly db: Database.Database,
    private readonly replicaId: string,
  ) {}

  entry(normalizedPath: string): CloudReplicaLocalEntry | null {
    const row = this.db
      .prepare(
        `SELECT normalized_path, portable_path_key, revision, entry_type, mode,
                content_sha256, size_bytes
         FROM cloud_replica_entries
         WHERE replica_id = ? AND normalized_path = ?`,
      )
      .get(this.replicaId, normalizedPath) as
      | {
          normalized_path: string;
          portable_path_key: string;
          revision: number;
          entry_type: "file" | "symlink";
          mode: 33188 | 33261 | 40960;
          content_sha256: string;
          size_bytes: number;
        }
      | undefined;
    return row
      ? {
          path: row.normalized_path,
          portablePathKey: row.portable_path_key,
          revision: row.revision,
          entryType: row.entry_type,
          mode: row.mode,
          contentSha256: row.content_sha256,
          sizeBytes: row.size_bytes,
        }
      : null;
  }

  entryByPortablePath(portablePathKey: string): CloudReplicaLocalEntry | null {
    const row = this.db
      .prepare(
        `SELECT normalized_path FROM cloud_replica_entries
         WHERE replica_id = ? AND portable_path_key = ?`,
      )
      .get(this.replicaId, portablePathKey) as
      | { normalized_path: string }
      | undefined;
    return row ? this.entry(row.normalized_path) : null;
  }

  journal(value: CloudReplicaApplyJournal): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO cloud_replica_apply_journal (
           replica_id, normalized_path, operation, from_revision, to_revision,
           stage_path, expected_previous_sha256, next_content_sha256, state,
           error_code, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(replica_id, normalized_path) DO UPDATE SET
           operation = excluded.operation,
           from_revision = excluded.from_revision,
           to_revision = excluded.to_revision,
           stage_path = excluded.stage_path,
           expected_previous_sha256 = excluded.expected_previous_sha256,
           next_content_sha256 = excluded.next_content_sha256,
           state = excluded.state,
           error_code = excluded.error_code,
           updated_at = excluded.updated_at`,
      )
      .run(
        this.replicaId,
        value.path,
        value.operation,
        value.fromRevision,
        value.toRevision,
        value.stagePath,
        value.expectedPreviousSha256,
        value.nextContentSha256,
        value.state,
        value.errorCode,
        now,
        now,
      );
  }

  commitEntry(value: CloudReplicaLocalEntry): void {
    this.db
      .prepare(
        `INSERT INTO cloud_replica_entries (
           replica_id, normalized_path, portable_path_key, revision,
           entry_type, mode, content_sha256, size_bytes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(replica_id, normalized_path) DO UPDATE SET
           portable_path_key = excluded.portable_path_key,
           revision = excluded.revision,
           entry_type = excluded.entry_type,
           mode = excluded.mode,
           content_sha256 = excluded.content_sha256,
           size_bytes = excluded.size_bytes`,
      )
      .run(
        this.replicaId,
        value.path,
        value.portablePathKey,
        value.revision,
        value.entryType,
        value.mode,
        value.contentSha256,
        value.sizeBytes,
      );
  }

  commitDeletion(normalizedPath: string): void {
    this.db
      .prepare(
        `DELETE FROM cloud_replica_entries
         WHERE replica_id = ? AND normalized_path = ?`,
      )
      .run(this.replicaId, normalizedPath);
  }

  divergence(value: {
    path: string;
    expectedSha256: string | null;
    observedSha256: string | null;
    cloudSha256: string | null;
  }): void {
    this.db.transaction(() => {
      const open = this.db
        .prepare(
          `SELECT 1 FROM cloud_replica_divergences
           WHERE replica_id = ? AND normalized_path = ?
             AND resolution IS NULL LIMIT 1`,
        )
        .get(this.replicaId, value.path);
      if (open) {
        this.db
          .prepare(
            `UPDATE cloud_replica_local_state
             SET observed_state = 'diverged',
                 last_error_code = 'local_content_changed', updated_at = ?
             WHERE replica_id = ?`,
          )
          .run(Date.now(), this.replicaId);
        return;
      }
      const last = this.db
        .prepare(
          `SELECT max(detected_at) AS detected_at
           FROM cloud_replica_divergences
           WHERE replica_id = ? AND normalized_path = ?`,
        )
        .get(this.replicaId, value.path) as { detected_at: number | null };
      const detectedAt = Math.max(Date.now(), (last.detected_at ?? 0) + 1);
      this.db
        .prepare(
          `INSERT INTO cloud_replica_divergences (
             replica_id, normalized_path, detected_at, expected_sha256,
             observed_sha256, cloud_sha256
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.replicaId,
          value.path,
          detectedAt,
          value.expectedSha256,
          value.observedSha256,
          value.cloudSha256,
        );
      this.db
        .prepare(
          `UPDATE cloud_replica_local_state
           SET observed_state = 'diverged', last_error_code = 'local_content_changed',
               updated_at = ? WHERE replica_id = ?`,
        )
        .run(detectedAt, this.replicaId);
    })();
  }

  manifestSha256(): string {
    const rows = this.db
      .prepare(
        `SELECT normalized_path, entry_type, mode, content_sha256, size_bytes
         FROM cloud_replica_entries WHERE replica_id = ?
         ORDER BY normalized_path COLLATE BINARY`,
      )
      .all(this.replicaId) as Array<{
      normalized_path: string;
      entry_type: "file" | "symlink";
      mode: number;
      content_sha256: string;
      size_bytes: number;
    }>;
    const hash = createHash("sha256");
    for (const row of rows) {
      hash.update(
        `${JSON.stringify([
          row.normalized_path,
          row.entry_type,
          row.mode,
          row.content_sha256,
          row.size_bytes,
        ])}\n`,
        "utf8",
      );
    }
    return hash.digest("hex");
  }
}
