import type pg from "pg";

import { bindCloudAllocationProvider } from "./allocation-provider.js";
import { withSystemTx } from "../db.js";
import { withRetryableSystemTx } from "../db-retry.js";
import {
  CloudWorkspaceProviderRegistry,
  type CloudWorkspaceProviderPurpose,
} from "./provider-registry.js";
import {
  CloudProviderError,
  isSupportedCloudWorkspaceProviderBinding,
  type CloudWorkspaceAccessProvider,
  type CloudWorkspaceProvider,
  type CloudWorkspaceProviderName,
  type CloudWorkspaceCommandRunner,
} from "./provider.js";

export type { CloudWorkspaceProviderPurpose } from "./provider-registry.js";

export type CloudWorkspaceProviderResolution = {
  provider: CloudWorkspaceProvider & CloudWorkspaceAccessProvider;
  connectionId: string;
  connectionVersion: number;
  credentialSource: "hosted" | "delegated";
  commandRunner?: CloudWorkspaceCommandRunner;
};

export type CloudWorkspaceProviderCleanupScope = {
  provider: CloudWorkspaceProvider & CloudWorkspaceAccessProvider;
  /** Hosted deployment credentials are intentionally one global scope. */
  organizationId: string | null;
  connectionId: string | null;
  connectionVersion: number | null;
  credentialSource: "hosted" | "delegated";
};

export interface CloudWorkspaceProviderResolver {
  resolve(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    purpose: CloudWorkspaceProviderPurpose;
  }): Promise<CloudWorkspaceProviderResolution>;
  /** Resolve every exact provider-account scope that may still own a remote
   * resource. Unavailable delegated credentials are counted and skipped so a
   * revoked/missing key can never turn into a cross-account deletion. */
  cleanupScopes?(): Promise<{
    scopes: CloudWorkspaceProviderCleanupScope[];
    unavailable: number;
  }>;
}

type ResolvedRow = {
  connection_id: string;
  org_id: string;
  provider: CloudWorkspaceProviderName;
  owner_kind: "user" | "organization";
  owner_user_id: string | null;
  credential_source: "hosted" | "delegated";
  connection_state: "active" | "revoked" | "invalid";
  capabilities: Record<string, unknown>;
  region: string | null;
  provider_connection_version: string | number;
  endpoint: string;
  version_credential_source: "hosted" | "delegated";
  credential_expires_at: Date | string | null;
  retired_at: Date | string | null;
  owner_user_id_snapshot: string;
  image_ref: string;
  sandbox_class: "container" | "linux-vm" | null;
  architecture: "linux/amd64" | "linux/arm64";
  cpu_millicores: number;
  memory_mib: number;
  storage_mib: number;
  paid_authority_live: boolean;
  policy_authority_live: boolean;
};

function providerFailure(code: string, message: string): CloudProviderError {
  return new CloudProviderError(code, message, false);
}

function safeVersion(value: string | number): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw providerFailure(
      "provider_connection_invalid",
      "Cloud provider connection version is invalid",
    );
  }
  return version;
}

/**
 * Resolves the generation-bound provider identity immediately before remote
 * I/O. Hosted credentials stay in deployment configuration. Unsupported
 * persisted providers and customer credentials fail closed before remote I/O.
 */
export class DatabaseCloudWorkspaceProviderResolver implements CloudWorkspaceProviderResolver {
  private readonly pool: pg.Pool;
  private readonly registry: CloudWorkspaceProviderRegistry;
  private readonly workosEnabled: boolean;

  constructor(input: {
    pool: pg.Pool;
    registry: CloudWorkspaceProviderRegistry;
    workosEnabled: boolean;
  }) {
    this.pool = input.pool;
    this.registry = input.registry;
    this.workosEnabled = input.workosEnabled;

  }

