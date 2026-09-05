import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type pg from "pg";

import { audit } from "../audit.js";
import { HttpError, requireOrganizationMembership, requireOrganizationRole } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, type Tx } from "../db.js";
import { authorizeCloudWorkspaceOperation } from "./authorization.js";
import { enqueueWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { cancelCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { sealCloudProviderCredential } from "./provider-connections.js";
import {
  CloudProviderQualificationError,
  DaytonaProviderConnectionQualifier,
} from "./provider-qualification.js";
import {
  cloudWorkspaceSecretValueVerifier,
  filterCloudWorkspaceSettingsByAllowedPaths,
  normalizeCloudWorkspaceSettingsDocument,
  openCloudWorkspaceSecretBinding,
  sealCloudWorkspaceSecretBinding,
  type CloudWorkspaceSettingsDocument,
} from "./settings.js";

function safeVersion(value: string | number, label: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`invalid ${label} version`);
  }
  return version;
}

function same(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function jsonEqual(left: unknown, right: string): boolean {
  return stableJson(left) === stableJson(JSON.parse(right));
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("invalid timestamp");
  return parsed.toISOString();
}

function credentialKey(config: CloudWorkspaceBackendConfig): {
  version: number;
  key: string;
} {
  const versions = Object.keys(config.providerCredentialKeys)
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((left, right) => right - left);
  const version = versions[0];
  const key = version === undefined ? undefined : config.providerCredentialKeys[version];
  if (!version || !key) {
    throw new HttpError(
      503,
      "cloud_provider_credential_storage_not_configured",
      "Delegated cloud provider credentials are not configured",
    );
  }
  return { version, key };
}

function currentSecretKey(config: CloudWorkspaceBackendConfig): {
  version: number;
  key: string;
} {
  const keys =
    config.settingsSecretEncryptionKeys ??
    (config.settingsSecretKeyV1 ? { 1: config.settingsSecretKeyV1 } : {});
  const version =
    config.currentSettingsSecretEncryptionKeyVersion ??
    (config.settingsSecretKeyV1 ? 1 : null);
  const key = version === null ? undefined : keys[version];
  if (!version || !key) {
    throw new HttpError(
      503,
      "cloud_secret_material_not_configured",
      "Cloud workspace secret material is not configured",
    );
  }
  return { version, key };
}

type StoredSecretValue = {
  key_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  verifier_scheme: number;
  value_verifier: Buffer | null;
};

function storedSecretMatches(
  value: string,
  row: StoredSecretValue,
  binding: {
    bindingId: string;
    organizationId: string;
    version: number;
    name: string;
  },
  config: CloudWorkspaceBackendConfig,
): boolean {
  const keys =
    config.settingsSecretEncryptionKeys ??
    (config.settingsSecretKeyV1 ? { 1: config.settingsSecretKeyV1 } : {});
  const key = keys[row.key_version];
  if (!key) {
    throw new HttpError(
      503,
      "cloud_secret_key_version_unavailable",
      "A persisted cloud secret key version is unavailable",
    );
  }
  if (row.verifier_scheme === 1 && row.value_verifier) {
    return same(
      row.value_verifier,
      cloudWorkspaceSecretValueVerifier(value, binding, key),
    );
  }
  const plaintext = openCloudWorkspaceSecretBinding(
    {
      keyVersion: row.key_version,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authTag: row.auth_tag,
      verifierScheme: row.verifier_scheme,
      valueVerifier: row.value_verifier,
    },
    binding,
    keys,
  );
  const expected = Buffer.from(value, "utf8");
  const actual = Buffer.from(plaintext, "utf8");
  try {
    return same(actual, expected);
  } finally {
    actual.fill(0);
    expected.fill(0);
  }
}

type OrganizationAuthority = {
  isPersonal: boolean;
  teamId: string;
};

type WorkspaceAuthority = {
  id: string;
  orgId: string;
  teamId: string;
  ownerUserId: string;
  repositoryId: string;
  currentGeneration: number;
  authorityEpoch: number;
  status: string;
  desiredState: string;
};

async function organizationAuthority(
  tx: Tx,
  input: {
    organizationId: string;
    actorUserId: string;
    workosEnabled: boolean;
    paid: boolean;
  },
): Promise<OrganizationAuthority> {
  await requireOrganizationRole(tx, input.organizationId, input.actorUserId, "admin");
  const row = (
    await tx.query<{ is_personal: boolean; team_id: string }>(
      `SELECT organization.is_personal, team.id AS team_id
       FROM organizations organization
       JOIN teams team
         ON team.org_id = organization.id AND team.is_default
        AND team.deleted_at IS NULL
       JOIN team_members team_member
         ON team_member.team_id = team.id
        AND team_member.org_id = organization.id
        AND team_member.user_id = $2
       WHERE organization.id = $1 AND organization.deleted_at IS NULL
       ORDER BY team.created_at, team.id
       LIMIT 1`,
      [input.organizationId, input.actorUserId],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "not_found", "Organization not found");
  if (input.paid) {
    await authorizeCloudWorkspaceOperation(tx, {
      organizationId: input.organizationId,
      teamId: row.team_id,
      actorUserId: input.actorUserId,
      billingOwnerUserId: input.actorUserId,
      workosEnabled: input.workosEnabled,
      requireWorkspaceOwner: true,
    });
  }
  return { isPersonal: row.is_personal, teamId: row.team_id };
}

async function workspaceAuthority(
  tx: Tx,
  input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    workosEnabled: boolean;
    paid: boolean;
    lock?: boolean;
  },
): Promise<WorkspaceAuthority> {
  await requireOrganizationMembership(tx, input.organizationId, input.actorUserId);
  const row = (
    await tx.query<{
      id: string;
      org_id: string;
      team_id: string;
      owner_user_id: string;
      repository_id: string;
      current_generation: number;
      authority_epoch: string | number;
      status: string;
      desired_state: string;
    }>(
      `SELECT workspace.id, workspace.org_id, workspace.team_id,
              workspace.owner_user_id, workspace.repository_id,
              workspace.current_generation, workspace.authority_epoch,
              workspace.status, workspace.desired_state
       FROM cloud_workspaces workspace
       JOIN cloud_workspace_members member
         ON member.workspace_id = workspace.id
        AND member.org_id = workspace.org_id
        AND member.user_id = $3 AND member.role = 'owner'
       JOIN team_members team_member
         ON team_member.team_id = workspace.team_id
        AND team_member.org_id = workspace.org_id
        AND team_member.user_id = $3
       WHERE workspace.org_id = $1 AND workspace.id = $2
         AND workspace.owner_user_id = $3 AND workspace.single_member_mode
         AND workspace.deleted_at IS NULL
       ${input.lock ? "FOR UPDATE OF workspace" : ""}`,
      [input.organizationId, input.workspaceId, input.actorUserId],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "not_found", "Cloud workspace not found");
  if (input.paid) {
    await authorizeCloudWorkspaceOperation(tx, {
      organizationId: input.organizationId,
      teamId: row.team_id,
      actorUserId: input.actorUserId,
      billingOwnerUserId: row.owner_user_id,
      workosEnabled: input.workosEnabled,
      requireWorkspaceOwner: true,
    });
  }
  return {
    id: row.id,
    orgId: row.org_id,
    teamId: row.team_id,
    ownerUserId: row.owner_user_id,
    repositoryId: row.repository_id,
    currentGeneration: Number(row.current_generation),
    authorityEpoch: safeVersion(row.authority_epoch, "authority epoch"),
    status: row.status,
    desiredState: row.desired_state,
  };
}

async function outbox(
  tx: Tx,
  input: {
    organizationId: string;
    workspaceId?: string;
    eventType: string;
    aggregateKey: string;
    revision: number;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO cloud_workspace_outbox (
       org_id, workspace_id, event_type, aggregate_key,
       aggregate_revision, idempotency_key, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      input.organizationId,
      input.workspaceId ?? null,
      input.eventType,
      input.aggregateKey,
      input.revision,
      input.idempotencyKey,
      JSON.stringify(input.payload),
    ],
  );
}

async function scheduleSecurityStops(
  tx: Tx,
  input: {
    organizationId: string;
    actorUserId: string;
    resourceKind:
      | "provider_connection"
      | "secret_binding"
      | "managed_policy";
    resourceId: string;
    workspaceIds: readonly string[];
  },
): Promise<string[]> {
  const authorityErrorCode =
    input.resourceKind === "managed_policy"
      ? "managed_policy_changed"
      : `${input.resourceKind}_revoked`;
  const authorityErrorMessage =
    input.resourceKind === "managed_policy"
      ? "Managed policy changed; rebuild the workspace generation"
      : "Execution authority was revoked";
  const scheduled: string[] = [];
  for (const workspaceId of [...new Set(input.workspaceIds)].sort()) {
    const selected = (
      await tx.query<{
        current_generation: number;
        desired_state: string;
        status: string;
      }>(
        `SELECT current_generation, desired_state, status
         FROM cloud_workspaces
         WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [workspaceId, input.organizationId],
      )
    ).rows[0];
    if (!selected || selected.desired_state !== "running") continue;
    await cancelCloudWorkspaceGenerationTransition(tx, {
      workspaceId,
      organizationId: input.organizationId,
      reason: "workspace_stop_requested",
    });
    const current = (
      await tx.query<{ current_generation: number }>(
        `SELECT current_generation FROM cloud_workspaces
         WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [workspaceId, input.organizationId],
      )
    ).rows[0];
    if (!current) continue;
    await tx.query(
      `UPDATE cloud_workspace_lifecycle_intents
       SET state = 'superseded', completed_at = now(), updated_at = now(),
           error_code = $3,
           error_message = 'Execution authority was revoked'
       WHERE workspace_id = $1 AND org_id = $2 AND affects_workspace
         AND operation <> 'delete' AND state IN ('queued', 'observing')`,
      [workspaceId, input.organizationId, authorityErrorCode],
    );
    await tx.query(
      `UPDATE workspace_checkpoint_requests request
       SET state = 'cancelled', completed_at = now(),
           error_code = $3
       FROM cloud_workspace_lifecycle_intents intent
       WHERE request.lifecycle_intent_id = intent.id
         AND intent.workspace_id = $1 AND intent.org_id = $2
         AND intent.state = 'superseded'
         AND request.state IN ('queued', 'delivered')`,
      [workspaceId, input.organizationId, authorityErrorCode],
    );
    const intentId = randomUUID();
    const key = `security:${input.resourceKind}:${input.resourceId}:${workspaceId}`;
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          operation: "stop",
          workspaceId,
          generation: current.current_generation,
          resourceKind: input.resourceKind,
          resourceId: input.resourceId,
        }),
      )
      .digest();
    await tx.query(
      `INSERT INTO cloud_workspace_lifecycle_intents (
         id, workspace_id, generation, org_id, requested_by, operation,
         idempotency_key, request_sha256
       ) VALUES ($1, $2, $3, $4, $5, 'stop', $6, $7)
       ON CONFLICT (org_id, idempotency_key) DO NOTHING`,
      [
        intentId,
        workspaceId,
        current.current_generation,
        input.organizationId,
        input.actorUserId,
        key,
        digest,
      ],
    );
    await tx.query(
      `UPDATE cloud_workspaces
       SET desired_state = 'stopped', status = 'stopping',
           authority_epoch = authority_epoch + 1, version = version + 1,
           updated_at = now(), last_error_code = $3,
           last_error_message = $4
       WHERE id = $1 AND org_id = $2 AND desired_state = 'running'`,
      [
        workspaceId,
        input.organizationId,
        authorityErrorCode,
        authorityErrorMessage,
      ],
    );
    scheduled.push(workspaceId);
  }
  return scheduled;
}

export type RepositoryCloudSettings = {
  repositoryId: string;
  scopes: Array<{
    scope: "shared" | "cloud";
    version: number;
    document: unknown;
    sha256: string;
    createdAt: string;
  }>;
};

