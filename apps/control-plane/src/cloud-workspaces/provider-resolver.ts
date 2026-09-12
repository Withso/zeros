import { createHash, timingSafeEqual } from "node:crypto";

import type pg from "pg";

import { withSystemTx } from "../db.js";
import {
  DaytonaWorkspaceProvider,
  type DaytonaWorkspaceProviderConfig,
} from "./daytona-provider.js";
import { openCloudProviderCredential } from "./provider-connections.js";
import type { DaytonaSetupCommandRunner } from "./daytona-setup-executor.js";
import {
  CloudProviderError,
  type CloudWorkspaceAccessProvider,
  type CloudWorkspaceProvider,
} from "./provider.js";

export type CloudWorkspaceProviderPurpose =
  | "lifecycle"
  | "ssh"
  | "preview"
  | "setup"
  | "cleanup";

export type CloudWorkspaceProviderResolution = {
  provider: CloudWorkspaceProvider & CloudWorkspaceAccessProvider;
  connectionId: string;
  connectionVersion: number;
  credentialSource: "hosted" | "delegated";
  commandRunner?: DaytonaSetupCommandRunner;
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

type ProviderFactory = (
  config: DaytonaWorkspaceProviderConfig,
) => CloudWorkspaceProvider & CloudWorkspaceAccessProvider;
type CommandRunnerFactory = (input: {
  apiKey: string;
  apiUrl: string;
}) => DaytonaSetupCommandRunner;

type ResolvedRow = {
  connection_id: string;
  org_id: string;
  provider: "daytona";
  owner_kind: "user" | "organization";
  owner_user_id: string | null;
  credential_source: "hosted" | "delegated";
  connection_state: "active" | "revoked" | "invalid";
  capabilities: Record<string, unknown>;
  region: string | null;
  provider_connection_version: string | number;
  endpoint: string;
  version_credential_source: "hosted" | "delegated";
  key_version: number | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  auth_tag: Buffer | null;
  credential_sha256: Buffer | null;
  credential_expires_at: Date | string | null;
  retired_at: Date | string | null;
  owner_user_id_snapshot: string;
  image_ref: string;
  architecture: "linux/amd64" | "linux/arm64";
  cpu_millicores: number;
  memory_mib: number;
  storage_mib: number;
  paid_authority_live: boolean;
  policy_authority_live: boolean;
};

type CleanupRow = Omit<
  ResolvedRow,
  "owner_user_id_snapshot" | "paid_authority_live" | "policy_authority_live"
> & {
  owner_user_id_snapshot?: never;
  paid_authority_live?: never;
  policy_authority_live?: never;
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

function capability(
  document: Record<string, unknown>,
  name: "lifecycle" | "ssh" | "preview" | "setup",
): boolean {
  const field = name === "setup" ? "commandExecution" : name;
  return document.qualified === true && document[field] === true;
}

function delegatedTarget(
  row: Pick<ResolvedRow, "capabilities" | "region">,
): string {
  const configured = row.capabilities.daytonaTarget;
  const target =
    typeof configured === "string" && configured.length > 0
      ? configured
      : row.region;
  if (!target || !/^[A-Za-z0-9._-]{1,64}$/.test(target)) {
    throw providerFailure(
      "provider_connection_not_qualified",
      "Delegated Daytona connection has no qualified target",
    );
  }
  return target;
}

function sameHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Resolves the generation-bound provider identity immediately before remote
 * I/O. Hosted credentials stay in deployment configuration; delegated
 * credentials are decrypted only in this coordinator boundary and are never
 * returned to routes, renderers, setup payloads, logs, or the sandbox.
 */
export class DatabaseDaytonaProviderResolver
  implements CloudWorkspaceProviderResolver
{
  private readonly pool: pg.Pool;
  private readonly hostedProvider: CloudWorkspaceProvider &
    CloudWorkspaceAccessProvider;
  private readonly hostedConfig: DaytonaWorkspaceProviderConfig;
  private readonly credentialKeys: ReadonlyMap<number, string>;
  private readonly workosEnabled: boolean;
  private readonly providerFactory: ProviderFactory;
  private readonly hostedCommandRunner: DaytonaSetupCommandRunner | null;
  private readonly commandRunnerFactory: CommandRunnerFactory | null;

  constructor(input: {
    pool: pg.Pool;
    hostedProvider: CloudWorkspaceProvider & CloudWorkspaceAccessProvider;
    hostedConfig: DaytonaWorkspaceProviderConfig;
    credentialKeys?: Readonly<Record<number, string>>;
    workosEnabled: boolean;
    providerFactory?: ProviderFactory;
    hostedCommandRunner?: DaytonaSetupCommandRunner;
    commandRunnerFactory?: CommandRunnerFactory;
  }) {
    this.pool = input.pool;
    this.hostedProvider = input.hostedProvider;
    this.hostedConfig = input.hostedConfig;
    this.workosEnabled = input.workosEnabled;
    this.providerFactory =
      input.providerFactory ?? ((config) => new DaytonaWorkspaceProvider(config));
    this.hostedCommandRunner = input.hostedCommandRunner ?? null;
    this.commandRunnerFactory = input.commandRunnerFactory ?? null;
    const keys = new Map<number, string>();
    for (const [rawVersion, encoded] of Object.entries(
      input.credentialKeys ?? {},
    )) {
      const version = Number(rawVersion);
      const decoded = Buffer.from(encoded, "base64url");
      if (
        !Number.isSafeInteger(version) ||
        version < 1 ||
        !/^[A-Za-z0-9_-]{43}$/.test(encoded) ||
        decoded.length !== 32 ||
        decoded.toString("base64url") !== encoded
      ) {
        decoded.fill(0);
        throw new Error("cloud provider credential keyring is invalid");
      }
      decoded.fill(0);
      keys.set(version, encoded);
    }
    this.credentialKeys = keys;
  }

  async resolve(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    purpose: CloudWorkspaceProviderPurpose;
  }): Promise<CloudWorkspaceProviderResolution> {
    const row = await withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<ResolvedRow>(
        `SELECT connection.id AS connection_id, connection.org_id,
                connection.provider, connection.owner_kind,
                connection.owner_user_id, connection.credential_source,
                connection.state AS connection_state,
                version.capabilities, connection.region,
                generation.provider_connection_version,
                version.endpoint,
                version.credential_source AS version_credential_source,
                version.key_version, version.nonce, version.ciphertext,
                version.auth_tag, version.credential_sha256,
                version.credential_expires_at, version.retired_at,
                workspace.owner_user_id AS owner_user_id_snapshot,
                generation.image_ref, generation.architecture,
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
    if (!row || row.provider !== "daytona") {
      throw providerFailure(
        "provider_connection_unavailable",
        "Generation-bound cloud provider connection is unavailable",
      );
    }
    return this.resolveRow(row, input.purpose);
  }

  private resolveRow(
    row: ResolvedRow | CleanupRow,
    purpose: CloudWorkspaceProviderPurpose,
  ): CloudWorkspaceProviderResolution {
    const cleanup = purpose === "cleanup";
    if (!cleanup && (!row.paid_authority_live || row.connection_state !== "active")) {
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
      if (row.endpoint !== "hosted://daytona") {
        throw providerFailure(
          "provider_connection_invalid",
          "Hosted cloud provider endpoint is invalid",
        );
      }
      return {
        provider: this.hostedProvider,
        connectionId: row.connection_id,
        connectionVersion,
        credentialSource: "hosted",
        ...(purpose === "setup"
          ? { commandRunner: this.requireHostedCommandRunner() }
          : {}),
      };
    }

    if (
      !cleanup &&
      !capability(
        row.capabilities,
        purpose as "lifecycle" | "ssh" | "preview" | "setup",
      )
    ) {
      throw providerFailure(
        "provider_connection_not_qualified",
        "Delegated cloud provider connection lacks the requested capability",
      );
    }
    if (
      row.key_version === null ||
      !row.nonce ||
      !row.ciphertext ||
      !row.auth_tag ||
      !row.credential_sha256
    ) {
      throw providerFailure(
        "provider_connection_invalid",
        "Delegated cloud provider credential envelope is incomplete",
      );
    }
    const encodedKey = this.credentialKeys.get(row.key_version);
    if (!encodedKey) {
      throw providerFailure(
        "provider_credential_key_unavailable",
        "Delegated cloud provider credential key is unavailable",
      );
    }
    let credential: string;
    try {
      credential = openCloudProviderCredential(
        {
          keyVersion: row.key_version,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          authTag: row.auth_tag,
        },
        {
          connectionId: row.connection_id,
          organizationId: row.org_id,
          version: connectionVersion,
          provider: row.provider,
          endpoint: row.endpoint,
        },
        encodedKey,
      );
    } catch {
      throw providerFailure(
        "provider_credential_invalid",
        "Delegated cloud provider credential could not be opened",
      );
    }
    if (
      !sameHash(
        createHash("sha256").update(credential, "utf8").digest(),
        row.credential_sha256,
      )
    ) {
      throw providerFailure(
        "provider_credential_invalid",
        "Delegated cloud provider credential integrity check failed",
      );
    }
    const provider = this.providerFactory({
      ...this.hostedConfig,
      apiKey: credential,
      apiUrl: row.endpoint,
      target: delegatedTarget(row),
      snapshotId: row.image_ref,
      architecture: row.architecture,
      cpuMillicores: row.cpu_millicores,
      memoryMiB: row.memory_mib,
      storageMiB: row.storage_mib,
    });
    return {
      provider,
      connectionId: row.connection_id,
      connectionVersion,
      credentialSource: "delegated",
      ...(purpose === "setup"
        ? {
            commandRunner: this.requireDelegatedCommandRunner({
              apiKey: credential,
              apiUrl: row.endpoint,
            }),
          }
        : {}),
    };
  }

  private requireHostedCommandRunner(): DaytonaSetupCommandRunner {
    if (!this.hostedCommandRunner) {
      throw providerFailure(
        "provider_command_not_configured",
        "Hosted cloud provider command execution is unavailable",
      );
    }
    return this.hostedCommandRunner;
  }

  private requireDelegatedCommandRunner(input: {
    apiKey: string;
    apiUrl: string;
  }): DaytonaSetupCommandRunner {
    if (!this.commandRunnerFactory) {
      throw providerFailure(
        "provider_command_not_configured",
        "Delegated cloud provider command execution is unavailable",
      );
    }
    return this.commandRunnerFactory(input);
  }

  async cleanupScopes(): Promise<{
    scopes: CloudWorkspaceProviderCleanupScope[];
    unavailable: number;
  }> {
    const rows = await withSystemTx(this.pool, async (tx) =>
      (
        await tx.query<CleanupRow>(
          `SELECT connection.id AS connection_id, connection.org_id,
                  connection.provider, connection.owner_kind,
                  connection.owner_user_id, connection.credential_source,
                  connection.state AS connection_state,
                  version.capabilities, connection.region,
                  version.version AS provider_connection_version,
                  version.endpoint,
                  version.credential_source AS version_credential_source,
                  version.key_version, version.nonce, version.ciphertext,
                  version.auth_tag, version.credential_sha256,
                  version.credential_expires_at, version.retired_at,
                  $1::text AS image_ref,
                  $2::text AS architecture,
                  $3::integer AS cpu_millicores,
                  $4::integer AS memory_mib,
                  $5::integer AS storage_mib
           FROM provider_connections connection
           JOIN provider_connection_versions version
             ON version.connection_id = connection.id
            AND version.org_id = connection.org_id
           WHERE connection.provider = 'daytona'
             AND connection.credential_source = 'delegated'
             AND EXISTS (
               SELECT 1 FROM cloud_workspace_generations generation
               WHERE generation.provider_connection_id = connection.id
                 AND generation.provider_connection_version = version.version
                 AND generation.org_id = connection.org_id
             )
           ORDER BY connection.id, version.version`,
          [
            this.hostedConfig.snapshotId,
            this.hostedConfig.architecture,
            this.hostedConfig.cpuMillicores,
            this.hostedConfig.memoryMiB,
            this.hostedConfig.storageMiB,
          ],
        )
      ).rows,
    );
    const scopes: CloudWorkspaceProviderCleanupScope[] = [
      {
        provider: this.hostedProvider,
        organizationId: null,
        connectionId: null,
        connectionVersion: null,
        credentialSource: "hosted",
      },
    ];
    let unavailable = 0;
    for (const row of rows) {
      try {
        const resolution = this.resolveRow(row, "cleanup");
        scopes.push({
          provider: resolution.provider,
          organizationId: row.org_id,
          connectionId: resolution.connectionId,
          connectionVersion: resolution.connectionVersion,
          credentialSource: "delegated",
        });
      } catch {
        // Failing closed is intentional: no provider calls are made for an
        // account whose exact historic credential cannot be opened.
        unavailable += 1;
      }
    }
    return { scopes, unavailable };
  }
}

export class StaticCloudWorkspaceProviderResolver
  implements CloudWorkspaceProviderResolver
{
  constructor(
    private readonly provider: CloudWorkspaceProvider &
      CloudWorkspaceAccessProvider,
  ) {}

  async resolve(): Promise<CloudWorkspaceProviderResolution> {
    return {
      provider: this.provider,
      connectionId: "00000000-0000-0000-0000-000000000000",
      connectionVersion: 1,
      credentialSource: "hosted",
    };
  }

  async cleanupScopes(): Promise<{
    scopes: CloudWorkspaceProviderCleanupScope[];
    unavailable: number;
  }> {
    return {
      scopes: [
        {
          provider: this.provider,
          organizationId: null,
          connectionId: null,
          connectionVersion: null,
          credentialSource: "hosted",
        },
      ],
      unavailable: 0,
    };
  }
}
