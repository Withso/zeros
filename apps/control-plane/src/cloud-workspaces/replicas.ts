import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";

import type pg from "pg";

import { audit } from "../audit.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import {
  authorizeCloudWorkspaceDataAccess,
  authorizeCloudWorkspaceOperation,
} from "./authorization.js";
import type { DatabaseCloudWorkspaceBlobService } from "./object-store.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{2,127}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PROOF_SKEW_MS = 5 * 60_000;
// A proof timestamp can be five minutes in the future and remain admissible
// for another five minutes. Retain its nonce just beyond that complete replay
// window instead of allowing one trusted device to accumulate a full day of
// otherwise-dead nonce rows.
const PROOF_NONCE_RETENTION_MS = PROOF_SKEW_MS * 2 + 60_000;

export type CloudWorkspaceDeviceProof = {
  deviceId: string;
  keyVersion: number;
  timestampMs: number;
  nonce: string;
  signature: string;
};

export class WorkspaceReplicaError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "not_found"
      | "not_ready"
      | "idempotency_conflict"
      | "device_key_conflict"
      | "device_proof_rejected"
      | "device_proof_replayed"
      | "grant_rejected"
      | "cursor_conflict"
      | "bootstrap_required"
      | "divergence_resolution_required"
      | "blob_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceReplicaError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function requestDigest(value: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest();
}

function decodeCanonicalBase64url(
  value: string,
  bytes: number,
  label: string,
): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new WorkspaceReplicaError("invalid_input", `${label} is invalid`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length !== bytes ||
    decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    throw new WorkspaceReplicaError("invalid_input", `${label} is invalid`);
  }
  return decoded;
}

function decodePublicKey(value: string): Buffer {
  return decodeCanonicalBase64url(value, 32, "Device public key");
}

function fingerprint(publicKey: Uint8Array): Buffer {
  return createHash("sha256").update(publicKey).digest();
}

/** Stable proof bytes shared by the desktop signer and coordinator verifier.
 * The account id and fixed operation prevent a proof from being replayed by a
 * different account, endpoint, or mutation even before nonce storage is read. */
export function cloudWorkspaceDeviceProofMessage(input: {
  accountUserId: string;
  deviceId: string;
  keyVersion: number;
  action: string;
  timestampMs: number;
  nonce: string;
  payload: unknown;
}): Buffer {
  return Buffer.from(
    [
      "zeros-cloud-device-proof-v1",
      input.accountUserId,
      input.deviceId,
      String(input.keyVersion),
      input.action,
      String(input.timestampMs),
      input.nonce,
      requestDigest(input.payload).toString("hex"),
    ].join("\n"),
    "utf8",
  );
}

export type CloudWorkspaceVerifiedDevice = {
  id: string;
  user_id: string;
  label: string;
  platform: "macos" | "windows" | "linux";
  public_key: Buffer;
  key_fingerprint: Buffer;
  trust_state: string;
  key_version: string | number;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
};

type DeviceRow = CloudWorkspaceVerifiedDevice;

/** Consume one Ed25519 device proof in the caller's transaction. Keeping nonce
 * publication in that transaction lets higher-level capabilities (replica and
 * export grants) either commit with the proof or roll it back for a safe retry. */