export class DatabaseCloudWorkspaceManagementService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: CloudWorkspaceBackendConfig,
    private readonly options: {
      workosEnabled: boolean;
      qualifier?: DaytonaProviderConnectionQualifier;
    },
  ) {}

  private qualifier(): DaytonaProviderConnectionQualifier {
    return this.options.qualifier ?? new DaytonaProviderConnectionQualifier();
  }

  async repositorySettings(input: {
    organizationId: string;
    repositoryId: string;
    actorUserId: string;
  }): Promise<RepositoryCloudSettings> {
    return withSystemTx(this.pool, async (tx) => {
      await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const repository = await tx.query(
        `SELECT 1 FROM repositories WHERE id = $1 AND org_id = $2`,
        [input.repositoryId, input.organizationId],
      );
      if ((repository.rowCount ?? 0) !== 1) {
        throw new HttpError(404, "not_found", "Repository not found");
      }
      const rows = await tx.query<{
        scope: "shared" | "cloud";
        current_version: string | number;
        document: unknown;
        sha256: string;
        created_at: Date | string;
      }>(
        `SELECT head.scope, head.current_version, version.document,
                encode(version.document_sha256, 'hex') AS sha256,
                version.created_at
         FROM repository_settings_heads head
         JOIN repository_settings_versions version
           ON version.org_id = head.org_id
          AND version.repository_id = head.repository_id
          AND version.scope = head.scope
          AND version.version = head.current_version
         WHERE head.org_id = $1 AND head.repository_id = $2
         ORDER BY head.scope`,
        [input.organizationId, input.repositoryId],
      );
      return {
        repositoryId: input.repositoryId,
        scopes: rows.rows.map((row) => ({
          scope: row.scope,
          version: safeVersion(row.current_version, "repository settings"),
          document: row.document,
          sha256: row.sha256,
          createdAt: iso(row.created_at)!,
        })),
      };
    });
  }

  async putRepositorySettings(input: {
    organizationId: string;
    repositoryId: string;
    actorUserId: string;
    scope: "shared" | "cloud";
    expectedVersion: number;
    document: unknown;
  }): Promise<{ version: number; sha256: string; replayed: boolean }> {
    let normalized;
    try {
      normalized = normalizeCloudWorkspaceSettingsDocument(input.document);
    } catch {
      throw new HttpError(422, "cloud_settings_invalid", "Cloud settings document is invalid");
    }
    return withSystemTx(this.pool, async (tx) => {
      await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const repository = await tx.query(
        `SELECT 1 FROM repositories WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [input.repositoryId, input.organizationId],
      );
      if ((repository.rowCount ?? 0) !== 1) {
        throw new HttpError(404, "not_found", "Repository not found");
      }
      const current = (
        await tx.query<{
          current_version: string | number;
          document: unknown;
          sha256: string;
        }>(
          `SELECT head.current_version, version.document,
                  encode(version.document_sha256, 'hex') AS sha256
           FROM repository_settings_heads head
           JOIN repository_settings_versions version
             ON version.org_id = head.org_id
            AND version.repository_id = head.repository_id
            AND version.scope = head.scope
            AND version.version = head.current_version
           WHERE head.org_id = $1 AND head.repository_id = $2
             AND head.scope = $3::cloud_settings_scope
           FOR UPDATE OF head`,
          [input.organizationId, input.repositoryId, input.scope],
        )
      ).rows[0];
      const currentVersion = current
        ? safeVersion(current.current_version, "repository settings")
        : 0;
      if (currentVersion !== input.expectedVersion) {
        if (current && jsonEqual(current.document, normalized.canonicalJson)) {
          return { version: currentVersion, sha256: current.sha256, replayed: true };
        }
        throw new HttpError(
          409,
          "cloud_settings_version_conflict",
          "Cloud settings changed; reload before saving",
          { currentVersion },
        );
      }
      if (current && jsonEqual(current.document, normalized.canonicalJson)) {
        return { version: currentVersion, sha256: current.sha256, replayed: true };
      }
      const version = currentVersion + 1;
      const inserted = await tx.query<{ sha256: string }>(
        `INSERT INTO repository_settings_versions (
           org_id, repository_id, scope, version, schema_version,
           document, created_by
         ) VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6)
         RETURNING encode(document_sha256, 'hex') AS sha256`,
        [
          input.organizationId,
          input.repositoryId,
          input.scope,
          version,
          normalized.canonicalJson,
          input.actorUserId,
        ],
      );
      await tx.query(
        `INSERT INTO repository_settings_heads (
           org_id, repository_id, scope, current_version
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, repository_id, scope) DO UPDATE
         SET current_version = EXCLUDED.current_version, updated_at = now()`,
        [input.organizationId, input.repositoryId, input.scope, version],
      );
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.repository_settings_updated", {
        repositoryId: input.repositoryId,
        scope: input.scope,
        version,
        sha256: inserted.rows[0]!.sha256,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_settings.repository_updated",
        aggregateKey: `repository-settings:${input.repositoryId}:${input.scope}`,
        revision: version,
        idempotencyKey: `repository-settings:${input.repositoryId}:${input.scope}:${version}`,
        payload: { repositoryId: input.repositoryId, scope: input.scope, version },
      });
      return { version, sha256: inserted.rows[0]!.sha256, replayed: false };
    });
  }

  async listEnvironmentProfiles(input: {
    organizationId: string;
    actorUserId: string;
  }): Promise<{ profiles: unknown[] }> {
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const rows = await tx.query<{
        id: string;
        owner_kind: "user" | "organization";
        name: string;
        placement: "local" | "cloud" | "both";
        is_default: boolean;
        current_version: string | number;
        document: unknown;
        sha256: string;
        created_at: Date | string;
        updated_at: Date | string;
      }>(
        `SELECT profile.id, profile.owner_kind, profile.name,
                profile.placement, profile.is_default, profile.current_version,
                version.document,
                encode(version.document_sha256, 'hex') AS sha256,
                profile.created_at, profile.updated_at
         FROM environment_profiles profile
         JOIN environment_profile_versions version
           ON version.profile_id = profile.id
          AND version.org_id = profile.org_id
          AND version.version = profile.current_version
         WHERE profile.org_id = $1 AND profile.deleted_at IS NULL
           AND profile.owner_kind = $2::cloud_profile_owner
           AND profile.owner_user_id IS NOT DISTINCT FROM $3::uuid
         ORDER BY profile.is_default DESC, lower(profile.name), profile.id`,
        [
          input.organizationId,
          authority.isPersonal ? "user" : "organization",
          authority.isPersonal ? input.actorUserId : null,
        ],
      );
      return {
        profiles: rows.rows.map((row) => ({
          id: row.id,
          ownerKind: row.owner_kind,
          name: row.name,
          placement: row.placement,
          isDefault: row.is_default,
          version: safeVersion(row.current_version, "environment profile"),
          document: row.document,
          sha256: row.sha256,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        })),
      };
    });
  }

  async createEnvironmentProfile(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
    name: string;
    placement: "local" | "cloud" | "both";
    isDefault: boolean;
    document: unknown;
  }): Promise<{ profile: unknown; replayed: boolean }> {
    let normalized;
    try {
      normalized = normalizeCloudWorkspaceSettingsDocument(input.document);
    } catch {
      throw new HttpError(422, "cloud_settings_invalid", "Environment profile is invalid");
    }
    if (
      input.placement === "local" &&
      (normalized.document.secretRefs || normalized.document.setupCommands)
    ) {
      throw new HttpError(
        422,
        "cloud_profile_local_material_invalid",
        "Local-only profiles cannot reference server-held secrets or cloud setup commands",
      );
    }
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const ownerKind = authority.isPersonal ? "user" : "organization";
      const ownerUserId = authority.isPersonal ? input.actorUserId : null;
      const existing = (
        await tx.query<{
          org_id: string;
          owner_kind: string;
          owner_user_id: string | null;
          name: string;
          placement: string;
          is_default: boolean;
          current_version: string | number;
          document: unknown;
          sha256: string;
        }>(
          `SELECT profile.org_id, profile.owner_kind, profile.owner_user_id,
                  profile.name, profile.placement, profile.is_default,
                  profile.current_version, version.document,
                  encode(version.document_sha256, 'hex') AS sha256
           FROM environment_profiles profile
           JOIN environment_profile_versions version
             ON version.profile_id = profile.id
            AND version.org_id = profile.org_id
            AND version.version = profile.current_version
           WHERE profile.id = $1 FOR UPDATE OF profile`,
          [input.id],
        )
      ).rows[0];
      if (existing) {
        const exact =
          existing.org_id === input.organizationId &&
          existing.owner_kind === ownerKind &&
          existing.owner_user_id === ownerUserId &&
          existing.name === input.name &&
          existing.placement === input.placement &&
          existing.is_default === input.isDefault &&
          jsonEqual(existing.document, normalized.canonicalJson);
        if (!exact) {
          throw new HttpError(409, "cloud_profile_identity_conflict", "Environment profile identity is already in use");
        }
        return {
          profile: {
            id: input.id,
            ownerKind,
            name: input.name,
            placement: input.placement,
            isDefault: input.isDefault,
            version: safeVersion(existing.current_version, "environment profile"),
            document: existing.document,
            sha256: existing.sha256,
          },
          replayed: true,
        };
      }
      if (input.isDefault) {
        await tx.query(
          `UPDATE environment_profiles SET is_default = false, updated_at = now()
           WHERE org_id = $1 AND owner_kind = $2::cloud_profile_owner
             AND owner_user_id IS NOT DISTINCT FROM $3::uuid
             AND (
               $4 = 'both'
               OR ($4 = 'cloud' AND placement IN ('cloud', 'both'))
               OR ($4 = 'local' AND placement IN ('local', 'both'))
             )
             AND is_default AND deleted_at IS NULL`,
          [input.organizationId, ownerKind, ownerUserId, input.placement],
        );
      }
      await tx.query(
        `INSERT INTO environment_profiles (
           id, org_id, owner_kind, owner_user_id, name, placement,
           is_default, current_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
        [
          input.id,
          input.organizationId,
          ownerKind,
          ownerUserId,
          input.name,
          input.placement,
          input.isDefault,
        ],
      );
      const inserted = await tx.query<{ sha256: string }>(
        `INSERT INTO environment_profile_versions (
           profile_id, org_id, version, schema_version, document, created_by
         ) VALUES ($1, $2, 1, 1, $3::jsonb, $4)
         RETURNING encode(document_sha256, 'hex') AS sha256`,
        [input.id, input.organizationId, normalized.canonicalJson, input.actorUserId],
      );
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.environment_profile_created", {
        profileId: input.id,
        ownerKind,
        placement: input.placement,
        isDefault: input.isDefault,
        version: 1,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_settings.environment_profile_created",
        aggregateKey: `environment-profile:${input.id}`,
        revision: 1,
        idempotencyKey: `environment-profile:${input.id}:1`,
        payload: { profileId: input.id, ownerKind, placement: input.placement, version: 1 },
      });
      return {
        profile: {
          id: input.id,
          ownerKind,
          name: input.name,
          placement: input.placement,
          isDefault: input.isDefault,
          version: 1,
          document: normalized.document,
          sha256: inserted.rows[0]!.sha256,
        },
        replayed: false,
      };
    });
  }

  async updateEnvironmentProfile(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
    expectedVersion: number;
    name?: string;
    placement?: "local" | "cloud" | "both";
    isDefault?: boolean;
    document?: unknown;
  }): Promise<{ profile: unknown; replayed: boolean }> {
    let normalized:
      | ReturnType<typeof normalizeCloudWorkspaceSettingsDocument>
      | undefined;
    if (input.document !== undefined) {
      try {
        normalized = normalizeCloudWorkspaceSettingsDocument(input.document);
      } catch {
        throw new HttpError(422, "cloud_settings_invalid", "Environment profile is invalid");
      }
    }
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const ownerKind = authority.isPersonal ? "user" : "organization";
      const ownerUserId = authority.isPersonal ? input.actorUserId : null;
      const row = (
        await tx.query<{
          name: string;
          placement: "local" | "cloud" | "both";
          is_default: boolean;
          current_version: string | number;
          document: unknown;
          sha256: string;
        }>(
          `SELECT profile.name, profile.placement, profile.is_default,
                  profile.current_version, version.document,
                  encode(version.document_sha256, 'hex') AS sha256
           FROM environment_profiles profile
           JOIN environment_profile_versions version
             ON version.profile_id = profile.id
            AND version.org_id = profile.org_id
            AND version.version = profile.current_version
           WHERE profile.id = $1 AND profile.org_id = $2
             AND profile.owner_kind = $3::cloud_profile_owner
             AND profile.owner_user_id IS NOT DISTINCT FROM $4::uuid
             AND profile.deleted_at IS NULL
           FOR UPDATE OF profile`,
          [input.id, input.organizationId, ownerKind, ownerUserId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "not_found", "Environment profile not found");
      const currentVersion = safeVersion(row.current_version, "environment profile");
      const name = input.name ?? row.name;
      const placement = input.placement ?? row.placement;
      const isDefault = input.isDefault ?? row.is_default;
      const document = normalized?.canonicalJson ?? JSON.stringify(row.document);
      if (
        placement === "local" &&
        ((normalized?.document ?? (row.document as CloudWorkspaceSettingsDocument)).secretRefs ||
          (normalized?.document ?? (row.document as CloudWorkspaceSettingsDocument)).setupCommands)
      ) {
        throw new HttpError(
          422,
          "cloud_profile_local_material_invalid",
          "Local-only profiles cannot reference server-held secrets or cloud setup commands",
        );
      }
      const exact =
        name === row.name &&
        placement === row.placement &&
        isDefault === row.is_default &&
        jsonEqual(row.document, document);
      if (currentVersion !== input.expectedVersion) {
        if (exact) {
          return {
            profile: {
              id: input.id,
              ownerKind,
              name,
              placement,
              isDefault,
              version: currentVersion,
              document: row.document,
              sha256: row.sha256,
            },
            replayed: true,
          };
        }
        throw new HttpError(
          409,
          "cloud_profile_version_conflict",
          "Environment profile changed; reload before saving",
          { currentVersion },
        );
      }
      if (exact) {
        return {
          profile: {
            id: input.id,
            ownerKind,
            name,
            placement,
            isDefault,
            version: currentVersion,
            document: row.document,
            sha256: row.sha256,
          },
          replayed: true,
        };
      }
      if (isDefault) {
        await tx.query(
          `UPDATE environment_profiles SET is_default = false, updated_at = now()
           WHERE org_id = $1 AND owner_kind = $2::cloud_profile_owner
             AND owner_user_id IS NOT DISTINCT FROM $3::uuid
             AND (
               $4 = 'both'
               OR ($4 = 'cloud' AND placement IN ('cloud', 'both'))
               OR ($4 = 'local' AND placement IN ('local', 'both'))
             )
             AND id <> $5
             AND is_default AND deleted_at IS NULL`,
          [input.organizationId, ownerKind, ownerUserId, placement, input.id],
        );
      }
      const version = currentVersion + 1;
      const inserted = await tx.query<{ sha256: string; document: unknown }>(
        `INSERT INTO environment_profile_versions (
           profile_id, org_id, version, schema_version, document, created_by
         ) VALUES ($1, $2, $3, 1, $4::jsonb, $5)
         RETURNING document, encode(document_sha256, 'hex') AS sha256`,
        [input.id, input.organizationId, version, document, input.actorUserId],
      );
      await tx.query(
        `UPDATE environment_profiles
         SET name = $3, placement = $4, is_default = $5,
             current_version = $6, updated_at = now()
         WHERE id = $1 AND org_id = $2`,
        [input.id, input.organizationId, name, placement, isDefault, version],
      );
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.environment_profile_updated", {
        profileId: input.id,
        ownerKind,
        placement,
        isDefault,
        version,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_settings.environment_profile_updated",
        aggregateKey: `environment-profile:${input.id}`,
        revision: version,
        idempotencyKey: `environment-profile:${input.id}:${version}`,
        payload: { profileId: input.id, ownerKind, placement, version },
      });
      return {
        profile: {
          id: input.id,
          ownerKind,
          name,
          placement,
          isDefault,
          version,
          document: inserted.rows[0]!.document,
          sha256: inserted.rows[0]!.sha256,
        },
        replayed: false,
      };
    });
  }

  async deleteEnvironmentProfile(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
    expectedVersion: number;
  }): Promise<{ id: string; deleted: true; replayed: boolean }> {
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const ownerKind = authority.isPersonal ? "user" : "organization";
      const ownerUserId = authority.isPersonal ? input.actorUserId : null;
      const row = (
        await tx.query<{
          current_version: string | number;
          deleted_at: Date | string | null;
        }>(
          `SELECT current_version, deleted_at
           FROM environment_profiles
           WHERE id = $1 AND org_id = $2
             AND owner_kind = $3::cloud_profile_owner
             AND owner_user_id IS NOT DISTINCT FROM $4::uuid
           FOR UPDATE`,
          [input.id, input.organizationId, ownerKind, ownerUserId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "not_found", "Environment profile not found");
      const currentVersion = safeVersion(row.current_version, "environment profile");
      if (row.deleted_at) return { id: input.id, deleted: true, replayed: true };
      if (currentVersion !== input.expectedVersion) {
        throw new HttpError(
          409,
          "cloud_profile_version_conflict",
          "Environment profile changed; reload before deleting",
          { currentVersion },
        );
      }
      await tx.query(
        `UPDATE environment_profiles
         SET deleted_at = now(), is_default = false, updated_at = now()
         WHERE id = $1`,
        [input.id],
      );
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.environment_profile_deleted", {
        profileId: input.id,
        version: currentVersion,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_settings.environment_profile_deleted",
        aggregateKey: `environment-profile-deletion:${input.id}`,
        revision: currentVersion,
        idempotencyKey: `environment-profile:${input.id}:deleted:${currentVersion}`,
        payload: { profileId: input.id, version: currentVersion },
      });
      return { id: input.id, deleted: true, replayed: false };
    });
  }

  async organizationManagedPolicy(input: {
    organizationId: string;
    actorUserId: string;
  }): Promise<{ policy: Record<string, unknown> | null }> {
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      if (authority.isPersonal) {
        throw new HttpError(404, "not_found", "Organization cloud policy not found");
      }
      const row = (
        await tx.query<{
          current_version: string | number;
          document: unknown;
          sha256: string;
          created_at: Date | string;
        }>(
          `SELECT head.current_version, version.document,
                  encode(version.document_sha256, 'hex') AS sha256,
                  version.created_at
           FROM organization_cloud_policy_heads head
           JOIN organization_cloud_policy_versions version
             ON version.org_id = head.org_id
            AND version.version = head.current_version
           WHERE head.org_id = $1`,
          [input.organizationId],
        )
      ).rows[0];
      return {
        policy: row
          ? {
              version: safeVersion(row.current_version, "managed policy"),
              document: row.document,
              sha256: row.sha256,
              createdAt: iso(row.created_at),
            }
          : null,
      };
    });
  }

  async putOrganizationManagedPolicy(input: {
    organizationId: string;
    actorUserId: string;
    expectedVersion: number;
    document: unknown;
  }): Promise<{
    policy: Record<string, unknown>;
    stoppedWorkspaceIds: string[];
    replayed: boolean;
  }> {
    let normalized;
    try {
      normalized = normalizeCloudWorkspaceSettingsDocument(input.document);
    } catch {
      throw new HttpError(422, "cloud_settings_invalid", "Organization cloud policy is invalid");
    }
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      if (authority.isPersonal) {
        throw new HttpError(404, "not_found", "Organization cloud policy not found");
      }
      await requireOrganizationRole(tx, input.organizationId, input.actorUserId, "owner");
      // Workspace creation/replacement takes the same organization lock before
      // resolving settings. This prevents a generation from pinning the old
      // head after the retirement trigger has already scanned it.
      await tx.query(
        `SELECT 1 FROM organizations
         WHERE id = $1 AND deleted_at IS NULL
         FOR UPDATE`,
        [input.organizationId],
      );
      const current = (
        await tx.query<{
          current_version: string | number;
          document: unknown;
          sha256: string;
        }>(
          `SELECT head.current_version, version.document,
                  encode(version.document_sha256, 'hex') AS sha256
           FROM organization_cloud_policy_heads head
           JOIN organization_cloud_policy_versions version
             ON version.org_id = head.org_id
            AND version.version = head.current_version
           WHERE head.org_id = $1 FOR UPDATE OF head`,
          [input.organizationId],
        )
      ).rows[0];
      const currentVersion = current
        ? safeVersion(current.current_version, "managed policy")
        : 0;
      if (currentVersion !== input.expectedVersion) {
        if (current && jsonEqual(current.document, normalized.canonicalJson)) {
          return {
            policy: {
              version: currentVersion,
              document: current.document,
              sha256: current.sha256,
            },
            stoppedWorkspaceIds: [],
            replayed: true,
          };
        }
        throw new HttpError(
          409,
          "cloud_policy_version_conflict",
          "Organization cloud policy changed; reload before saving",
          { currentVersion },
        );
      }
      if (current && jsonEqual(current.document, normalized.canonicalJson)) {
        return {
          policy: {
            version: currentVersion,
            document: current.document,
            sha256: current.sha256,
          },
          stoppedWorkspaceIds: [],
          replayed: true,
        };
      }
      const version = currentVersion + 1;
      const inserted = await tx.query<{ document: unknown; sha256: string }>(
        `INSERT INTO organization_cloud_policy_versions (
           org_id, version, schema_version, document, created_by
         ) VALUES ($1, $2, 1, $3::jsonb, $4)
         RETURNING document, encode(document_sha256, 'hex') AS sha256`,
        [input.organizationId, version, normalized.canonicalJson, input.actorUserId],
      );
      const affected = await tx.query<{ workspace_id: string }>(
        `SELECT workspace.id AS workspace_id
         FROM cloud_workspaces workspace
         JOIN workspace_settings_versions settings
           ON settings.workspace_id = workspace.id
          AND settings.generation = workspace.current_generation
          AND settings.org_id = workspace.org_id
         WHERE workspace.org_id = $1 AND workspace.deleted_at IS NULL
           AND workspace.desired_state = 'running'
           AND settings.managed_policy_version IS DISTINCT FROM $2::bigint
         ORDER BY workspace.id`,
        [input.organizationId, version],
      );
      const stoppedWorkspaceIds = await scheduleSecurityStops(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        resourceKind: "managed_policy",
        resourceId: String(version),
        workspaceIds: affected.rows.map((row) => row.workspace_id),
      });
      await tx.query(
        `INSERT INTO organization_cloud_policy_heads (org_id, current_version)
         VALUES ($1, $2)
         ON CONFLICT (org_id) DO UPDATE
         SET current_version = EXCLUDED.current_version, updated_at = now()`,
        [input.organizationId, version],
      );
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.organization_policy_updated", {
        version,
        sha256: inserted.rows[0]!.sha256,
        stoppedWorkspaceIds,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_settings.organization_policy_updated",
        aggregateKey: `organization-cloud-policy:${input.organizationId}`,
        revision: version,
        idempotencyKey: `organization-cloud-policy:${input.organizationId}:${version}`,
        payload: { organizationId: input.organizationId, version },
      });
      return {
        policy: {
          version,
          document: inserted.rows[0]!.document,
          sha256: inserted.rows[0]!.sha256,
        },
        stoppedWorkspaceIds,
        replayed: false,
      };
    });
  }

  async listPersonalProfileConsents(input: {
    organizationId: string;
    actorUserId: string;
  }): Promise<{ consents: unknown[] }> {
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      if (authority.isPersonal) {
        throw new HttpError(404, "not_found", "Profile inheritance is not available");
      }
      const rows = await tx.query<{
        id: string;
        personal_profile_id: string;
        personal_profile_version: string | number;
        allowed_paths: unknown;
        state: string;
        consented_at: Date | string;
        expires_at: Date | string | null;
        revoked_at: Date | string | null;
      }>(
        `SELECT id, personal_profile_id, personal_profile_version,
                allowed_paths, state, consented_at, expires_at, revoked_at
         FROM personal_profile_inheritance_consents
         WHERE org_id = $1 AND user_id = $2
         ORDER BY consented_at DESC, id`,
        [input.organizationId, input.actorUserId],
      );
      return {
        consents: rows.rows.map((row) => ({
          id: row.id,
          personalProfileId: row.personal_profile_id,
          personalProfileVersion: safeVersion(row.personal_profile_version, "profile consent"),
          allowedPaths: row.allowed_paths,
          state: row.state,
          consentedAt: iso(row.consented_at),
          expiresAt: iso(row.expires_at),
          revokedAt: iso(row.revoked_at),
        })),
      };
    });
  }

  async createPersonalProfileConsent(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
    personalProfileId: string;
    personalProfileVersion: number;
    allowedPaths: string[];
    expiresAt: string | null;
  }): Promise<{ consent: Record<string, unknown>; replayed: boolean }> {
    const paths = [...new Set(input.allowedPaths)].sort();
    if (paths.length < 1 || paths.length !== input.allowedPaths.length) {
      throw new HttpError(422, "cloud_profile_consent_invalid", "Inheritance paths must be unique");
    }
    const expiry = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiry && (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now())) {
      throw new HttpError(422, "cloud_profile_consent_invalid", "Inheritance consent expiry must be in the future");
    }
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      if (authority.isPersonal) {
        throw new HttpError(404, "not_found", "Profile inheritance is not available");
      }
      const profile = (
        await tx.query<{ document: unknown }>(
          `SELECT version.document
           FROM environment_profiles profile
           JOIN organizations personal_org
             ON personal_org.id = profile.org_id
            AND personal_org.is_personal AND personal_org.deleted_at IS NULL
           JOIN environment_profile_versions version
             ON version.profile_id = profile.id
            AND version.org_id = profile.org_id
           WHERE profile.id = $1 AND profile.owner_kind = 'user'
             AND profile.owner_user_id = $2
             AND profile.placement IN ('cloud', 'both')
             AND profile.deleted_at IS NULL AND version.version = $3`,
          [input.personalProfileId, input.actorUserId, input.personalProfileVersion],
        )
      ).rows[0];
      if (!profile) {
        throw new HttpError(404, "not_found", "Personal environment profile not found");
      }
      try {
        filterCloudWorkspaceSettingsByAllowedPaths(profile.document, paths);
      } catch {
        throw new HttpError(422, "cloud_profile_consent_invalid", "Inheritance paths are invalid");
      }
      const existing = (
        await tx.query<{
          org_id: string;
          user_id: string;
          personal_profile_id: string;
          personal_profile_version: string | number;
          allowed_paths: unknown;
          state: string;
          expires_at: Date | string | null;
        }>(
          `SELECT org_id, user_id, personal_profile_id,
                  personal_profile_version, allowed_paths, state, expires_at
           FROM personal_profile_inheritance_consents
           WHERE id = $1 FOR UPDATE`,
          [input.id],
        )
      ).rows[0];
      if (existing) {
        const exact =
          existing.org_id === input.organizationId &&
          existing.user_id === input.actorUserId &&
          existing.personal_profile_id === input.personalProfileId &&
          safeVersion(existing.personal_profile_version, "profile consent") === input.personalProfileVersion &&
          stableJson(existing.allowed_paths) === stableJson(paths) &&
          existing.state === "active" &&
          iso(existing.expires_at) === (expiry ? expiry.toISOString() : null);
        if (!exact) {
          throw new HttpError(409, "cloud_profile_consent_conflict", "Inheritance consent identity is already in use");
        }
        return {
          consent: {
            id: input.id,
            personalProfileId: input.personalProfileId,
            personalProfileVersion: input.personalProfileVersion,
            allowedPaths: paths,
            state: "active",
            expiresAt: expiry?.toISOString() ?? null,
          },
          replayed: true,
        };
      }
      const active = await tx.query<{
        count: string | number;
        same_profile: boolean;
      }>(
        `SELECT count(*) AS count,
                coalesce(bool_or(personal_profile_id = $3), false) AS same_profile
         FROM personal_profile_inheritance_consents
         WHERE org_id = $1 AND user_id = $2 AND state = 'active'
           AND (expires_at IS NULL OR expires_at > now())`,
        [input.organizationId, input.actorUserId, input.personalProfileId],
      );
      const activeCount = safeVersion(active.rows[0]?.count ?? 0, "profile consent count");
      if (active.rows[0]?.same_profile) {
        throw new HttpError(
          409,
          "cloud_profile_consent_exists",
          "Revoke the active consent for this profile before consenting to another version",
        );
      }
      if (activeCount >= 8) {
        throw new HttpError(
          409,
          "cloud_profile_consent_limit",
          "At most eight personal profiles may be inherited by an Organization",
        );
      }
      try {
        await tx.query(
          `INSERT INTO personal_profile_inheritance_consents (
             id, org_id, user_id, personal_profile_id,
             personal_profile_version, allowed_paths, state, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active', $7)`,
          [
            input.id,
            input.organizationId,
            input.actorUserId,
            input.personalProfileId,
            input.personalProfileVersion,
            JSON.stringify(paths),
            expiry,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new HttpError(409, "cloud_profile_consent_exists", "This profile version already has an inheritance consent");
        }
        throw error;
      }
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.personal_profile_consent_created", {
        consentId: input.id,
        personalProfileId: input.personalProfileId,
        personalProfileVersion: input.personalProfileVersion,
        allowedPaths: paths,
        expiresAt: expiry?.toISOString() ?? null,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_settings.personal_profile_consent_created",
        aggregateKey: `personal-profile-consent:${input.id}`,
        revision: 1,
        idempotencyKey: `personal-profile-consent:${input.id}:1`,
        payload: { consentId: input.id, personalProfileId: input.personalProfileId, personalProfileVersion: input.personalProfileVersion },
      });
      return {
        consent: {
          id: input.id,
          personalProfileId: input.personalProfileId,
          personalProfileVersion: input.personalProfileVersion,
          allowedPaths: paths,
          state: "active",
          expiresAt: expiry?.toISOString() ?? null,
        },
        replayed: false,
      };
    });
  }

  async revokePersonalProfileConsent(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
  }): Promise<{ consent: { id: string; state: "revoked" }; replayed: boolean }> {
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      if (authority.isPersonal) {
        throw new HttpError(404, "not_found", "Profile inheritance is not available");
      }
      const row = (
        await tx.query<{ state: string }>(
          `SELECT state FROM personal_profile_inheritance_consents
           WHERE id = $1 AND org_id = $2 AND user_id = $3 FOR UPDATE`,
          [input.id, input.organizationId, input.actorUserId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "not_found", "Inheritance consent not found");
      if (row.state === "revoked") {
        return { consent: { id: input.id, state: "revoked" }, replayed: true };
      }
      await tx.query(
        `UPDATE personal_profile_inheritance_consents
         SET state = 'revoked', revoked_at = now()
         WHERE id = $1`,
        [input.id],
      );
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.personal_profile_consent_revoked", {
        consentId: input.id,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_settings.personal_profile_consent_revoked",
        aggregateKey: `personal-profile-consent:${input.id}`,
        revision: 2,
        idempotencyKey: `personal-profile-consent:${input.id}:2`,
        payload: { consentId: input.id },
      });
      return { consent: { id: input.id, state: "revoked" }, replayed: false };
    });
  }

  async listSecretBindings(input: {
    organizationId: string;
    actorUserId: string;
  }): Promise<{ bindings: unknown[] }> {
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const ownerKind = authority.isPersonal ? "user" : "organization";
      const ownerUserId = authority.isPersonal ? input.actorUserId : null;
      const rows = await tx.query<{
        id: string;
        name: string;
        purpose: string;
        placement: string;
        current_version: string | number;
        state: string;
        created_at: Date | string;
        updated_at: Date | string;
        revoked_at: Date | string | null;
      }>(
        `SELECT id, name, purpose, placement, current_version, state,
                created_at, updated_at, revoked_at
         FROM secret_bindings
         WHERE org_id = $1 AND owner_kind = $2::cloud_profile_owner
           AND owner_user_id IS NOT DISTINCT FROM $3::uuid
         ORDER BY state, purpose, name, id`,
        [input.organizationId, ownerKind, ownerUserId],
      );
      return {
        bindings: rows.rows.map((row) => ({
          id: row.id,
          name: row.name,
          purpose: row.purpose,
          placement: row.placement,
          version: safeVersion(row.current_version, "secret binding"),
          state: row.state,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
          revokedAt: iso(row.revoked_at),
        })),
      };
    });
  }

  async createSecretBinding(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
    name: string;
    purpose: "environment" | "mcp" | "provider" | "agent";
    placement: "cloud" | "both";
    value: string;
  }): Promise<{ binding: unknown; replayed: boolean }> {
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const secretKey = currentSecretKey(this.config);
      const ownerKind = authority.isPersonal ? "user" : "organization";
      const ownerUserId = authority.isPersonal ? input.actorUserId : null;
      const existing = (
        await tx.query<{
          org_id: string;
          owner_kind: string;
          owner_user_id: string | null;
          name: string;
          purpose: string;
          placement: string;
          current_version: string | number;
          state: string;
          key_version: number;
          nonce: Buffer;
          ciphertext: Buffer;
          auth_tag: Buffer;
          verifier_scheme: number;
          value_verifier: Buffer | null;
        }>(
          `SELECT binding.org_id, binding.owner_kind, binding.owner_user_id,
                  binding.name, binding.purpose, binding.placement,
                  binding.current_version, binding.state, version.key_version,
                  version.nonce, version.ciphertext, version.auth_tag,
                  version.verifier_scheme, version.value_verifier
           FROM secret_bindings binding
           JOIN secret_binding_versions version
             ON version.binding_id = binding.id
            AND version.org_id = binding.org_id
            AND version.version = binding.current_version
           WHERE binding.id = $1 FOR UPDATE OF binding`,
          [input.id],
        )
      ).rows[0];
      if (existing) {
        const exact =
          existing.org_id === input.organizationId &&
          existing.owner_kind === ownerKind &&
          existing.owner_user_id === ownerUserId &&
          existing.name === input.name &&
          existing.purpose === input.purpose &&
          existing.placement === input.placement &&
          existing.state === "active" &&
          storedSecretMatches(
            input.value,
            existing,
            {
              bindingId: input.id,
              organizationId: input.organizationId,
              version: safeVersion(existing.current_version, "secret binding"),
              name: input.name,
            },
            this.config,
          );
        if (!exact) {
          throw new HttpError(409, "cloud_secret_identity_conflict", "Secret binding identity is already in use");
        }
        return {
          binding: {
            id: input.id,
            name: input.name,
            purpose: input.purpose,
            placement: input.placement,
            state: "active",
            version: safeVersion(existing.current_version, "secret binding"),
          },
          replayed: true,
        };
      }
      let sealed;
      try {
        sealed = sealCloudWorkspaceSecretBinding(
          input.value,
          {
            bindingId: input.id,
            organizationId: input.organizationId,
            version: 1,
            name: input.name,
          },
          secretKey.key,
        );
      } catch {
        throw new HttpError(422, "cloud_secret_invalid", "Secret binding input is invalid");
      }
      await tx.query(
        `INSERT INTO secret_bindings (
           id, org_id, owner_kind, owner_user_id, name, purpose,
           placement, current_version, state
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'active')`,
        [
          input.id,
          input.organizationId,
          ownerKind,
          ownerUserId,
          input.name,
          input.purpose,
          input.placement,
        ],
      );
      await tx.query(
        `INSERT INTO secret_binding_versions (
           binding_id, org_id, version, key_version, nonce, ciphertext,
           auth_tag, verifier_scheme, value_verifier, created_by
         ) VALUES ($1, $2, 1, $3, $4, $5, $6, 1, $7, $8)`,
        [
          input.id,
          input.organizationId,
          secretKey.version,
          sealed.nonce,
          sealed.ciphertext,
          sealed.authTag,
          sealed.valueVerifier,
          input.actorUserId,
        ],
      );
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.secret_binding_created", {
        bindingId: input.id,
        ownerKind,
        name: input.name,
        purpose: input.purpose,
        placement: input.placement,
        version: 1,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_settings.secret_binding_created",
        aggregateKey: `secret-binding:${input.id}`,
        revision: 1,
        idempotencyKey: `secret-binding:${input.id}:1`,
        payload: { bindingId: input.id, ownerKind, purpose: input.purpose, placement: input.placement, version: 1 },
      });
      return {
        binding: {
          id: input.id,
          name: input.name,
          purpose: input.purpose,
          placement: input.placement,
          state: "active",
          version: 1,
        },
        replayed: false,
      };
    });
  }

  async rotateSecretBinding(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
    expectedVersion: number;
    value: string;
  }): Promise<{
    binding: unknown;
    replayed: boolean;
    generationsUsingPreviousVersion: number;
  }> {
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const secretKey = currentSecretKey(this.config);
      const ownerKind = authority.isPersonal ? "user" : "organization";
      const ownerUserId = authority.isPersonal ? input.actorUserId : null;
      const row = (
        await tx.query<{
          name: string;
          purpose: string;
          placement: string;
          current_version: string | number;
          state: string;
          key_version: number;
          nonce: Buffer;
          ciphertext: Buffer;
          auth_tag: Buffer;
          verifier_scheme: number;
          value_verifier: Buffer | null;
        }>(
          `SELECT binding.name, binding.purpose, binding.placement,
                  binding.current_version, binding.state, version.key_version,
                  version.nonce, version.ciphertext, version.auth_tag,
                  version.verifier_scheme, version.value_verifier
           FROM secret_bindings binding
           JOIN secret_binding_versions version
             ON version.binding_id = binding.id
            AND version.org_id = binding.org_id
            AND version.version = binding.current_version
           WHERE binding.id = $1 AND binding.org_id = $2
             AND binding.owner_kind = $3::cloud_profile_owner
             AND binding.owner_user_id IS NOT DISTINCT FROM $4::uuid
           FOR UPDATE OF binding`,
          [input.id, input.organizationId, ownerKind, ownerUserId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "not_found", "Secret binding not found");
      if (row.state !== "active") {
        throw new HttpError(409, "cloud_secret_revoked", "Secret binding is revoked");
      }
      const currentVersion = safeVersion(row.current_version, "secret binding");
      const activeUses = Number(
        (
          await tx.query<{ count: string | number }>(
            `SELECT count(*) AS count
             FROM cloud_workspace_generation_secret_bindings link
             JOIN cloud_workspace_generations generation
               ON generation.workspace_id = link.workspace_id
              AND generation.generation = link.generation
              AND generation.org_id = link.org_id
             WHERE link.binding_id = $1 AND link.binding_version = $2
               AND generation.retired_at IS NULL`,
            [input.id, currentVersion],
          )
        ).rows[0]?.count ?? 0,
      );
      if (
        row.key_version === secretKey.version &&
        storedSecretMatches(
          input.value,
          row,
          {
            bindingId: input.id,
            organizationId: input.organizationId,
            version: currentVersion,
            name: row.name,
          },
          this.config,
        )
      ) {
        return {
          binding: {
            id: input.id,
            name: row.name,
            purpose: row.purpose,
            placement: row.placement,
            state: row.state,
            version: currentVersion,
          },
          replayed: true,
          generationsUsingPreviousVersion: activeUses,
        };
      }
      if (currentVersion !== input.expectedVersion) {
        throw new HttpError(
          409,
          "cloud_secret_version_conflict",
          "Secret binding changed; reload before rotating",
          { currentVersion },
        );
      }
      const version = currentVersion + 1;
      let sealed;
      try {
        sealed = sealCloudWorkspaceSecretBinding(
          input.value,
          {
            bindingId: input.id,
            organizationId: input.organizationId,
            version,
            name: row.name,
          },
          secretKey.key,
        );
      } catch {
        throw new HttpError(422, "cloud_secret_invalid", "Secret binding input is invalid");
      }
      await tx.query(
        `INSERT INTO secret_binding_versions (
           binding_id, org_id, version, key_version, nonce, ciphertext,
           auth_tag, verifier_scheme, value_verifier, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)`,
        [
          input.id,
          input.organizationId,
          version,
          secretKey.version,
          sealed.nonce,
          sealed.ciphertext,
          sealed.authTag,
          sealed.valueVerifier,
          input.actorUserId,
        ],
      );
      await tx.query(
        `UPDATE secret_bindings
         SET current_version = $3, updated_at = now()
         WHERE id = $1 AND org_id = $2`,
        [input.id, input.organizationId, version],
      );
      if (activeUses === 0) {
        await tx.query(
          `UPDATE secret_binding_versions
           SET retired_at = coalesce(retired_at, now())
           WHERE binding_id = $1 AND version = $2`,
          [input.id, currentVersion],
        );
      }
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.secret_binding_rotated", {
        bindingId: input.id,
        previousVersion: currentVersion,
        version,
        generationsUsingPreviousVersion: activeUses,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_settings.secret_binding_rotated",
        aggregateKey: `secret-binding:${input.id}`,
        revision: version,
        idempotencyKey: `secret-binding:${input.id}:${version}`,
        payload: { bindingId: input.id, previousVersion: currentVersion, version, generationsUsingPreviousVersion: activeUses },
      });
      return {
        binding: {
          id: input.id,
          name: row.name,
          purpose: row.purpose,
          placement: row.placement,
          state: row.state,
          version,
        },
        replayed: false,
        generationsUsingPreviousVersion: activeUses,
      };
    });
  }

  async revokeSecretBinding(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
    expectedVersion: number;
  }): Promise<{
    binding: { id: string; state: "revoked"; version: number };
    stoppedWorkspaceIds: string[];
    replayed: boolean;
  }> {
    return withSystemTx(this.pool, async (tx) => {
      const authority = await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const ownerKind = authority.isPersonal ? "user" : "organization";
      const ownerUserId = authority.isPersonal ? input.actorUserId : null;
      const row = (
        await tx.query<{
          current_version: string | number;
          state: "active" | "revoked";
        }>(
          `SELECT current_version, state
           FROM secret_bindings
           WHERE id = $1 AND org_id = $2
             AND owner_kind = $3::cloud_profile_owner
             AND owner_user_id IS NOT DISTINCT FROM $4::uuid
           FOR UPDATE`,
          [input.id, input.organizationId, ownerKind, ownerUserId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "not_found", "Secret binding not found");
      const version = safeVersion(row.current_version, "secret binding");
      if (row.state === "revoked") {
        return {
          binding: { id: input.id, state: "revoked", version },
          stoppedWorkspaceIds: [],
          replayed: true,
        };
      }
      if (version !== input.expectedVersion) {
        throw new HttpError(
          409,
          "cloud_secret_version_conflict",
          "Secret binding changed; reload before revoking",
          { currentVersion: version },
        );
      }
      const affected = await tx.query<{ workspace_id: string }>(
        `SELECT DISTINCT workspace.id AS workspace_id
         FROM cloud_workspace_generation_secret_bindings link
         JOIN cloud_workspaces workspace
           ON workspace.id = link.workspace_id AND workspace.org_id = link.org_id
          AND workspace.current_generation = link.generation
         WHERE link.binding_id = $1 AND link.org_id = $2
           AND workspace.deleted_at IS NULL
         ORDER BY workspace.id`,
        [input.id, input.organizationId],
      );
      const stoppedWorkspaceIds = await scheduleSecurityStops(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        resourceKind: "secret_binding",
        resourceId: input.id,
        workspaceIds: affected.rows.map((entry) => entry.workspace_id),
      });
      await tx.query(
        `UPDATE secret_bindings
         SET state = 'revoked', revoked_at = now(), updated_at = now()
         WHERE id = $1 AND org_id = $2 AND state = 'active'`,
        [input.id, input.organizationId],
      );
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.secret_binding_revoked", {
        bindingId: input.id,
        version,
        stoppedWorkspaceIds,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_settings.secret_binding_revoked",
        aggregateKey: `secret-binding-revocation:${input.id}`,
        revision: version,
        idempotencyKey: `secret-binding:${input.id}:revoked:${version}`,
        payload: { bindingId: input.id, version, stoppedWorkspaceIds },
      });
      return {
        binding: { id: input.id, state: "revoked", version },
        stoppedWorkspaceIds,
        replayed: false,
      };
    });
  }

  async listProviderConnections(input: {
    organizationId: string;
    actorUserId: string;
  }): Promise<{ connections: unknown[] }> {
    return withSystemTx(this.pool, async (tx) => {
      await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const rows = await tx.query<{
        id: string;
        owner_kind: "user" | "organization";
        owner_user_id: string | null;
        provider: "daytona";
        display_name: string;
        credential_source: "hosted" | "delegated";
        current_version: string | number;
        state: "active" | "revoked" | "invalid";
        capabilities: Record<string, unknown>;
        region: string | null;
        created_at: Date | string;
        updated_at: Date | string;
        revoked_at: Date | string | null;
      }>(
        `SELECT id, owner_kind, owner_user_id, provider, display_name,
                credential_source, current_version, state, capabilities,
                region, created_at, updated_at, revoked_at
         FROM provider_connections
         WHERE org_id = $1
           AND (
             (owner_kind = 'organization' AND owner_user_id IS NULL)
             OR (owner_kind = 'user' AND owner_user_id = $2)
           )
         ORDER BY state, lower(display_name), id`,
        [input.organizationId, input.actorUserId],
      );
      return {
        connections: rows.rows.map((row) => this.providerConnectionDocument(row)),
      };
    });
  }

  private providerConnectionDocument(row: {
    id: string;
    owner_kind: "user" | "organization";
    owner_user_id: string | null;
    provider: "daytona";
    display_name: string;
    credential_source: "hosted" | "delegated";
    current_version: string | number;
    state: "active" | "revoked" | "invalid";
    capabilities: Record<string, unknown>;
    region: string | null;
    created_at?: Date | string;
    updated_at?: Date | string;
    revoked_at?: Date | string | null;
  }): Record<string, unknown> {
    const capabilities = row.capabilities ?? {};
    return {
      id: row.id,
      ownerKind: row.owner_kind,
      provider: row.provider,
      displayName: row.display_name,
      credentialSource: row.credential_source,
      version: safeVersion(row.current_version, "provider connection"),
      state: row.state,
      region: row.region,
      capabilities: {
        qualified: capabilities.qualified === true,
        qualificationVersion:
          capabilities.qualificationVersion === 1 ? 1 : null,
        lifecycle: capabilities.lifecycle === true,
        ssh: capabilities.ssh === true,
        preview: capabilities.preview === true,
        commandExecution: capabilities.commandExecution === true,
        credentialExpiresAt:
          typeof capabilities.credentialExpiresAt === "string"
            ? capabilities.credentialExpiresAt
            : null,
      },
      ...(row.created_at !== undefined ? { createdAt: iso(row.created_at) } : {}),
      ...(row.updated_at !== undefined ? { updatedAt: iso(row.updated_at) } : {}),
      ...(row.revoked_at !== undefined ? { revokedAt: iso(row.revoked_at) } : {}),
    };
  }

  private async providerOwner(
    tx: Tx,
    input: {
      organizationId: string;
      actorUserId: string;
      ownerKind: "user" | "organization";
      paid: boolean;
    },
  ): Promise<{ ownerKind: "user" | "organization"; ownerUserId: string | null }> {
    const authority = await organizationAuthority(tx, {
      ...input,
      workosEnabled: this.options.workosEnabled,
      paid: input.paid,
    });
    if (authority.isPersonal && input.ownerKind !== "user") {
      throw new HttpError(
        422,
        "cloud_provider_owner_invalid",
        "Personal cloud provider connections must be account-owned",
      );
    }
    return {
      ownerKind: input.ownerKind,
      ownerUserId: input.ownerKind === "user" ? input.actorUserId : null,
    };
  }

  async createProviderConnection(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
    ownerKind: "user" | "organization";
    displayName: string;
    apiKey: string;
  }): Promise<{ connection: unknown; replayed: boolean }> {
    const digest = createHash("sha256").update(input.apiKey, "utf8").digest();
    const storedKey = credentialKey(this.config);
    const preflight = await withSystemTx(this.pool, async (tx) => {
      const owner = await this.providerOwner(tx, { ...input, paid: true });
      const existing = (
        await tx.query<{
          id: string;
          org_id: string;
          owner_kind: "user" | "organization";
          owner_user_id: string | null;
          provider: "daytona";
          display_name: string;
          credential_source: "hosted" | "delegated";
          current_version: string | number;
          state: "active" | "revoked" | "invalid";
          capabilities: Record<string, unknown>;
          region: string | null;
          credential_sha256: Buffer | null;
        }>(
          `SELECT connection.id, connection.org_id, connection.owner_kind,
                  connection.owner_user_id, connection.provider,
                  connection.display_name, connection.credential_source,
                  connection.current_version, connection.state,
                  connection.capabilities, connection.region,
                  version.credential_sha256
           FROM provider_connections connection
           JOIN provider_connection_versions version
             ON version.connection_id = connection.id
            AND version.org_id = connection.org_id
            AND version.version = connection.current_version
           WHERE connection.id = $1`,
          [input.id],
        )
      ).rows[0];
      if (!existing) return { owner, existing: null };
      const exact =
        existing.org_id === input.organizationId &&
        existing.owner_kind === owner.ownerKind &&
        existing.owner_user_id === owner.ownerUserId &&
        existing.provider === "daytona" &&
        existing.display_name === input.displayName &&
        existing.credential_source === "delegated" &&
        existing.state === "active" &&
        existing.credential_sha256 !== null &&
        same(existing.credential_sha256, digest);
      if (!exact) {
        throw new HttpError(409, "cloud_provider_identity_conflict", "Provider connection identity is already in use");
      }
      return { owner, existing };
    });
    if (preflight.existing) {
      return {
        connection: this.providerConnectionDocument(preflight.existing),
        replayed: true,
      };
    }

    let qualification;
    try {
      qualification = await this.qualifier().qualify({
        apiKey: input.apiKey,
        apiUrl: this.config.apiUrl,
        target: this.config.target,
      });
    } catch (error) {
      if (error instanceof CloudProviderQualificationError) {
        throw new HttpError(422, error.code, error.message);
      }
      throw error;
    }
    const capabilities = {
      ...qualification.capabilities,
      credentialExpiresAt: qualification.credentialExpiresAt,
    };
    return withSystemTx(this.pool, async (tx) => {
      const owner = await this.providerOwner(tx, { ...input, paid: true });
      // Qualification is deliberately outside a database transaction. A
      // deterministic per-id lock makes two qualified retries converge on one
      // encrypted row instead of turning the second valid request into a
      // uniqueness failure.
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [input.id],
      );
      const collision = (
        await tx.query<{
          id: string;
          org_id: string;
          owner_kind: "user" | "organization";
          owner_user_id: string | null;
          provider: "daytona";
          display_name: string;
          credential_source: "hosted" | "delegated";
          current_version: string | number;
          state: "active" | "revoked" | "invalid";
          capabilities: Record<string, unknown>;
          region: string | null;
          credential_sha256: Buffer | null;
        }>(
          `SELECT connection.id, connection.org_id, connection.owner_kind,
                  connection.owner_user_id, connection.provider,
                  connection.display_name, connection.credential_source,
                  connection.current_version, connection.state,
                  connection.capabilities, connection.region,
                  version.credential_sha256
           FROM provider_connections connection
           JOIN provider_connection_versions version
             ON version.connection_id = connection.id
            AND version.org_id = connection.org_id
            AND version.version = connection.current_version
           WHERE connection.id = $1
           FOR UPDATE OF connection`,
          [input.id],
        )
      ).rows[0];
      if (collision) {
        const exact =
          collision.org_id === input.organizationId &&
          collision.owner_kind === owner.ownerKind &&
          collision.owner_user_id === owner.ownerUserId &&
          collision.provider === "daytona" &&
          collision.display_name === input.displayName &&
          collision.credential_source === "delegated" &&
          collision.state === "active" &&
          collision.credential_sha256 !== null &&
          same(collision.credential_sha256, digest);
        if (exact) {
          return {
            connection: this.providerConnectionDocument(collision),
            replayed: true,
          };
        }
        throw new HttpError(409, "cloud_provider_identity_conflict", "Provider connection identity is already in use");
      }
      const sealed = sealCloudProviderCredential(
        input.apiKey,
        {
          connectionId: input.id,
          organizationId: input.organizationId,
          version: 1,
          provider: "daytona",
          endpoint: this.config.apiUrl,
        },
        storedKey.key,
      );
      await tx.query(
        `INSERT INTO provider_connections (
           id, org_id, owner_kind, owner_user_id, provider, display_name,
           credential_source, current_version, state, capabilities, region
         ) VALUES ($1, $2, $3, $4, 'daytona', $5, 'delegated', 1,
                   'active', $6::jsonb, $7)`,
        [
          input.id,
          input.organizationId,
          owner.ownerKind,
          owner.ownerUserId,
          input.displayName,
          JSON.stringify(capabilities),
          this.config.target,
        ],
      );
      await tx.query(
        `INSERT INTO provider_connection_versions (
           connection_id, org_id, version, credential_source, endpoint,
           key_version, nonce, ciphertext, auth_tag, credential_sha256,
           capabilities, credential_expires_at, created_by
         ) VALUES (
           $1, $2, 1, 'delegated', $3, $4, $5, $6, $7, $8,
           $9::jsonb, $10, $11
         )`,
        [
          input.id,
          input.organizationId,
          this.config.apiUrl,
          storedKey.version,
          sealed.nonce,
          sealed.ciphertext,
          sealed.authTag,
          sealed.credentialSha256,
          JSON.stringify(capabilities),
          qualification.credentialExpiresAt,
          input.actorUserId,
        ],
      );
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.provider_connection_created", {
        providerConnectionId: input.id,
        ownerKind: owner.ownerKind,
        provider: "daytona",
        version: 1,
        credentialExpiresAt: qualification.credentialExpiresAt,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_provider.connection_created",
        aggregateKey: `provider-connection:${input.id}`,
        revision: 1,
        idempotencyKey: `provider-connection:${input.id}:1`,
        payload: { providerConnectionId: input.id, ownerKind: owner.ownerKind, provider: "daytona", version: 1 },
      });
      return {
        connection: this.providerConnectionDocument({
          id: input.id,
          owner_kind: owner.ownerKind,
          owner_user_id: owner.ownerUserId,
          provider: "daytona",
          display_name: input.displayName,
          credential_source: "delegated",
          current_version: 1,
          state: "active",
          capabilities,
          region: this.config.target,
        }),
        replayed: false,
      };
    });
  }

  async rotateProviderConnection(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
    expectedVersion: number;
    apiKey: string;
  }): Promise<{
    connection: unknown;
    replayed: boolean;
    generationsUsingPreviousVersion: number;
  }> {
    const digest = createHash("sha256").update(input.apiKey, "utf8").digest();
    const storedKey = credentialKey(this.config);
    const preflight = await withSystemTx(this.pool, async (tx) => {
      await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: true,
      });
      const row = (
        await tx.query<{
          owner_kind: "user" | "organization";
          owner_user_id: string | null;
          display_name: string;
          credential_source: "hosted" | "delegated";
          current_version: string | number;
          state: "active" | "revoked" | "invalid";
          capabilities: Record<string, unknown>;
          region: string | null;
          credential_sha256: Buffer | null;
        }>(
          `SELECT connection.owner_kind, connection.owner_user_id,
                  connection.display_name, connection.credential_source,
                  connection.current_version, connection.state,
                  connection.capabilities, connection.region,
                  version.credential_sha256
           FROM provider_connections connection
           JOIN provider_connection_versions version
             ON version.connection_id = connection.id
            AND version.org_id = connection.org_id
            AND version.version = connection.current_version
           WHERE connection.id = $1 AND connection.org_id = $2
             AND connection.provider = 'daytona'
             AND (
               (connection.owner_kind = 'organization'
                 AND connection.owner_user_id IS NULL)
               OR (connection.owner_kind = 'user'
                 AND connection.owner_user_id = $3)
             )`,
          [input.id, input.organizationId, input.actorUserId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "not_found", "Provider connection not found");
      if (row.credential_source !== "delegated") {
        throw new HttpError(409, "cloud_provider_managed", "Hosted provider credentials are operator-managed");
      }
      if (row.state !== "active") {
        throw new HttpError(409, "cloud_provider_revoked", "Provider connection is not active");
      }
      const version = safeVersion(row.current_version, "provider connection");
      const uses = Number(
        (
          await tx.query<{ count: string | number }>(
            `SELECT count(*) AS count FROM cloud_workspace_generations
             WHERE provider_connection_id = $1
               AND provider_connection_version = $2
               AND retired_at IS NULL`,
            [input.id, version],
          )
        ).rows[0]?.count ?? 0,
      );
      if (row.credential_sha256 && same(row.credential_sha256, digest)) {
        return { row, version, uses, replayed: true as const };
      }
      if (version !== input.expectedVersion) {
        throw new HttpError(
          409,
          "cloud_provider_version_conflict",
          "Provider connection changed; reload before rotating",
          { currentVersion: version },
        );
      }
      return { row, version, uses, replayed: false as const };
    });
    if (preflight.replayed) {
      return {
        connection: this.providerConnectionDocument({
          id: input.id,
          owner_kind: preflight.row.owner_kind,
          owner_user_id: preflight.row.owner_user_id,
          provider: "daytona",
          display_name: preflight.row.display_name,
          credential_source: "delegated",
          current_version: preflight.version,
          state: "active",
          capabilities: preflight.row.capabilities,
          region: preflight.row.region,
        }),
        replayed: true,
        generationsUsingPreviousVersion: preflight.uses,
      };
    }
    let qualification;
    try {
      qualification = await this.qualifier().qualify({
        apiKey: input.apiKey,
        apiUrl: this.config.apiUrl,
        target: this.config.target,
      });
    } catch (error) {
      if (error instanceof CloudProviderQualificationError) {
        throw new HttpError(422, error.code, error.message);
      }
      throw error;
    }
    return withSystemTx(this.pool, async (tx) => {
      await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: true,
      });
      const row = (
        await tx.query<{
          owner_kind: "user" | "organization";
          owner_user_id: string | null;
          display_name: string;
          current_version: string | number;
          state: "active" | "revoked" | "invalid";
          capabilities: Record<string, unknown>;
          region: string | null;
        }>(
          `SELECT owner_kind, owner_user_id, display_name, current_version,
                  state, capabilities, region
           FROM provider_connections
           WHERE id = $1 AND org_id = $2 AND credential_source = 'delegated'
             AND (
               (owner_kind = 'organization' AND owner_user_id IS NULL)
               OR (owner_kind = 'user' AND owner_user_id = $3)
             )
           FOR UPDATE`,
          [input.id, input.organizationId, input.actorUserId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "not_found", "Provider connection not found");
      if (row.state !== "active") {
        throw new HttpError(409, "cloud_provider_revoked", "Provider connection is not active");
      }
      const currentVersion = safeVersion(row.current_version, "provider connection");
      if (currentVersion !== input.expectedVersion) {
        const currentHash = (
          await tx.query<{ credential_sha256: Buffer | null }>(
            `SELECT credential_sha256 FROM provider_connection_versions
             WHERE connection_id = $1 AND org_id = $2 AND version = $3`,
            [input.id, input.organizationId, currentVersion],
          )
        ).rows[0]?.credential_sha256;
        if (currentHash && same(currentHash, digest)) {
          const uses = Number(
            (
              await tx.query<{ count: string | number }>(
                `SELECT count(*) AS count FROM cloud_workspace_generations
                 WHERE provider_connection_id = $1
                   AND provider_connection_version = $2
                   AND retired_at IS NULL`,
                [input.id, input.expectedVersion],
              )
            ).rows[0]?.count ?? 0,
          );
          return {
            connection: this.providerConnectionDocument({
              id: input.id,
              owner_kind: row.owner_kind,
              owner_user_id: row.owner_user_id,
              provider: "daytona",
              display_name: row.display_name,
              credential_source: "delegated",
              current_version: currentVersion,
              state: "active",
              capabilities: row.capabilities,
              region: row.region,
            }),
            replayed: true,
            generationsUsingPreviousVersion: uses,
          };
        }
        throw new HttpError(
          409,
          "cloud_provider_version_conflict",
          "Provider connection changed; reload before rotating",
          { currentVersion },
        );
      }
      const version = currentVersion + 1;
      const sealed = sealCloudProviderCredential(
        input.apiKey,
        {
          connectionId: input.id,
          organizationId: input.organizationId,
          version,
          provider: "daytona",
          endpoint: this.config.apiUrl,
        },
        storedKey.key,
      );
      const capabilities = {
        ...qualification.capabilities,
        credentialExpiresAt: qualification.credentialExpiresAt,
      };
      await tx.query(
        `INSERT INTO provider_connection_versions (
           connection_id, org_id, version, credential_source, endpoint,
           key_version, nonce, ciphertext, auth_tag, credential_sha256,
           capabilities, credential_expires_at, created_by
         ) VALUES (
           $1, $2, $3, 'delegated', $4, $5, $6, $7, $8, $9,
           $10::jsonb, $11, $12
         )`,
        [
          input.id,
          input.organizationId,
          version,
          this.config.apiUrl,
          storedKey.version,
          sealed.nonce,
          sealed.ciphertext,
          sealed.authTag,
          sealed.credentialSha256,
          JSON.stringify(capabilities),
          qualification.credentialExpiresAt,
          input.actorUserId,
        ],
      );
      await tx.query(
        `UPDATE provider_connections
         SET current_version = $3, capabilities = $4::jsonb,
             region = $5, updated_at = now()
         WHERE id = $1 AND org_id = $2`,
        [input.id, input.organizationId, version, JSON.stringify(capabilities), this.config.target],
      );
      const uses = Number(
        (
          await tx.query<{ count: string | number }>(
            `SELECT count(*) AS count FROM cloud_workspace_generations
             WHERE provider_connection_id = $1
               AND provider_connection_version = $2
               AND retired_at IS NULL`,
            [input.id, currentVersion],
          )
        ).rows[0]?.count ?? 0,
      );
      if (uses === 0) {
        await tx.query(
          `UPDATE provider_connection_versions
           SET retired_at = coalesce(retired_at, now())
           WHERE connection_id = $1 AND version = $2`,
          [input.id, currentVersion],
        );
      }
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.provider_connection_rotated", {
        providerConnectionId: input.id,
        previousVersion: currentVersion,
        version,
        generationsUsingPreviousVersion: uses,
        credentialExpiresAt: qualification.credentialExpiresAt,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_provider.connection_rotated",
        aggregateKey: `provider-connection:${input.id}`,
        revision: version,
        idempotencyKey: `provider-connection:${input.id}:${version}`,
        payload: { providerConnectionId: input.id, previousVersion: currentVersion, version, generationsUsingPreviousVersion: uses },
      });
      return {
        connection: this.providerConnectionDocument({
          id: input.id,
          owner_kind: row.owner_kind,
          owner_user_id: row.owner_user_id,
          provider: "daytona",
          display_name: row.display_name,
          credential_source: "delegated",
          current_version: version,
          state: "active",
          capabilities,
          region: this.config.target,
        }),
        replayed: false,
        generationsUsingPreviousVersion: uses,
      };
    });
  }

  async revokeProviderConnection(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
    expectedVersion: number;
  }): Promise<{
    connection: { id: string; state: "revoked"; version: number };
    stoppedWorkspaceIds: string[];
    replayed: boolean;
  }> {
    return withSystemTx(this.pool, async (tx) => {
      await organizationAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const row = (
        await tx.query<{
          credential_source: "hosted" | "delegated";
          current_version: string | number;
          state: "active" | "revoked" | "invalid";
        }>(
          `SELECT credential_source, current_version, state
           FROM provider_connections
           WHERE id = $1 AND org_id = $2
             AND (
               (owner_kind = 'organization' AND owner_user_id IS NULL)
               OR (owner_kind = 'user' AND owner_user_id = $3)
             )
           FOR UPDATE`,
          [input.id, input.organizationId, input.actorUserId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "not_found", "Provider connection not found");
      if (row.credential_source !== "delegated") {
        throw new HttpError(409, "cloud_provider_managed", "Hosted provider credentials are operator-managed");
      }
      const version = safeVersion(row.current_version, "provider connection");
      if (row.state === "revoked") {
        return {
          connection: { id: input.id, state: "revoked", version },
          stoppedWorkspaceIds: [],
          replayed: true,
        };
      }
      if (version !== input.expectedVersion) {
        throw new HttpError(
          409,
          "cloud_provider_version_conflict",
          "Provider connection changed; reload before revoking",
          { currentVersion: version },
        );
      }
      const affected = await tx.query<{ workspace_id: string }>(
        `SELECT DISTINCT workspace.id AS workspace_id
         FROM cloud_workspace_generations generation
         JOIN cloud_workspaces workspace
           ON workspace.id = generation.workspace_id
          AND workspace.org_id = generation.org_id
          AND workspace.current_generation = generation.generation
         WHERE generation.provider_connection_id = $1
           AND generation.org_id = $2 AND workspace.deleted_at IS NULL
         ORDER BY workspace.id`,
        [input.id, input.organizationId],
      );
      const stoppedWorkspaceIds = await scheduleSecurityStops(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        resourceKind: "provider_connection",
        resourceId: input.id,
        workspaceIds: affected.rows.map((entry) => entry.workspace_id),
      });
      await tx.query(
        `UPDATE provider_connections
         SET state = 'revoked', revoked_at = now(), updated_at = now()
         WHERE id = $1 AND org_id = $2 AND state <> 'revoked'`,
        [input.id, input.organizationId],
      );
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.provider_connection_revoked", {
        providerConnectionId: input.id,
        version,
        stoppedWorkspaceIds,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        eventType: "cloud_provider.connection_revoked",
        aggregateKey: `provider-connection-revocation:${input.id}`,
        revision: version,
        idempotencyKey: `provider-connection:${input.id}:revoked:${version}`,
        payload: { providerConnectionId: input.id, version, stoppedWorkspaceIds },
      });
      return {
        connection: { id: input.id, state: "revoked", version },
        stoppedWorkspaceIds,
        replayed: false,
      };
    });
  }

  async workspaceOverview(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
  }): Promise<Record<string, unknown>> {
    return withSystemTx(this.pool, async (tx) => {
      const workspace = await workspaceAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
      });
      const settings = (
        await tx.query<{
          id: string;
          effective_document: Record<string, unknown>;
          provenance: Record<string, unknown>;
          source_versions: Record<string, unknown>;
          sha256: string;
          created_at: Date | string;
        }>(
          `SELECT id, effective_document, provenance, source_versions,
                  encode(effective_sha256, 'hex') AS sha256, created_at
           FROM workspace_settings_versions
           WHERE workspace_id = $1 AND org_id = $2 AND generation = $3`,
          [input.workspaceId, input.organizationId, workspace.currentGeneration],
        )
      ).rows[0] ?? null;
      const provider = (
        await tx.query<{
          id: string;
          owner_kind: "user" | "organization";
          owner_user_id: string | null;
          provider: "daytona";
          display_name: string;
          credential_source: "hosted" | "delegated";
          current_version: string | number;
          state: "active" | "revoked" | "invalid";
          capabilities: Record<string, unknown>;
          region: string | null;
          generation_version: string | number;
        }>(
          `SELECT connection.id, connection.owner_kind,
                  connection.owner_user_id, connection.provider,
                  connection.display_name, connection.credential_source,
                  connection.current_version, connection.state,
                  connection.capabilities, connection.region,
                  generation.provider_connection_version AS generation_version
           FROM cloud_workspace_generations generation
           JOIN provider_connections connection
             ON connection.id = generation.provider_connection_id
            AND connection.org_id = generation.org_id
           WHERE generation.workspace_id = $1 AND generation.org_id = $2
             AND generation.generation = $3`,
          [input.workspaceId, input.organizationId, workspace.currentGeneration],
        )
      ).rows[0] ?? null;
      // This allocation must remain identical to route and operator quota
      // admission, including candidate reservations and pending provider disk.
      const quota = (
        await tx.query<{
          max_workspaces: number;
          max_running_workspaces: number;
          max_cpu_millicores: number;
          max_memory_mib: number;
          max_storage_mib: number;
          workspace_count: number;
          running_count: number;
          cpu_millicores: string | number;
          memory_mib: string | number;
          storage_mib: string | number;
        }>(
          `WITH workspace_usage AS (
             SELECT count(*)::integer AS workspace_count,
                    count(*) FILTER (
                      WHERE desired_state = 'running'
                    )::integer AS running_count
             FROM cloud_workspaces
             WHERE org_id = $1 AND status <> 'deleted'
           ), generation_allocation AS (
             SELECT generation.cpu_millicores, generation.memory_mib,
                    generation.storage_mib, workspace.desired_state,
                    (
                      workspace.status <> 'deleted'
                      AND generation.generation = workspace.current_generation
                    ) AS current_reserved,
                    (
                      workspace.status <> 'deleted'
                      AND generation.generation <> workspace.current_generation
                      AND generation.retired_at IS NULL
                      AND transition.id IS NOT NULL
                    ) AS candidate_reserved,
                    (
                      binding.provider_resource_id IS NOT NULL
                      AND binding.deletion_verified_at IS NULL
                    ) AS provider_storage_allocated
             FROM cloud_workspaces workspace
             JOIN cloud_workspace_generations generation
               ON generation.workspace_id = workspace.id
              AND generation.org_id = workspace.org_id
             LEFT JOIN cloud_workspace_provider_bindings binding
               ON binding.workspace_id = generation.workspace_id
              AND binding.generation = generation.generation
              AND binding.org_id = generation.org_id
             LEFT JOIN cloud_workspace_generation_transitions transition
               ON transition.workspace_id = generation.workspace_id
              AND transition.org_id = generation.org_id
              AND transition.candidate_generation = generation.generation
              AND transition.state IN (
                'draining', 'provisioning', 'setting_up', 'rolling_back'
              )
             WHERE workspace.org_id = $1
           ), generation_usage AS (
             SELECT coalesce(sum(cpu_millicores) FILTER (
                      WHERE (current_reserved AND desired_state = 'running')
                         OR candidate_reserved
                    ), 0) AS cpu_millicores,
                    coalesce(sum(memory_mib) FILTER (
                      WHERE (current_reserved AND desired_state = 'running')
                         OR candidate_reserved
                    ), 0) AS memory_mib,
                    coalesce(sum(storage_mib) FILTER (
                      WHERE current_reserved OR candidate_reserved
                         OR provider_storage_allocated
                    ), 0) AS storage_mib
             FROM generation_allocation
           )
           SELECT quota.max_workspaces, quota.max_running_workspaces,
                  quota.max_cpu_millicores, quota.max_memory_mib,
                  quota.max_storage_mib, workspace_usage.workspace_count,
                  workspace_usage.running_count,
                  generation_usage.cpu_millicores,
                  generation_usage.memory_mib,
                  generation_usage.storage_mib
           FROM cloud_workspace_quotas quota
           CROSS JOIN workspace_usage
           CROSS JOIN generation_usage
           WHERE quota.org_id = $1`,
          [input.organizationId],
        )
      ).rows[0] ?? null;
      const usage = await tx.query<{ meter: string; quantity: string }>(
        `SELECT meter, sum(quantity)::text AS quantity
         FROM cloud_workspace_usage_events
         WHERE workspace_id = $1 AND org_id = $2
         GROUP BY meter ORDER BY meter`,
        [input.workspaceId, input.organizationId],
      );
      const checkpoints = await tx.query<{
        id: string;
        generation: number;
        reason: string;
        state: string;
        content_revision: string | number;
        record_revision: string | number;
        file_count: number;
        total_bytes: string | number;
        created_at: Date | string;
        durable_at: Date | string | null;
      }>(
        `SELECT id, generation, reason, state, content_revision,
                record_revision, file_count, total_bytes, created_at, durable_at
         FROM workspace_checkpoints
         WHERE workspace_id = $1 AND org_id = $2
         ORDER BY created_at DESC, id DESC LIMIT 20`,
        [input.workspaceId, input.organizationId],
      );
      const checkpointRequests = await tx.query<{
        id: string;
        generation: number;
        reason: string;
        state: string;
        delivery_count: number;
        deadline_at: Date | string;
        error_code: string | null;
        created_at: Date | string;
        completed_at: Date | string | null;
      }>(
        `SELECT id, generation, reason, state, delivery_count, deadline_at,
                error_code, created_at, completed_at
         FROM workspace_checkpoint_requests
         WHERE workspace_id = $1 AND org_id = $2
         ORDER BY created_at DESC, id DESC LIMIT 20`,
        [input.workspaceId, input.organizationId],
      );
      const exports = await tx.query<{
        id: string;
        include_chats: boolean;
        state: string;
        record_revision: string | number;
        content_revision: string | number;
        created_at: Date | string;
        available_at: Date | string | null;
        expires_at: Date | string | null;
        error_code: string | null;
      }>(
        `SELECT id, include_chats, state, record_revision, content_revision,
                created_at, available_at, expires_at, error_code
         FROM workspace_exports
         WHERE workspace_id = $1 AND org_id = $2
         ORDER BY created_at DESC, id DESC LIMIT 20`,
        [input.workspaceId, input.organizationId],
      );
      const retention = (
        await tx.query<{
          record_event_days: number;
          content_event_days: number;
          checkpoint_days: number;
          export_days: number;
          legal_hold: boolean;
          version: string | number;
          updated_at: Date | string;
          last_applied_at: Date | string | null;
        }>(
          `SELECT record_event_days, content_event_days, checkpoint_days,
                  export_days, legal_hold, version, updated_at, last_applied_at
           FROM workspace_retention_policies
           WHERE workspace_id = $1 AND org_id = $2`,
          [input.workspaceId, input.organizationId],
        )
      ).rows[0] ?? null;
      const ports = await tx.query<{
        port: number;
        protocol: string;
        process_label: string | null;
        health: string;
        observed_at: Date | string;
        closed_at: Date | string | null;
      }>(
        `SELECT port, protocol, process_label, health, observed_at, closed_at
         FROM workspace_ports
         WHERE workspace_id = $1 AND org_id = $2 AND generation = $3
         ORDER BY port`,
        [input.workspaceId, input.organizationId, workspace.currentGeneration],
      );
      const replicas = await tx.query<{
        id: string;
        device_id: string;
        mode: string;
        desired_state: string;
        observed_state: string;
        path_label: string | null;
        event_cursor: string | number;
        version: string | number;
        updated_at: Date | string;
        last_applied_at: Date | string | null;
        last_error_code: string | null;
      }>(
        `SELECT id, device_id, mode, desired_state, observed_state, path_label,
                event_cursor, version, updated_at, last_applied_at,
                last_error_code
         FROM workspace_replicas
         WHERE workspace_id = $1 AND org_id = $2 AND user_id = $3
         ORDER BY updated_at DESC, id`,
        [input.workspaceId, input.organizationId, input.actorUserId],
      );
      const forwards = await tx.query<{
        id: string;
        device_id: string;
        generation: number;
        remote_port: number;
        requested_local_port: number | null;
        observed_local_port: number | null;
        state: string;
        expires_at: Date | string;
        updated_at: Date | string;
      }>(
        `SELECT id, device_id, generation, remote_port,
                requested_local_port, observed_local_port, state,
                expires_at, updated_at
         FROM port_forward_sessions
         WHERE workspace_id = $1 AND org_id = $2 AND user_id = $3
         ORDER BY updated_at DESC, id LIMIT 50`,
        [input.workspaceId, input.organizationId, input.actorUserId],
      );
      const lifecycle = await tx.query<{
        id: string;
        generation: number;
        operation: string;
        state: string;
        attempt_count: number;
        error_code: string | null;
        created_at: Date | string;
        updated_at: Date | string;
      }>(
        `SELECT id, generation, operation, state, attempt_count, error_code,
                created_at, updated_at
         FROM cloud_workspace_lifecycle_intents
         WHERE workspace_id = $1 AND org_id = $2
         ORDER BY created_at DESC, id DESC LIMIT 20`,
        [input.workspaceId, input.organizationId],
      );
      const deletion = (
        await tx.query<{
          state: string;
          attempt_count: number;
          error_code: string | null;
          updated_at: Date | string;
          completed_at: Date | string | null;
        }>(
          `SELECT state, attempt_count, error_code, updated_at, completed_at
           FROM workspace_deletion_jobs
           WHERE workspace_id = $1 AND org_id = $2`,
          [input.workspaceId, input.organizationId],
        )
      ).rows[0] ?? null;

      const effective = settings?.effective_document ?? {};
      const secretNames = Array.isArray(effective.secretRefs)
        ? effective.secretRefs
            .map((entry) =>
              entry && typeof entry === "object" && "name" in entry
                ? String((entry as { name: unknown }).name)
                : null,
            )
            .filter((name): name is string => Boolean(name))
            .sort()
        : [];
      return {
        workspace: {
          id: workspace.id,
          organizationId: workspace.orgId,
          repositoryId: workspace.repositoryId,
          generation: workspace.currentGeneration,
          authorityEpoch: workspace.authorityEpoch,
          status: workspace.status,
          desiredState: workspace.desiredState,
        },
        settings: settings
          ? {
              id: settings.id,
              effective: {
                schemaVersion: effective.schemaVersion,
                values: effective.values ?? {},
                setupCommands: effective.setupCommands ?? [],
                secretNames,
              },
              provenance: settings.provenance,
              sourceVersions: settings.source_versions,
              sha256: settings.sha256,
              createdAt: iso(settings.created_at),
            }
          : null,
        provider: provider
          ? {
              ...this.providerConnectionDocument(provider),
              generationVersion: safeVersion(provider.generation_version, "generation provider"),
            }
          : null,
        quota: quota
          ? {
              limits: {
                workspaces: quota.max_workspaces,
                runningWorkspaces: quota.max_running_workspaces,
                cpuMillicores: quota.max_cpu_millicores,
                memoryMiB: quota.max_memory_mib,
                storageMiB: quota.max_storage_mib,
              },
              allocation: {
                workspaces: quota.workspace_count,
                runningWorkspaces: quota.running_count,
                cpuMillicores: Number(quota.cpu_millicores),
                memoryMiB: Number(quota.memory_mib),
                storageMiB: Number(quota.storage_mib),
              },
            }
          : null,
        usage: usage.rows.map((row) => ({ meter: row.meter, quantity: row.quantity })),
        checkpoints: checkpoints.rows.map((row) => ({
          id: row.id,
          generation: row.generation,
          reason: row.reason,
          state: row.state,
          contentRevision: safeVersion(row.content_revision, "content"),
          recordRevision: safeVersion(row.record_revision, "record"),
          fileCount: row.file_count,
          totalBytes: String(row.total_bytes),
          createdAt: iso(row.created_at),
          durableAt: iso(row.durable_at),
        })),
        checkpointRequests: checkpointRequests.rows.map((row) => ({
          id: row.id,
          generation: row.generation,
          reason: row.reason,
          state: row.state,
          deliveryCount: row.delivery_count,
          deadlineAt: iso(row.deadline_at),
          errorCode: row.error_code,
          createdAt: iso(row.created_at),
          completedAt: iso(row.completed_at),
        })),
        exports: exports.rows.map((row) => ({
          id: row.id,
          includeChats: row.include_chats,
          state: row.state,
          recordRevision: safeVersion(row.record_revision, "record"),
          contentRevision: safeVersion(row.content_revision, "content"),
          createdAt: iso(row.created_at),
          availableAt: iso(row.available_at),
          expiresAt: iso(row.expires_at),
          errorCode: row.error_code,
        })),
        retention: retention
          ? {
              recordEventDays: retention.record_event_days,
              contentEventDays: retention.content_event_days,
              checkpointDays: retention.checkpoint_days,
              exportDays: retention.export_days,
              legalHold: retention.legal_hold,
              version: safeVersion(retention.version, "retention"),
              updatedAt: iso(retention.updated_at),
              lastAppliedAt: iso(retention.last_applied_at),
            }
          : null,
        ports: ports.rows.map((row) => ({
          port: row.port,
          protocol: row.protocol,
          processLabel: row.process_label,
          health: row.health,
          observedAt: iso(row.observed_at),
          closedAt: iso(row.closed_at),
        })),
        replicas: replicas.rows.map((row) => ({
          id: row.id,
          deviceId: row.device_id,
          mode: row.mode,
          desiredState: row.desired_state,
          observedState: row.observed_state,
          pathLabel: row.path_label,
          eventCursor: safeVersion(row.event_cursor, "replica cursor"),
          version: safeVersion(row.version, "replica"),
          updatedAt: iso(row.updated_at),
          lastAppliedAt: iso(row.last_applied_at),
          errorCode: row.last_error_code,
        })),
        forwards: forwards.rows.map((row) => ({
          id: row.id,
          deviceId: row.device_id,
          generation: row.generation,
          remotePort: row.remote_port,
          requestedLocalPort: row.requested_local_port,
          observedLocalPort: row.observed_local_port,
          state: row.state,
          expiresAt: iso(row.expires_at),
          updatedAt: iso(row.updated_at),
        })),
        lifecycle: lifecycle.rows.map((row) => ({
          id: row.id,
          generation: row.generation,
          operation: row.operation,
          state: row.state,
          attemptCount: row.attempt_count,
          errorCode: row.error_code,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        })),
        deletion: deletion
          ? {
              state: deletion.state,
              attemptCount: deletion.attempt_count,
              errorCode: deletion.error_code,
              updatedAt: iso(deletion.updated_at),
              completedAt: iso(deletion.completed_at),
            }
          : null,
      };
    });
  }

  async requestCheckpoint(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    idempotencyKey: string;
  }): Promise<{ request: { id: string; deadlineAt: string }; replayed: boolean }> {
    return withSystemTx(this.pool, async (tx) => {
      const workspace = await workspaceAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: true,
        lock: true,
      });
      if (
        workspace.desiredState !== "running" ||
        !["ready", "busy"].includes(workspace.status)
      ) {
        throw new HttpError(
          409,
          "cloud_workspace_checkpoint_unavailable",
          "A manual checkpoint requires a ready cloud workspace",
        );
      }
      const existing = await tx.query(
        `SELECT 1 FROM workspace_checkpoint_requests
         WHERE workspace_id = $1 AND idempotency_key = $2`,
        [input.workspaceId, input.idempotencyKey],
      );
      let request;
      try {
        request = await enqueueWorkspaceCheckpointRequest(tx, {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: workspace.currentGeneration,
          requestedBy: input.actorUserId,
          reason: "manual",
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("idempotency conflict")) {
          throw new HttpError(409, "idempotency_key_reused", "Checkpoint idempotency key was reused");
        }
        throw error;
      }
      if ((existing.rowCount ?? 0) === 0) {
        await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.checkpoint_requested", {
          workspaceId: input.workspaceId,
          generation: workspace.currentGeneration,
          checkpointRequestId: request.id,
        });
        await outbox(tx, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          eventType: "cloud_workspace.checkpoint_requested",
          aggregateKey: `checkpoint-request:${request.id}`,
          revision: 1,
          idempotencyKey: `checkpoint-request:${request.id}:1`,
          payload: { workspaceId: input.workspaceId, generation: workspace.currentGeneration, checkpointRequestId: request.id },
        });
      }
      return {
        request: { id: request.id, deadlineAt: request.deadlineAt.toISOString() },
        replayed: (existing.rowCount ?? 0) !== 0,
      };
    });
  }

  async updateRetention(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    expectedVersion: number;
    recordEventDays: number;
    contentEventDays: number;
    checkpointDays: number;
    exportDays: number;
  }): Promise<{ retention: Record<string, unknown>; replayed: boolean }> {
    return withSystemTx(this.pool, async (tx) => {
      await workspaceAuthority(tx, {
        ...input,
        workosEnabled: this.options.workosEnabled,
        paid: false,
        lock: true,
      });
      const row = (
        await tx.query<{
          record_event_days: number;
          content_event_days: number;
          checkpoint_days: number;
          export_days: number;
          legal_hold: boolean;
          version: string | number;
        }>(
          `SELECT record_event_days, content_event_days, checkpoint_days,
                  export_days, legal_hold, version
           FROM workspace_retention_policies
           WHERE workspace_id = $1 AND org_id = $2 FOR UPDATE`,
          [input.workspaceId, input.organizationId],
        )
      ).rows[0];
      if (!row) throw new Error("workspace retention policy is missing");
      const currentVersion = safeVersion(row.version, "retention");
      const exact =
        row.record_event_days === input.recordEventDays &&
        row.content_event_days === input.contentEventDays &&
        row.checkpoint_days === input.checkpointDays &&
        row.export_days === input.exportDays;
      if (currentVersion !== input.expectedVersion) {
        if (exact) {
          return {
            retention: {
              recordEventDays: row.record_event_days,
              contentEventDays: row.content_event_days,
              checkpointDays: row.checkpoint_days,
              exportDays: row.export_days,
              legalHold: row.legal_hold,
              version: currentVersion,
            },
            replayed: true,
          };
        }
        throw new HttpError(
          409,
          "cloud_retention_version_conflict",
          "Retention policy changed; reload before saving",
          { currentVersion },
        );
      }
      if (exact) {
        return {
          retention: {
            recordEventDays: row.record_event_days,
            contentEventDays: row.content_event_days,
            checkpointDays: row.checkpoint_days,
            exportDays: row.export_days,
            legalHold: row.legal_hold,
            version: currentVersion,
          },
          replayed: true,
        };
      }
      const version = currentVersion + 1;
      await tx.query(
        `UPDATE workspace_retention_policies
         SET record_event_days = $3, content_event_days = $4,
             checkpoint_days = $5, export_days = $6, version = $7,
             updated_by = $8, updated_at = now()
         WHERE workspace_id = $1 AND org_id = $2`,
        [
          input.workspaceId,
          input.organizationId,
          input.recordEventDays,
          input.contentEventDays,
          input.checkpointDays,
          input.exportDays,
          version,
          input.actorUserId,
        ],
      );
      await audit(tx, input.organizationId, input.actorUserId, "cloud_workspace.retention_updated", {
        workspaceId: input.workspaceId,
        version,
        recordEventDays: input.recordEventDays,
        contentEventDays: input.contentEventDays,
        checkpointDays: input.checkpointDays,
        exportDays: input.exportDays,
      });
      await outbox(tx, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        eventType: "cloud_workspace.retention_updated",
        aggregateKey: `workspace-retention:${input.workspaceId}`,
        revision: version,
        idempotencyKey: `workspace-retention:${input.workspaceId}:${version}`,
        payload: { workspaceId: input.workspaceId, version },
      });
      return {
        retention: {
          recordEventDays: input.recordEventDays,
          contentEventDays: input.contentEventDays,
          checkpointDays: input.checkpointDays,
          exportDays: input.exportDays,
          legalHold: row.legal_hold,
          version,
        },
        replayed: false,
      };
    });
  }
}