  async resolve(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    purpose: CloudWorkspaceProviderPurpose;
  }): Promise<CloudWorkspaceProviderResolution> {
    const row = await withRetryableSystemTx(this.pool, async (tx) => {
      // Joined row marks do not establish a parent-first acquisition order.
      // Heartbeat owns W before updating G (including an empty ports census),
      // so acquire O -> W explicitly before the generation/connection locks.
      if (!(await tx.query("SELECT 1 FROM organizations WHERE id=$1 FOR SHARE", [input.organizationId])).rowCount)
        return null;
      if (!(await tx.query("SELECT 1 FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR SHARE",
        [input.workspaceId, input.organizationId])).rowCount) return null;
      const result = await tx.query<ResolvedRow>(
        `SELECT connection.id AS connection_id, connection.org_id,
                connection.provider, connection.owner_kind,
                connection.owner_user_id, connection.credential_source,
                connection.state AS connection_state,
                version.capabilities, connection.region,
                generation.provider_connection_version,
                version.endpoint,
                version.credential_source AS version_credential_source,
                version.credential_expires_at, version.retired_at,
                workspace.owner_user_id AS owner_user_id_snapshot,
                generation.image_ref, generation.sandbox_class, generation.architecture,
                generation.cpu_millicores, generation.memory_mib,
                generation.storage_mib,
                cloud_workspace_paid_authority_live(
                  workspace.id, workspace.owner_user_id, $4
                ) AS paid_authority_live,
                cloud_workspace_generation_policy_current(
                  workspace.id, generation.generation, workspace.org_id
                ) AS policy_authority_live
         FROM cloud_workspace_generations generation
         JOIN cloud_workspaces workspace
           ON workspace.id = generation.workspace_id
          AND workspace.org_id = generation.org_id
         JOIN provider_connections connection
           ON connection.id = generation.provider_connection_id
          AND connection.org_id = generation.org_id
          AND connection.provider = generation.provider
         JOIN provider_connection_versions version
           ON version.connection_id = connection.id
          AND version.org_id = connection.org_id
          AND version.version = generation.provider_connection_version
         WHERE generation.workspace_id = $1 AND generation.org_id = $2
           AND generation.generation = $3
         FOR SHARE OF generation, workspace, connection, version`,
        [
          input.workspaceId,
          input.organizationId,
          input.generation,
          this.workosEnabled,
        ],
      );
      return result.rows[0] ?? null;
    });
    if (!row || !this.registry.supports(row.provider)) {
      throw providerFailure(
        "provider_connection_unavailable",
        "Generation-bound cloud provider connection is unavailable",
      );
    }
    if (!isSupportedCloudWorkspaceProviderBinding({ provider: row.provider, credentialSource: row.credential_source, sandboxClass: row.sandbox_class })) {
      throw providerFailure("provider_unsupported", "This generation uses unsupported compute authority");
    }
    const resolved=this.resolveRow(row, input.purpose);
    return {...resolved,provider:bindCloudAllocationProvider(this.pool,resolved.provider,input)};
  }

  private resolveRow(
    row: ResolvedRow,
    purpose: CloudWorkspaceProviderPurpose,
  ): CloudWorkspaceProviderResolution {
    if (!this.registry.supports(row.provider)) {
      throw providerFailure(
        "provider_connection_unavailable",
        "Generation-bound cloud provider connection is unavailable",
      );
    }
    const cleanup = purpose === "cleanup";
    if (
      !cleanup &&
      (!row.paid_authority_live || row.connection_state !== "active")
    ) {
      throw providerFailure(
        "provider_authority_revoked",
        "Cloud provider authority is no longer active",
      );
    }
    if (!cleanup && !row.policy_authority_live) {
      throw providerFailure(
        "managed_policy_changed",
        "Cloud workspace generation does not have the current managed policy",
      );
    }
    if (!cleanup && row.retired_at !== null) {
      throw providerFailure(
        "provider_connection_invalid",
        "Current cloud provider credential version is retired",
      );
    }
    if (
      !cleanup &&
      row.credential_expires_at !== null &&
      new Date(row.credential_expires_at).getTime() <= Date.now() + 5 * 60_000
    ) {
      throw providerFailure(
        "provider_credential_expiring",
        "Cloud provider credential is expired or expires too soon",
      );
    }
    if (
      row.credential_source !== row.version_credential_source ||
      (!cleanup &&
        ((row.owner_kind === "user" &&
          row.owner_user_id !== row.owner_user_id_snapshot) ||
          (row.owner_kind === "organization" && row.owner_user_id !== null)))
    ) {
      throw providerFailure(
        "provider_connection_scope_mismatch",
        "Cloud provider connection ownership does not match the workspace",
      );
    }
    const connectionVersion = safeVersion(row.provider_connection_version);
    if (row.credential_source === "hosted") {
      if (row.endpoint !== `hosted://${row.provider}`) {
        throw providerFailure(
          "provider_connection_invalid",
          "Hosted cloud provider endpoint is invalid",
        );
      }
      return {
        ...this.registry.hosted(row.provider, purpose, {
          imageRef: row.image_ref,
          ...(row.sandbox_class?{sandboxClass:row.sandbox_class}:{}),
          architecture: row.architecture,
          cpuMillicores: row.cpu_millicores,
          memoryMiB: row.memory_mib,
          storageMiB: row.storage_mib,
        }),
        connectionId: row.connection_id,
        connectionVersion,
        credentialSource: "hosted",
      };
    }

    throw providerFailure(
      "provider_connection_unavailable",
      "Customer compute connections are unavailable",
    );
  }

  async cleanupScopes(): Promise<{
    scopes: CloudWorkspaceProviderCleanupScope[];
    unavailable: number;
  }> {
    const unavailable = await withSystemTx(this.pool, async tx => {
      const result = await tx.query<{ count: string }>(`SELECT count(*) AS count
        FROM provider_connections connection
        JOIN provider_connection_versions version
          ON version.connection_id=connection.id AND version.org_id=connection.org_id
        WHERE connection.credential_source='delegated' AND EXISTS (
          SELECT 1 FROM cloud_workspace_generations generation
          WHERE generation.provider_connection_id=connection.id
            AND generation.provider_connection_version=version.version
            AND generation.org_id=connection.org_id AND generation.provider=connection.provider
        )`);
      return Number(result.rows[0]!.count);
    });
    const scopes: CloudWorkspaceProviderCleanupScope[] = this.registry
      .hostedScopes()
      .map(({ provider }) => ({
        provider,
        organizationId: null,
        connectionId: null,
        connectionVersion: null,
        credentialSource: "hosted",
      }));
    return { scopes, unavailable };
  }
}