export async function consumeCloudWorkspaceDeviceProof(
  tx: Tx,
  input: {
    accountUserId: string;
    action: string;
    payload: unknown;
    proof: CloudWorkspaceDeviceProof;
  },
  now: () => number = Date.now,
): Promise<CloudWorkspaceVerifiedDevice> {
  const proof = input.proof;
  if (
    !UUID_PATTERN.test(input.accountUserId) ||
    !UUID_PATTERN.test(proof.deviceId) ||
    !Number.isSafeInteger(proof.keyVersion) ||
    proof.keyVersion < 1 ||
    !Number.isSafeInteger(proof.timestampMs) ||
    Math.abs(now() - proof.timestampMs) > PROOF_SKEW_MS ||
    !/^[a-z][a-z0-9_.-]{2,127}$/.test(input.action)
  ) {
    throw new WorkspaceReplicaError(
      "device_proof_rejected",
      "Device proof is not current",
    );
  }
  const nonce = decodeCanonicalBase64url(proof.nonce, 24, "Device nonce");
  const signature = decodeCanonicalBase64url(
    proof.signature,
    64,
    "Device signature",
  );
  const device = (
    await tx.query<CloudWorkspaceVerifiedDevice>(
      `SELECT id, user_id, label, platform, public_key, key_fingerprint,
              trust_state, key_version, created_at, last_seen_at, revoked_at
       FROM devices
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [proof.deviceId, input.accountUserId],
    )
  ).rows[0];
  if (
    !device ||
    device.trust_state !== "trusted" ||
    Number(device.key_version) !== proof.keyVersion ||
    device.public_key.length !== 32
  ) {
    nonce.fill(0);
    signature.fill(0);
    throw new WorkspaceReplicaError(
      "device_proof_rejected",
      "Device proof is not current",
    );
  }
  const message = cloudWorkspaceDeviceProofMessage({
    accountUserId: input.accountUserId,
    deviceId: proof.deviceId,
    keyVersion: proof.keyVersion,
    action: input.action,
    timestampMs: proof.timestampMs,
    nonce: proof.nonce,
    payload: input.payload,
  });
  let valid = false;
  try {
    valid = verifySignature(
      null,
      message,
      createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, device.public_key]),
        format: "der",
        type: "spki",
      }),
      signature,
    );
  } finally {
    signature.fill(0);
  }
  if (!valid) {
    nonce.fill(0);
    throw new WorkspaceReplicaError(
      "device_proof_rejected",
      "Device proof is invalid",
    );
  }
  const nonceSha256 = createHash("sha256").update(nonce).digest();
  nonce.fill(0);
  await tx.query(
    `DELETE FROM device_request_nonces
     WHERE device_id = $1 AND expires_at <= now()`,
    [device.id],
  );
  const consumed = await tx.query(
    `INSERT INTO device_request_nonces (
       device_id, user_id, nonce_sha256, requested_at, expires_at
     ) VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000),
               now() + ($5::bigint * interval '1 millisecond'))
     ON CONFLICT DO NOTHING`,
    [
      device.id,
      input.accountUserId,
      nonceSha256,
      proof.timestampMs,
      PROOF_NONCE_RETENTION_MS,
    ],
  );
  if ((consumed.rowCount ?? 0) !== 1) {
    throw new WorkspaceReplicaError(
      "device_proof_replayed",
      "Device proof was already used",
    );
  }
  await tx.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [
    device.id,
  ]);
  device.last_seen_at = new Date(now());
  return device;
}

function deviceDocument(row: DeviceRow) {
  return {
    id: row.id,
    label: row.label,
    platform: row.platform,
    keyAlgorithm: "ed25519" as const,
    keyFingerprint: row.key_fingerprint.toString("hex"),
    keyVersion: Number(row.key_version),
    trustState: row.trust_state,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

type ReplicaRow = {
  id: string;
  workspace_id: string;
  org_id: string;
  user_id: string;
  device_id: string;
  mode: "receive_only";
  desired_state: "active" | "paused" | "removed";
  observed_state: string;
  path_label: string | null;
  authority_epoch: string | number;
  grant_epoch: string | number;
  checkpoint_id: string | null;
  manifest_revision: string | number | null;
  event_cursor: string | number;
  ignore_policy_sha256: Buffer | null;
  client_manifest_sha256: Buffer | null;
  last_applied_at: Date | null;
  last_error_code: string | null;
  version: string | number;
  created_at: Date;
  updated_at: Date;
  removed_at: Date | null;
};

function replicaDocument(row: ReplicaRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    organizationId: row.org_id,
    deviceId: row.device_id,
    mode: row.mode,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    pathLabel: row.path_label,
    workspaceAuthorityEpoch: Number(row.authority_epoch),
    grantEpoch: Number(row.grant_epoch),
    checkpointId: row.checkpoint_id,
    manifestRevision:
      row.manifest_revision === null ? null : Number(row.manifest_revision),
    eventCursor: Number(row.event_cursor),
    ignorePolicySha256: row.ignore_policy_sha256?.toString("hex") ?? null,
    clientManifestSha256:
      row.client_manifest_sha256?.toString("hex") ?? null,
    lastAppliedAt: row.last_applied_at?.toISOString() ?? null,
    lastErrorCode: row.last_error_code,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    removedAt: row.removed_at?.toISOString() ?? null,
  };
}

const REPLICA_COLUMNS = `
  replica.id, replica.workspace_id, replica.org_id, replica.user_id,
  replica.device_id, replica.mode, replica.desired_state,
  replica.observed_state, replica.path_label, replica.authority_epoch,
  replica.grant_epoch, replica.checkpoint_id, replica.manifest_revision,
  replica.event_cursor, replica.ignore_policy_sha256,
  replica.client_manifest_sha256, replica.last_applied_at,
  replica.last_error_code, replica.version, replica.created_at,
  replica.updated_at, replica.removed_at`;

export class DatabaseCloudWorkspaceReplicaService {
  private readonly now: () => number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly blobs: DatabaseCloudWorkspaceBlobService,
    private readonly workosEnabled: boolean,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  private async consumeDeviceProof(
    tx: Tx,
    input: {
      accountUserId: string;
      action: string;
      payload: unknown;
      proof: CloudWorkspaceDeviceProof;
    },
  ): Promise<DeviceRow> {
    return consumeCloudWorkspaceDeviceProof(tx, input, this.now);
  }

  async registerDevice(input: {
    accountUserId: string;
    label: string;
    platform: "macos" | "windows" | "linux";
    publicKey: string;
    idempotencyKey: string;
  }) {
    if (
      !UUID_PATTERN.test(input.accountUserId) ||
      !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
      input.label.trim() !== input.label ||
      input.label.length < 1 ||
      input.label.length > 120 ||
      /[\u0000-\u001f\u007f]/u.test(input.label)
    ) {
      throw new WorkspaceReplicaError("invalid_input", "Device input is invalid");
    }
    const publicKey = decodePublicKey(input.publicKey);
    const keyFingerprint = fingerprint(publicKey);
    const digest = requestDigest({
      label: input.label,
      platform: input.platform,
      publicKey: input.publicKey,
    });
    try {
      return await withSystemTx(this.pool, async (tx) => {
        const account = await tx.query(
          `SELECT 1 FROM users
           WHERE id = $1 AND auth_status = 'active' AND deleted_at IS NULL
           FOR UPDATE`,
          [input.accountUserId],
        );
        if ((account.rowCount ?? 0) !== 1) {
          throw new WorkspaceReplicaError("not_found", "Account not found");
        }
        const replay = await tx.query<
          DeviceRow & { registration_request_sha256: Buffer }
        >(
          `SELECT id, user_id, label, platform, public_key, key_fingerprint,
                  trust_state, key_version, created_at, last_seen_at,
                  revoked_at, registration_request_sha256
           FROM devices
           WHERE user_id = $1 AND registration_idempotency_key = $2
           FOR UPDATE`,
          [input.accountUserId, input.idempotencyKey],
        );
        if (replay.rows[0]) {
          if (
            !replay.rows[0].registration_request_sha256.equals(digest)
          ) {
            throw new WorkspaceReplicaError(
              "idempotency_conflict",
              "Device idempotency key was reused",
            );
          }
          return { device: deviceDocument(replay.rows[0]), replayed: true };
        }
        const keyOwner = await tx.query<DeviceRow>(
          `SELECT id, user_id, label, platform, public_key, key_fingerprint,
                  trust_state, key_version, created_at, last_seen_at, revoked_at
           FROM devices WHERE key_fingerprint = $1 FOR UPDATE`,
          [keyFingerprint],
        );
        if (keyOwner.rows[0]) {
          throw new WorkspaceReplicaError(
            "device_key_conflict",
            "Device key is already registered",
          );
        }
        const id = randomUUID();
        const created = await tx.query<DeviceRow>(
          `INSERT INTO devices (
             id, user_id, label, platform, public_key, key_fingerprint,
             key_algorithm, registration_idempotency_key,
             registration_request_sha256
           ) VALUES ($1, $2, $3, $4, $5, $6, 'ed25519', $7, $8)
           RETURNING id, user_id, label, platform, public_key,
                     key_fingerprint, trust_state, key_version, created_at,
                     last_seen_at, revoked_at`,
          [
            id,
            input.accountUserId,
            input.label,
            input.platform,
            publicKey,
            keyFingerprint,
            input.idempotencyKey,
            digest,
          ],
        );
        return { device: deviceDocument(created.rows[0]!), replayed: false };
      });
    } finally {
      publicKey.fill(0);
    }
  }

  async rotateDeviceKey(input: {
    accountUserId: string;
    newPublicKey: string;
    idempotencyKey: string;
    proof: CloudWorkspaceDeviceProof;
  }) {
    if (!IDEMPOTENCY_PATTERN.test(input.idempotencyKey)) {
      throw new WorkspaceReplicaError("invalid_input", "Device rotation is invalid");
    }
    const newPublicKey = decodePublicKey(input.newPublicKey);
    const nextFingerprint = fingerprint(newPublicKey);
    const payload = {
      newPublicKey: input.newPublicKey,
      idempotencyKey: input.idempotencyKey,
    };
    const digest = requestDigest(payload);
    try {
      return await withSystemTx(this.pool, async (tx) => {
        await tx.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 30))`,
          [`device-key-rotation:${input.proof.deviceId}:${input.idempotencyKey}`],
        );
        const current = await this.consumeDeviceProof(tx, {
          accountUserId: input.accountUserId,
          action: "device.rotate",
          payload,
          proof: input.proof,
        });
        const replay = await tx.query<{
          request_sha256: Buffer;
          to_key_version: string | number;
        }>(
          `SELECT request_sha256, to_key_version
           FROM device_key_rotation_requests
           WHERE device_id = $1 AND idempotency_key = $2
           FOR UPDATE`,
          [current.id, input.idempotencyKey],
        );
        if (replay.rows[0]) {
          if (
            !replay.rows[0].request_sha256.equals(digest) ||
            Number(replay.rows[0].to_key_version) !== Number(current.key_version) ||
            !current.key_fingerprint.equals(nextFingerprint)
          ) {
            throw new WorkspaceReplicaError(
              "idempotency_conflict",
              "Device rotation idempotency key was reused",
            );
          }
          return { device: deviceDocument(current), replayed: true };
        }
        if (current.key_fingerprint.equals(nextFingerprint)) {
          throw new WorkspaceReplicaError(
            "device_key_conflict",
            "New device key must differ from the current key",
          );
        }
        const collision = await tx.query(
          `SELECT 1 FROM devices WHERE key_fingerprint = $1`,
          [nextFingerprint],
        );
        if ((collision.rowCount ?? 0) !== 0) {
          throw new WorkspaceReplicaError(
            "device_key_conflict",
            "Device key is already registered",
          );
        }
        const updated = await tx.query<DeviceRow>(
          `UPDATE devices
           SET public_key = $2, key_fingerprint = $3,
               key_version = key_version + 1, last_seen_at = now()
           WHERE id = $1 AND trust_state = 'trusted'
           RETURNING id, user_id, label, platform, public_key,
                     key_fingerprint, trust_state, key_version, created_at,
                     last_seen_at, revoked_at`,
          [current.id, newPublicKey, nextFingerprint],
        );
        await tx.query(
          `UPDATE workspace_replica_grants SET revoked_at = now()
           WHERE device_id = $1 AND revoked_at IS NULL`,
          [current.id],
        );
        await tx.query(
          `UPDATE workspace_export_grants SET revoked_at = now()
           WHERE device_id = $1 AND revoked_at IS NULL`,
          [current.id],
        );
        const affected = await tx.query<{ id: string; org_id: string }>(
          `UPDATE workspace_replicas
           SET grant_epoch = grant_epoch + 1,
               observed_state = CASE WHEN desired_state = 'active'
                 THEN 'pending' ELSE observed_state END,
               version = version + 1, updated_at = now()
           WHERE device_id = $1 AND desired_state <> 'removed'
           RETURNING id, org_id`,
          [current.id],
        );
        for (const replica of affected.rows) {
          await tx.query(
            `INSERT INTO workspace_replica_events (
               replica_id, org_id, event_type, metadata
             ) VALUES ($1, $2, 'device.key_rotated', $3::jsonb)`,
            [
              replica.id,
              replica.org_id,
              JSON.stringify({ keyVersion: Number(updated.rows[0]!.key_version) }),
            ],
          );
        }
        await tx.query(
          `INSERT INTO device_key_rotation_requests (
             device_id, user_id, idempotency_key, request_sha256,
             from_key_version, to_key_version
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            current.id,
            input.accountUserId,
            input.idempotencyKey,
            digest,
            Number(current.key_version),
            Number(updated.rows[0]!.key_version),
          ],
        );
        return { device: deviceDocument(updated.rows[0]!), replayed: false };
      });
    } finally {
      newPublicKey.fill(0);
    }
  }

  async revokeDevice(input: { accountUserId: string; deviceId: string }) {
    if (
      !UUID_PATTERN.test(input.accountUserId) ||
      !UUID_PATTERN.test(input.deviceId)
    ) {
      throw new WorkspaceReplicaError("invalid_input", "Device identity is invalid");
    }
    return withSystemTx(this.pool, async (tx) => {
      const device = await tx.query<DeviceRow>(
        `SELECT id, user_id, label, platform, public_key, key_fingerprint,
                trust_state, key_version, created_at, last_seen_at, revoked_at
         FROM devices WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [input.deviceId, input.accountUserId],
      );
      if (!device.rows[0]) {
        throw new WorkspaceReplicaError("not_found", "Device not found");
      }
      if (device.rows[0].trust_state !== "revoked") {
        await tx.query(
          `UPDATE devices SET trust_state = 'revoked', revoked_at = now()
           WHERE id = $1`,
          [input.deviceId],
        );
        await tx.query(
          `UPDATE workspace_replica_grants SET revoked_at = now()
           WHERE device_id = $1 AND revoked_at IS NULL`,
          [input.deviceId],
        );
        await tx.query(
          `UPDATE workspace_export_grants SET revoked_at = now()
           WHERE device_id = $1 AND revoked_at IS NULL`,
          [input.deviceId],
        );
        const affected = await tx.query<{ id: string; org_id: string }>(
          `UPDATE workspace_replicas
           SET desired_state = 'paused', observed_state = 'detached',
               grant_epoch = grant_epoch + 1, version = version + 1,
               last_error_code = 'device_revoked', updated_at = now()
           WHERE device_id = $1 AND desired_state <> 'removed'
           RETURNING id, org_id`,
          [input.deviceId],
        );
        for (const replica of affected.rows) {
          await tx.query(
            `INSERT INTO workspace_replica_events (
               replica_id, org_id, event_type, metadata
             ) VALUES ($1, $2, 'device.revoked', '{}')`,
            [replica.id, replica.org_id],
          );
        }
      }
      const current = await tx.query<DeviceRow>(
        `SELECT id, user_id, label, platform, public_key, key_fingerprint,
                trust_state, key_version, created_at, last_seen_at, revoked_at
         FROM devices WHERE id = $1`,
        [input.deviceId],
      );
      return { device: deviceDocument(current.rows[0]!) };
    });
  }

  private async authorizeWorkspace(
    tx: Tx,
    input: {
      organizationId: string;
      workspaceId: string;
      accountUserId: string;
      lock?: boolean;
      access?: "paid" | "data";
    },
  ) {
    const workspace = await tx.query<{
      team_id: string;
      owner_user_id: string;
      authority_epoch: string | number;
      status: string;
      desired_state: string;
      checkpoint_id: string | null;
      checkpoint_revision: string | number | null;
    }>(
      `SELECT workspace.team_id, workspace.owner_user_id,
              workspace.authority_epoch, workspace.status,
              workspace.desired_state,
              head.current_checkpoint_id AS checkpoint_id,
              checkpoint.content_revision AS checkpoint_revision
       FROM cloud_workspaces workspace
       LEFT JOIN workspace_content_heads head
         ON head.workspace_id = workspace.id AND head.org_id = workspace.org_id
       LEFT JOIN workspace_checkpoints checkpoint
         ON checkpoint.id = head.current_checkpoint_id
        AND checkpoint.workspace_id = workspace.id
        AND checkpoint.org_id = workspace.org_id
        AND checkpoint.state = 'durable'
       WHERE workspace.id = $1 AND workspace.org_id = $2
         AND workspace.deleted_at IS NULL
       ${input.lock ? "FOR UPDATE OF workspace" : "FOR SHARE OF workspace"}`,
      [input.workspaceId, input.organizationId],
    );
    const row = workspace.rows[0];
    if (!row) throw new WorkspaceReplicaError("not_found", "Workspace not found");
    if (input.access === "data") {
      await authorizeCloudWorkspaceDataAccess(tx, {
        organizationId: input.organizationId,
        teamId: row.team_id,
        actorUserId: input.accountUserId,
        ownerUserId: row.owner_user_id,
        requireWorkspaceOwner: true,
      });
    } else {
      await authorizeCloudWorkspaceOperation(tx, {
        organizationId: input.organizationId,
        teamId: row.team_id,
        actorUserId: input.accountUserId,
        billingOwnerUserId: row.owner_user_id,
        workosEnabled: this.workosEnabled,
        requireWorkspaceOwner: true,
      });
    }
    return row;
  }

  private async issueGrant(
    tx: Tx,
    input: { replica: ReplicaRow; deviceKeyVersion: number },
  ) {
    const token = `zwr_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(this.now() + 15 * 60_000);
    await tx.query(
      `UPDATE workspace_replica_grants SET revoked_at = now()
       WHERE replica_id = $1 AND revoked_at IS NULL`,
      [input.replica.id],
    );
    await tx.query(
      `INSERT INTO workspace_replica_grants (
         replica_id, workspace_id, org_id, user_id, device_id,
         device_key_version, authority_epoch, workspace_authority_epoch,
         token_sha256, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.replica.id,
        input.replica.workspace_id,
        input.replica.org_id,
        input.replica.user_id,
        input.replica.device_id,
        input.deviceKeyVersion,
        Number(input.replica.grant_epoch),
        Number(input.replica.authority_epoch),
        createHash("sha256").update(token, "utf8").digest(),
        expiresAt,
      ],
    );
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async createReplica(input: {
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    pathLabel: string | null;
    ignorePolicySha256: string;
    idempotencyKey: string;
    proof: CloudWorkspaceDeviceProof;
  }) {
    if (
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.workspaceId) ||
      !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
      !HEX_SHA256_PATTERN.test(input.ignorePolicySha256) ||
      (input.pathLabel !== null &&
        (input.pathLabel.length < 1 ||
          input.pathLabel.length > 120 ||
          input.pathLabel.trim() !== input.pathLabel ||
          /[\u0000-\u001f\u007f]/u.test(input.pathLabel)))
    ) {
      throw new WorkspaceReplicaError("invalid_input", "Replica input is invalid");
    }
    const payload = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      pathLabel: input.pathLabel,
      ignorePolicySha256: input.ignorePolicySha256,
      idempotencyKey: input.idempotencyKey,
    };
    const digest = requestDigest(payload);
    return withSystemTx(this.pool, async (tx) => {
      const device = await this.consumeDeviceProof(tx, {
        accountUserId: input.accountUserId,
        action: "replica.create",
        payload,
        proof: input.proof,
      });
      const authority = await this.authorizeWorkspace(tx, { ...input, lock: true });
      if (
        authority.desired_state !== "running" ||
        !["ready", "busy"].includes(authority.status) ||
        !authority.checkpoint_id ||
        authority.checkpoint_revision === null
      ) {
        throw new WorkspaceReplicaError(
          "not_ready",
          "A durable running cloud workspace is required for local sync",
        );
      }
      const replay = await tx.query<ReplicaRow & { request_sha256: Buffer }>(
        `SELECT ${REPLICA_COLUMNS}, replica.request_sha256
         FROM workspace_replicas replica
         WHERE replica.user_id = $1 AND replica.idempotency_key = $2
         FOR UPDATE`,
        [input.accountUserId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (!replay.rows[0].request_sha256.equals(digest)) {
          throw new WorkspaceReplicaError(
            "idempotency_conflict",
            "Replica idempotency key was reused",
          );
        }
        const grant =
          replay.rows[0].desired_state === "active"
            ? await this.issueGrant(tx, {
                replica: replay.rows[0],
                deviceKeyVersion: Number(device.key_version),
              })
            : null;
        return {
          replica: replicaDocument(replay.rows[0]),
          grant,
          replayed: true,
        };
      }
      const live = await tx.query(
        `SELECT 1 FROM workspace_replicas
         WHERE workspace_id = $1 AND user_id = $2 AND device_id = $3
           AND desired_state <> 'removed'
         FOR UPDATE`,
        [input.workspaceId, input.accountUserId, device.id],
      );
      if ((live.rowCount ?? 0) !== 0) {
        throw new WorkspaceReplicaError(
          "idempotency_conflict",
          "This device already has a local replica",
        );
      }
      const created = await tx.query<ReplicaRow>(
        `INSERT INTO workspace_replicas (
           workspace_id, org_id, user_id, device_id, mode, desired_state,
           observed_state, path_label, authority_epoch, grant_epoch,
           checkpoint_id, manifest_revision, event_cursor,
           ignore_policy_sha256, idempotency_key, request_sha256
         ) VALUES (
           $1, $2, $3, $4, 'receive_only', 'active', 'bootstrapping',
           $5, $6, 1, $7, $8, 0, $9, $10, $11
         ) RETURNING id, workspace_id, org_id, user_id, device_id, mode,
                     desired_state, observed_state, path_label,
                     authority_epoch, grant_epoch, checkpoint_id,
                     manifest_revision, event_cursor, ignore_policy_sha256,
                     client_manifest_sha256, last_applied_at,
                     last_error_code, version, created_at, updated_at,
                     removed_at`,
        [
          input.workspaceId,
          input.organizationId,
          input.accountUserId,
          device.id,
          input.pathLabel,
          Number(authority.authority_epoch),
          authority.checkpoint_id,
          Number(authority.checkpoint_revision),
          Buffer.from(input.ignorePolicySha256, "hex"),
          input.idempotencyKey,
          digest,
        ],
      );
      await tx.query(
        `INSERT INTO workspace_replica_events (
           replica_id, org_id, event_type, metadata
         ) VALUES ($1, $2, 'replica.created', $3::jsonb)`,
        [
          created.rows[0]!.id,
          input.organizationId,
          JSON.stringify({ checkpointId: authority.checkpoint_id }),
        ],
      );
      await audit(
        tx,
        input.organizationId,
        input.accountUserId,
        "cloud_workspace.replica_created",
        {
          workspaceId: input.workspaceId,
          replicaId: created.rows[0]!.id,
          deviceId: device.id,
          mode: "receive_only",
        },
      );
      return {
        replica: replicaDocument(created.rows[0]!),
        grant: await this.issueGrant(tx, {
          replica: created.rows[0]!,
          deviceKeyVersion: Number(device.key_version),
        }),
        replayed: false,
      };
    });
  }

  private async lockReplicaForDevice(
    tx: Tx,
    input: {
      organizationId: string;
      workspaceId: string;
      replicaId: string;
      accountUserId: string;
      proof: CloudWorkspaceDeviceProof;
      action: string;
      payload: unknown;
      access?: "paid" | "data";
    },
  ): Promise<{ replica: ReplicaRow; device: DeviceRow }> {
    const replica = await tx.query<ReplicaRow>(
      `SELECT ${REPLICA_COLUMNS}
       FROM workspace_replicas replica
       WHERE replica.id = $1 AND replica.org_id = $2
         AND replica.workspace_id = $3 AND replica.user_id = $4
         AND replica.device_id = $5
       FOR UPDATE`,
      [
        input.replicaId,
        input.organizationId,
        input.workspaceId,
        input.accountUserId,
        input.proof.deviceId,
      ],
    );
    if (!replica.rows[0]) {
      throw new WorkspaceReplicaError("not_found", "Replica not found");
    }
    const device = await this.consumeDeviceProof(tx, {
      accountUserId: input.accountUserId,
      action: input.action,
      payload: input.payload,
      proof: input.proof,
    });
    await this.authorizeWorkspace(tx, { ...input, lock: true });
    return { replica: replica.rows[0], device };
  }

  async changeReplicaState(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    accountUserId: string;
    operation: "pause" | "resume" | "remove";
    replaceDiverged?: boolean;
    idempotencyKey: string;
    proof: CloudWorkspaceDeviceProof;
  }) {
    if (!IDEMPOTENCY_PATTERN.test(input.idempotencyKey)) {
      throw new WorkspaceReplicaError("invalid_input", "Replica command is invalid");
    }
    const payload = {
      operation: input.operation,
      replaceDiverged: input.replaceDiverged === true,
      idempotencyKey: input.idempotencyKey,
    };
    const digest = requestDigest(payload);
    return withSystemTx(this.pool, async (tx) => {
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 29))`,
        [`workspace-replica-command:${input.replicaId}:${input.idempotencyKey}`],
      );
      const { replica, device } = await this.lockReplicaForDevice(tx, {
        ...input,
        action: `replica.${input.operation}`,
        payload,
        access: input.operation === "resume" ? "paid" : "data",
      });
      const replay = await tx.query<{
        operation: "pause" | "resume" | "remove";
        request_sha256: Buffer;
        response_json: unknown;
      }>(
        `SELECT operation, request_sha256, response_json
         FROM workspace_replica_commands
         WHERE replica_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [replica.id, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (
          replay.rows[0].operation !== input.operation ||
          !replay.rows[0].request_sha256.equals(digest)
        ) {
          throw new WorkspaceReplicaError(
            "idempotency_conflict",
            "Replica command idempotency key was reused",
          );
        }
        const stored = replay.rows[0].response_json as
          | { replica?: ReturnType<typeof replicaDocument> }
          | null;
        if (
          stored !== null &&
          (typeof stored !== "object" ||
            !stored.replica ||
            stored.replica.id !== replica.id ||
            stored.replica.workspaceId !== replica.workspace_id ||
            stored.replica.organizationId !== replica.org_id ||
            stored.replica.deviceId !== replica.device_id)
        ) {
          throw new Error("Replica command response is invalid");
        }
        return {
          replica: stored?.replica ?? replicaDocument(replica),
          grant:
            input.operation === "resume" &&
            replica.desired_state === "active" &&
            !["diverged", "detached", "removed"].includes(replica.observed_state)
              ? await this.issueGrant(tx, {
                  replica,
                  deviceKeyVersion: Number(device.key_version),
                })
              : null,
          replayed: true,
        };
      }
      if (replica.desired_state === "removed") {
        if (input.operation !== "remove") {
          throw new WorkspaceReplicaError("not_ready", "Replica was removed");
        }
        return { replica: replicaDocument(replica), grant: null, replayed: false };
      }
      if (
        input.operation === "resume" &&
        replica.observed_state === "diverged" &&
        input.replaceDiverged !== true
      ) {
        throw new WorkspaceReplicaError(
          "divergence_resolution_required",
          "Preserve local changes before replacing this replica from cloud",
        );
      }
      await tx.query(
        `UPDATE workspace_replica_grants SET revoked_at = now()
         WHERE replica_id = $1 AND revoked_at IS NULL`,
        [replica.id],
      );
      const state =
        input.operation === "pause"
          ? { desired: "paused", observed: "paused", event: "replica.paused" }
          : input.operation === "remove"
            ? { desired: "removed", observed: "removed", event: "replica.removed" }
            : { desired: "active", observed: "syncing", event: "replica.resumed" };
      const authority = await this.authorizeWorkspace(tx, {
        ...input,
        lock: true,
        access: input.operation === "resume" ? "paid" : "data",
      });
      if (
        input.operation === "resume" &&
        (authority.desired_state !== "running" ||
          !["ready", "busy"].includes(authority.status))
      ) {
        throw new WorkspaceReplicaError("not_ready", "Workspace is not running");
      }
      const replaceFromCloud =
        input.operation === "resume" &&
        replica.observed_state === "diverged" &&
        input.replaceDiverged === true;
      if (replaceFromCloud) {
        if (!authority.checkpoint_id || authority.checkpoint_revision === null) {
          throw new WorkspaceReplicaError(
            "not_ready",
            "A current durable checkpoint is required for cloud replacement",
          );
        }
        const retained = await tx.query<{
          minimum_retained_revision: string | number;
        }>(
          `SELECT minimum_retained_revision
           FROM workspace_content_heads
           WHERE workspace_id = $1 AND org_id = $2
           FOR SHARE`,
          [input.workspaceId, input.organizationId],
        );
        if (
          Number(authority.checkpoint_revision) <
          Number(retained.rows[0]?.minimum_retained_revision ?? 0)
        ) {
          throw new WorkspaceReplicaError(
            "not_ready",
            "A newer durable checkpoint is required for cloud replacement",
          );
        }
      }
      const updated = await tx.query<ReplicaRow>(
        `UPDATE workspace_replicas replica
         SET desired_state = $2,
             observed_state = CASE WHEN $5 THEN 'bootstrapping' ELSE $3 END,
             authority_epoch = $4,
             grant_epoch = grant_epoch + 1,
             checkpoint_id = CASE WHEN $5 THEN $6 ELSE checkpoint_id END,
             manifest_revision = CASE WHEN $5 THEN $7 ELSE manifest_revision END,
             event_cursor = CASE WHEN $5 THEN 0 ELSE event_cursor END,
             client_manifest_sha256 = CASE WHEN $5 THEN NULL
                                           ELSE client_manifest_sha256 END,
             version = version + 1,
             last_error_code = NULL,
             removed_at = CASE WHEN $2 = 'removed' THEN now() ELSE NULL END,
             updated_at = now()
         WHERE replica.id = $1
         RETURNING ${REPLICA_COLUMNS}`,
        [
          replica.id,
          state.desired,
          state.observed,
          Number(authority.authority_epoch),
          replaceFromCloud,
          replaceFromCloud ? authority.checkpoint_id : null,
          replaceFromCloud ? Number(authority.checkpoint_revision) : null,
        ],
      );
      await tx.query(
        `INSERT INTO workspace_replica_events (
           replica_id, org_id, event_type, metadata
         ) VALUES ($1, $2, $3, $4::jsonb)`,
        [
          replica.id,
          replica.org_id,
          state.event,
          JSON.stringify({ replaceDiverged: input.replaceDiverged === true }),
        ],
      );
      await audit(tx, replica.org_id, input.accountUserId, `cloud_workspace.${state.event}`, {
        workspaceId: replica.workspace_id,
        replicaId: replica.id,
        deviceId: replica.device_id,
      });
      const current = updated.rows[0]!;
      const response = { replica: replicaDocument(current) };
      await tx.query(
        `INSERT INTO workspace_replica_commands (
           replica_id, org_id, user_id, idempotency_key, operation,
           request_sha256, response_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          replica.id,
          replica.org_id,
          input.accountUserId,
          input.idempotencyKey,
          input.operation,
          digest,
          JSON.stringify(response),
        ],
      );
      return {
        ...response,
        grant:
          input.operation === "resume"
            ? await this.issueGrant(tx, {
                replica: current,
                deviceKeyVersion: Number(device.key_version),
              })
            : null,
        replayed: false,
      };
    });
  }

  async renewGrant(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    accountUserId: string;
    proof: CloudWorkspaceDeviceProof;
  }) {
    const payload = { replicaId: input.replicaId };
    return withSystemTx(this.pool, async (tx) => {
      const { replica, device } = await this.lockReplicaForDevice(tx, {
        ...input,
        action: "replica.grant",
        payload,
      });
      if (
        replica.desired_state !== "active" ||
        ["diverged", "detached", "removed"].includes(replica.observed_state)
      ) {
        throw new WorkspaceReplicaError("not_ready", "Replica is not active");
      }
      return {
        replica: replicaDocument(replica),
        grant: await this.issueGrant(tx, {
          replica,
          deviceKeyVersion: Number(device.key_version),
        }),
      };
    });
  }

  async refreshSnapshot(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    accountUserId: string;
    proof: CloudWorkspaceDeviceProof;
  }) {
    const payload = { replicaId: input.replicaId };
    return withSystemTx(this.pool, async (tx) => {
      const { replica, device } = await this.lockReplicaForDevice(tx, {
        ...input,
        action: "replica.snapshot",
        payload,
      });
      if (replica.desired_state !== "active") {
        throw new WorkspaceReplicaError("not_ready", "Replica is not active");
      }
      const authority = await this.authorizeWorkspace(tx, { ...input, lock: true });
      if (
        authority.desired_state !== "running" ||
        !["ready", "busy"].includes(authority.status) ||
        !authority.checkpoint_id ||
        authority.checkpoint_revision === null
      ) {
        throw new WorkspaceReplicaError(
          "not_ready",
          "A current durable checkpoint is required",
        );
      }
      const retained = await tx.query<{
        minimum_retained_revision: string | number;
      }>(
        `SELECT minimum_retained_revision
         FROM workspace_content_heads
         WHERE workspace_id = $1 AND org_id = $2
         FOR SHARE`,
        [input.workspaceId, input.organizationId],
      );
      if (
        Number(authority.checkpoint_revision) <
        Number(retained.rows[0]?.minimum_retained_revision ?? 0)
      ) {
        throw new WorkspaceReplicaError(
          "not_ready",
          "A newer durable checkpoint is required",
        );
      }
      await tx.query(
        `UPDATE workspace_replica_grants SET revoked_at = now()
         WHERE replica_id = $1 AND revoked_at IS NULL`,
        [replica.id],
      );
      const updated = await tx.query<ReplicaRow>(
        `UPDATE workspace_replicas replica
         SET checkpoint_id = $2, manifest_revision = $3, event_cursor = 0,
             authority_epoch = $4, grant_epoch = grant_epoch + 1,
             observed_state = 'bootstrapping', client_manifest_sha256 = NULL,
             last_error_code = NULL, version = version + 1, updated_at = now()
         WHERE replica.id = $1
         RETURNING ${REPLICA_COLUMNS}`,
        [
          replica.id,
          authority.checkpoint_id,
          Number(authority.checkpoint_revision),
          Number(authority.authority_epoch),
        ],
      );
      const current = updated.rows[0]!;
      await tx.query(
        `INSERT INTO workspace_replica_events (
           replica_id, org_id, event_type, metadata
         ) VALUES ($1, $2, 'replica.snapshot_refreshed', $3::jsonb)`,
        [
          replica.id,
          replica.org_id,
          JSON.stringify({
            checkpointId: authority.checkpoint_id,
            manifestRevision: Number(authority.checkpoint_revision),
          }),
        ],
      );
      return {
        replica: replicaDocument(current),
        grant: await this.issueGrant(tx, {
          replica: current,
          deviceKeyVersion: Number(device.key_version),
        }),
      };
    });
  }

  private async authorizeGrant(
    tx: Tx,
    input: {
      organizationId: string;
      workspaceId: string;
      replicaId: string;
      accountUserId: string;
      grantToken: string;
      action: string;
      payload: unknown;
      proof: CloudWorkspaceDeviceProof;
      allowDiverged?: boolean;
    },
  ): Promise<ReplicaRow> {
    if (
      !/^zwr_[A-Za-z0-9_-]{43}$/.test(input.grantToken) ||
      !UUID_PATTERN.test(input.replicaId)
    ) {
      throw new WorkspaceReplicaError("grant_rejected", "Replica grant is invalid");
    }
    const grant = await tx.query<{
      device_id: string;
      device_key_version: string | number;
      authority_epoch: string | number;
      workspace_authority_epoch: string | number;
    }>(
      `SELECT device_id, device_key_version, authority_epoch,
              workspace_authority_epoch
       FROM workspace_replica_grants
       WHERE replica_id = $1 AND workspace_id = $2 AND org_id = $3
         AND user_id = $4 AND token_sha256 = $5
         AND revoked_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [
        input.replicaId,
        input.workspaceId,
        input.organizationId,
        input.accountUserId,
        createHash("sha256").update(input.grantToken, "utf8").digest(),
      ],
    );
    const row = grant.rows[0];
    if (!row || row.device_id !== input.proof.deviceId) {
      throw new WorkspaceReplicaError("grant_rejected", "Replica grant is invalid");
    }
    const device = await this.consumeDeviceProof(tx, {
      accountUserId: input.accountUserId,
      action: input.action,
      payload: input.payload,
      proof: input.proof,
    });
    if (Number(row.device_key_version) !== Number(device.key_version)) {
      throw new WorkspaceReplicaError("grant_rejected", "Replica grant is stale");
    }
    const replica = await tx.query<ReplicaRow>(
      `SELECT ${REPLICA_COLUMNS}
       FROM workspace_replicas replica
       WHERE replica.id = $1 AND replica.workspace_id = $2
         AND replica.org_id = $3 AND replica.user_id = $4
         AND replica.device_id = $5
       FOR UPDATE`,
      [
        input.replicaId,
        input.workspaceId,
        input.organizationId,
        input.accountUserId,
        device.id,
      ],
    );
    const replicaRow = replica.rows[0];
    if (
      !replicaRow ||
      replicaRow.desired_state !== "active" ||
      (!input.allowDiverged && replicaRow.observed_state === "diverged") ||
      Number(row.authority_epoch) !== Number(replicaRow.grant_epoch) ||
      Number(row.workspace_authority_epoch) !== Number(replicaRow.authority_epoch)
    ) {
      throw new WorkspaceReplicaError("grant_rejected", "Replica grant is stale");
    }
    const authority = await this.authorizeWorkspace(tx, { ...input });
    if (Number(authority.authority_epoch) !== Number(replicaRow.authority_epoch)) {
      throw new WorkspaceReplicaError("grant_rejected", "Replica grant is stale");
    }
    await tx.query(
      `UPDATE workspace_replica_grants SET last_used_at = now()
       WHERE replica_id = $1 AND token_sha256 = $2`,
      [
        replicaRow.id,
        createHash("sha256").update(input.grantToken, "utf8").digest(),
      ],
    );
    return replicaRow;
  }

  async readBootstrap(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    accountUserId: string;
    grantToken: string;
    afterPath: string | null;
    limit: number;
    proof: CloudWorkspaceDeviceProof;
  }) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000 ||
      (input.afterPath !== null && Buffer.byteLength(input.afterPath, "utf8") > 4_096)
    ) {
      throw new WorkspaceReplicaError("invalid_input", "Bootstrap cursor is invalid");
    }
    const payload = { afterPath: input.afterPath, limit: input.limit };
    return withSystemTx(this.pool, async (tx) => {
      const replica = await this.authorizeGrant(tx, {
        ...input,
        action: "replica.bootstrap.read",
        payload,
      });
      if (!replica.checkpoint_id || replica.manifest_revision === null) {
        throw new WorkspaceReplicaError("not_ready", "Replica checkpoint is unavailable");
      }
      const checkpoint = await tx.query<{
        manifest_blob_id: string;
        integrity_sha256: Buffer;
        file_count: number;
        total_bytes: string | number;
        git_base_commit: string | null;
        git_head_ref: string | null;
      }>(
        `SELECT manifest_blob_id, integrity_sha256, file_count, total_bytes,
                git_base_commit, git_head_ref
         FROM workspace_checkpoints
         WHERE id = $1 AND workspace_id = $2 AND org_id = $3
           AND state = 'durable'`,
        [replica.checkpoint_id, input.workspaceId, input.organizationId],
      );
      if (!checkpoint.rows[0]) {
        throw new WorkspaceReplicaError("not_ready", "Replica checkpoint is unavailable");
      }
      const entries = await tx.query<{
        normalized_path: string;
        operation: "upsert" | "delete";
        entry_type: "file" | "symlink" | null;
        mode: number | null;
        blob_id: string | null;
        content_sha256: Buffer | null;
        size_bytes: string | number | null;
      }>(
        `SELECT normalized_path, operation, entry_type, mode, blob_id,
                content_sha256, size_bytes
         FROM workspace_checkpoint_entries
         WHERE checkpoint_id = $1
           AND ($2::text IS NULL OR
                normalized_path COLLATE "C" > ($2::text COLLATE "C"))
         ORDER BY normalized_path COLLATE "C" LIMIT $3`,
        [replica.checkpoint_id, input.afterPath, input.limit + 1],
      );
      const page = entries.rows.slice(0, input.limit);
      return {
        checkpointId: replica.checkpoint_id,
        manifestRevision: Number(replica.manifest_revision),
        manifestBlobId: checkpoint.rows[0].manifest_blob_id,
        integritySha256: checkpoint.rows[0].integrity_sha256.toString("hex"),
        fileCount: checkpoint.rows[0].file_count,
        totalBytes: Number(checkpoint.rows[0].total_bytes),
        gitBaseCommit: checkpoint.rows[0].git_base_commit,
        gitHeadRef: checkpoint.rows[0].git_head_ref,
        entries: page.map((entry) => ({
          path: entry.normalized_path,
          operation: entry.operation,
          entryType: entry.entry_type,
          mode: entry.mode,
          blobId: entry.blob_id,
          contentSha256: entry.content_sha256?.toString("hex") ?? null,
          sizeBytes: entry.size_bytes === null ? null : Number(entry.size_bytes),
        })),
        nextAfterPath:
          entries.rows.length > input.limit
            ? page[page.length - 1]!.normalized_path
            : null,
      };
    });
  }

  async readEvents(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    accountUserId: string;
    grantToken: string;
    afterRevision: number;
    limit: number;
    proof: CloudWorkspaceDeviceProof;
  }) {
    if (
      !Number.isSafeInteger(input.afterRevision) ||
      input.afterRevision < 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200
    ) {
      throw new WorkspaceReplicaError("invalid_input", "Replica cursor is invalid");
    }
    const payload = { afterRevision: input.afterRevision, limit: input.limit };
    return withSystemTx(this.pool, async (tx) => {
      const replica = await this.authorizeGrant(tx, {
        ...input,
        action: "replica.events.read",
        payload,
      });
      if (Number(replica.event_cursor) < Number(replica.manifest_revision ?? 0)) {
        throw new WorkspaceReplicaError(
          "bootstrap_required",
          "Replica checkpoint must be applied first",
        );
      }
      if (input.afterRevision < Number(replica.event_cursor)) {
        throw new WorkspaceReplicaError(
          "cursor_conflict",
          "Replica cursor is behind its last receipt",
        );
      }
      const head = await tx.query<{
        current_revision: string | number;
        minimum_retained_revision: string | number;
      }>(
        `SELECT current_revision, minimum_retained_revision
         FROM workspace_content_heads
         WHERE workspace_id = $1 AND org_id = $2`,
        [input.workspaceId, input.organizationId],
      );
      const currentRevision = Number(head.rows[0]?.current_revision ?? 0);
      const minimumRetainedRevision = Number(
        head.rows[0]?.minimum_retained_revision ?? 0,
      );
      if (input.afterRevision > currentRevision) {
        throw new WorkspaceReplicaError("cursor_conflict", "Replica cursor is ahead");
      }
      if (input.afterRevision < minimumRetainedRevision) {
        return {
          currentRevision,
          minimumRetainedRevision,
          snapshotRequired: true,
          fromRevision: input.afterRevision,
          toRevision: input.afterRevision,
          events: [],
          hasMore: false,
        };
      }
      const pageRevisions = await tx.query<{ revision: string | number }>(
        `SELECT revision
         FROM workspace_content_revisions
         WHERE workspace_id = $1 AND org_id = $2 AND revision > $3
         ORDER BY revision LIMIT $4`,
        [input.workspaceId, input.organizationId, input.afterRevision, input.limit],
      );
      const toRevision =
        pageRevisions.rows.length > 0
          ? Number(pageRevisions.rows[pageRevisions.rows.length - 1]!.revision)
          : input.afterRevision;
      const events = await tx.query<{
        revision: string | number;
        sequence: number;
        normalized_path: string;
        operation: "upsert" | "delete";
        entry_type: "file" | "symlink" | null;
        mode: number | null;
        blob_id: string | null;
        content_sha256: Buffer | null;
        size_bytes: string | number | null;
      }>(
        `SELECT event.revision, event.sequence, event.normalized_path,
                event.operation, event.entry_type, event.mode, event.blob_id,
                event.content_sha256, event.size_bytes
         FROM workspace_file_events event
         WHERE event.workspace_id = $1 AND event.org_id = $2
           AND event.revision > $3 AND event.revision <= $4
         ORDER BY event.revision, event.sequence`,
        [input.workspaceId, input.organizationId, input.afterRevision, toRevision],
      );
      return {
        currentRevision,
        minimumRetainedRevision,
        snapshotRequired: false,
        fromRevision: input.afterRevision,
        toRevision,
        events: events.rows.map((event) => ({
          revision: Number(event.revision),
          sequence: event.sequence,
          path: event.normalized_path,
          operation: event.operation,
          entryType: event.entry_type,
          mode: event.mode,
          blobId: event.blob_id,
          contentSha256: event.content_sha256?.toString("hex") ?? null,
          sizeBytes: event.size_bytes === null ? null : Number(event.size_bytes),
        })),
        hasMore: toRevision < currentRevision,
      };
    });
  }

  async readBlob(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    accountUserId: string;
    grantToken: string;
    blobId: string;
    proof: CloudWorkspaceDeviceProof;
  }): Promise<Buffer> {
    if (!UUID_PATTERN.test(input.blobId)) {
      throw new WorkspaceReplicaError("invalid_input", "Replica blob is invalid");
    }
    const payload = { blobId: input.blobId };
    return withSystemTx(this.pool, async (tx) => {
      const replica = await this.authorizeGrant(tx, {
        ...input,
        action: "replica.blob.read",
        payload,
      });
      const allowed = await tx.query(
        `SELECT 1
         FROM workspace_checkpoint_entries entry
         WHERE entry.checkpoint_id = $1 AND entry.workspace_id = $2
           AND entry.org_id = $3 AND entry.blob_id = $4
         UNION ALL
         SELECT 1
         FROM workspace_file_events event
         WHERE event.workspace_id = $2 AND event.org_id = $3
           AND event.blob_id = $4 AND event.revision > $5
         LIMIT 1`,
        [
          replica.checkpoint_id,
          input.workspaceId,
          input.organizationId,
          input.blobId,
          Number(replica.manifest_revision ?? 0),
        ],
      );
      if ((allowed.rowCount ?? 0) !== 1) {
        throw new WorkspaceReplicaError("not_found", "Replica blob not found");
      }
      // Keep the grant and replica rows locked through the object read. A
      // concurrent pause/revoke/epoch change therefore linearizes either
      // before this authorization or after the bytes have been delivered.
      try {
        return await this.blobs.getSystemInTx(tx, {
          blobId: input.blobId,
          organizationId: input.organizationId,
        });
      } catch {
        throw new WorkspaceReplicaError(
          "blob_unavailable",
          "Replica blob is unavailable",
        );
      }
    });
  }

  async recordReceipt(input: {
    organizationId: string;
    workspaceId: string;
    replicaId: string;
    accountUserId: string;
    grantToken: string;
    fromRevision: number;
    toRevision: number;
    manifestSha256: string;
    outcome: "applied" | "diverged" | "failed";
    errorCode: string | null;
    idempotencyKey: string;
    proof: CloudWorkspaceDeviceProof;
  }) {
    if (
      !Number.isSafeInteger(input.fromRevision) ||
      input.fromRevision < 0 ||
      !Number.isSafeInteger(input.toRevision) ||
      input.toRevision < input.fromRevision ||
      !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
      !HEX_SHA256_PATTERN.test(input.manifestSha256) ||
      ((input.outcome === "applied") !== (input.errorCode === null)) ||
      (input.errorCode !== null && !ERROR_CODE_PATTERN.test(input.errorCode))
    ) {
      throw new WorkspaceReplicaError("invalid_input", "Replica receipt is invalid");
    }
    const payload = {
      fromRevision: input.fromRevision,
      toRevision: input.toRevision,
      manifestSha256: input.manifestSha256,
      outcome: input.outcome,
      errorCode: input.errorCode,
      idempotencyKey: input.idempotencyKey,
    };
    const digest = requestDigest(payload);
    return withSystemTx(this.pool, async (tx) => {
      // Missing-row SELECTs do not serialize in PostgreSQL. Lock the exact
      // replica/key pair so concurrent retries cannot both cross the cursor
      // check, and so a lost response after a diverged receipt can still be
      // replayed after its original grant was intentionally revoked.
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 31))`,
        [`workspace-replica-receipt:${input.replicaId}:${input.idempotencyKey}`],
      );
      const replay = await tx.query<{
        request_sha256: Buffer;
        response_json: unknown;
      }>(
        `SELECT request_sha256, response_json
         FROM workspace_replica_receipts
         WHERE replica_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [input.replicaId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (!replay.rows[0].request_sha256.equals(digest)) {
          throw new WorkspaceReplicaError(
            "idempotency_conflict",
            "Replica receipt idempotency key was reused",
          );
        }
        await this.lockReplicaForDevice(tx, {
          ...input,
          action: "replica.receipt",
          payload,
        });
        const prior = replay.rows[0].response_json as {
          replica: ReturnType<typeof replicaDocument>;
        };
        return { replica: prior.replica, replayed: true as const };
      }
      const replica = await this.authorizeGrant(tx, {
        ...input,
        action: "replica.receipt",
        payload,
        allowDiverged: true,
      });
      const currentCursor = Number(replica.event_cursor);
      const head = await tx.query<{ current_revision: string | number }>(
        `SELECT current_revision FROM workspace_content_heads
         WHERE workspace_id = $1 AND org_id = $2 FOR SHARE`,
        [input.workspaceId, input.organizationId],
      );
      const currentRevision = Number(head.rows[0]?.current_revision ?? 0);
      if (
        input.fromRevision !== currentCursor ||
        input.toRevision > currentRevision ||
        (currentCursor < Number(replica.manifest_revision ?? 0) &&
          input.toRevision !== Number(replica.manifest_revision))
      ) {
        throw new WorkspaceReplicaError(
          "cursor_conflict",
          "Replica receipt does not extend its exact cursor",
        );
      }
      if (input.outcome === "diverged") {
        await tx.query(
          `UPDATE workspace_replica_grants SET revoked_at = now()
           WHERE replica_id = $1 AND revoked_at IS NULL`,
          [replica.id],
        );
      }
      const updated = await tx.query<ReplicaRow>(
        `UPDATE workspace_replicas replica
         SET event_cursor = CASE WHEN $2 = 'applied' THEN $3 ELSE event_cursor END,
             client_manifest_sha256 = $4,
             last_applied_at = CASE WHEN $2 = 'applied' THEN now()
                                    ELSE last_applied_at END,
             observed_state = CASE
               WHEN $2 = 'diverged' THEN 'diverged'
               WHEN $2 = 'failed' THEN 'failed'
               WHEN $3 = $5 THEN 'in_sync'
               ELSE 'syncing' END,
             last_error_code = $6,
             grant_epoch = grant_epoch + CASE WHEN $2 = 'diverged' THEN 1 ELSE 0 END,
             version = version + 1, updated_at = now()
         WHERE replica.id = $1
         RETURNING ${REPLICA_COLUMNS}`,
        [
          replica.id,
          input.outcome,
          input.toRevision,
          Buffer.from(input.manifestSha256, "hex"),
          currentRevision,
          input.errorCode,
        ],
      );
      await tx.query(
        `INSERT INTO workspace_replica_events (
           replica_id, org_id, event_type, metadata
         ) VALUES ($1, $2, $3, $4::jsonb)`,
        [
          replica.id,
          replica.org_id,
          `replica.${input.outcome}`,
          JSON.stringify({
            fromRevision: input.fromRevision,
            toRevision: input.toRevision,
            errorCode: input.errorCode,
          }),
        ],
      );
      const response = {
        replica: replicaDocument(updated.rows[0]!),
        replayed: false,
      };
      await tx.query(
        `INSERT INTO workspace_replica_receipts (
           replica_id, org_id, grant_epoch, workspace_authority_epoch,
           from_revision, to_revision, manifest_sha256, outcome, error_code,
           idempotency_key, request_sha256, response_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
        [
          replica.id,
          replica.org_id,
          Number(replica.grant_epoch),
          Number(replica.authority_epoch),
          input.fromRevision,
          input.toRevision,
          Buffer.from(input.manifestSha256, "hex"),
          input.outcome,
          input.errorCode,
          input.idempotencyKey,
          digest,
          JSON.stringify(response),
        ],
      );
      return response;
    });
  }
}

export function replicaErrorToHttp(error: WorkspaceReplicaError): HttpError {
  const status: 403 | 404 | 409 | 422 =
    error.code === "not_found" ? 404 :
      ["device_proof_rejected", "grant_rejected"].includes(error.code) ? 403 :
        error.code === "invalid_input" ? 422 : 409;
  return new HttpError(status, `workspace_replica_${error.code}`, error.message);
}
