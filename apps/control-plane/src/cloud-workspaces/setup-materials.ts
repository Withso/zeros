import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import type pg from "pg";

import { audit } from "../audit.js";
import { withSystemTx, type Tx } from "../db.js";
import {
  consumeCloudWorkspaceGrant,
  issueCloudWorkspaceGrant,
  normalizeCloudWorkspaceGrantAudience,
} from "./grants.js";

const SETUP_MATERIALS_AUDIENCE =
  "zeros-cloud-workspace-setup-materials-v1" as const;
const ENGINE_REGISTRATION_AUDIENCE =
  "zeros-cloud-workspace-engine-registration-v1" as const;
const ENGINE_HEARTBEAT_AUDIENCE =
  "zeros-cloud-workspace-engine-heartbeat-v1" as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GRANT_TOKEN_PATTERN = /^zws_[A-Za-z0-9_-]{43}$/;
const HEARTBEAT_TOKEN_PATTERN = /^zwh_[A-Za-z0-9_-]{43}$/;
const REFRESH_GENERATION_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_TOTAL_SECRET_BYTES = 512 * 1024;
const MAX_SETUP_COMMANDS = 32;
const MAX_SETUP_COMMAND_BYTES = 16 * 1024;
const DEFAULT_ENGINE_REGISTRATION_TTL_SECONDS = 3_660;
const ENGINE_HEARTBEAT_LEASE_MS = 90_000;
const ENGINE_HEARTBEAT_INTERVAL_MS = 30_000;
const REPOSITORY_REFRESH_CLAIM_INTERVAL_MS = 5 * 60_000;

export class CloudWorkspaceSetupMaterialError extends Error {
  constructor(
    public readonly code:
      | "setup_admission_rejected"
      | "setup_authority_changed"
      | "setup_settings_invalid"
      | "setup_repository_unavailable"
      | "engine_registration_rejected"
      | "engine_heartbeat_rejected",
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CloudWorkspaceSetupMaterialError";
  }
}

export interface CloudWorkspaceRepositoryCredentialBroker {
  mint(input: {
    installationId: number;
    owner: string;
    repository: string;
  }): Promise<{ token: string; expiresAtMs: number }>;
  revoke(token: string): Promise<void>;
}

export type CloudWorkspaceAccountAuth = {
  jwksUrl: string;
  audience: string;
  issuers: readonly string[];
} & (
  | {
      contract: "zeros-access-v1";
      clientId: string;
    }
  | {
      contract: null;
      clientId: null;
    }
);

export type CloudWorkspaceSetupMaterialServiceOptions = {
  pool: pg.Pool;
  setupAudience: string;
  engineRegistrationAudience: string;
  engineHeartbeatAudience: string;
  engineProtocolVersion: number;
  enginePort: number;
  /** Must outlive the bounded provider setup command. Live setup authority is
   * still rechecked at redemption, so this is only a coarse outer ceiling. */
  engineRegistrationTtlSeconds?: number;
  setupSecretKeyV1: string;
  github: CloudWorkspaceRepositoryCredentialBroker;
  /** Selects the provider subject that the configured engine JWT verifier can
   * actually authenticate. A Zeros account may retain both Auth0 and WorkOS
   * rows during migration; recency is not an authority decision. */
  accountIdentityProvider: "auth0" | "workos";
  accountAuth: CloudWorkspaceAccountAuth;
  now?: () => number;
};

export type CloudWorkspaceSetupRedemptionInput = {
  token: string;
  workspaceId: string;
  organizationId: string;
  generation: number;
  setupRunId: string;
  executionFence: number;
  expected: {
    imageRef: string;
    imageSourceCommit: string;
    repositoryRevision: string;
    settingsVersion: number;
    settingsSha256: string;
  };
};

export type CloudWorkspaceEngineRegistrationInput = {
  token: string;
  workspaceId: string;
  organizationId: string;
  generation: number;
  setupRunId: string;
  executionFence: number;
  engineInstanceId: string;
  protocolVersion: number;
};

export type CloudWorkspaceEngineHeartbeatInput = {
  token: string;
  workspaceId: string;
  organizationId: string;
  generation: number;
  engineInstanceId: string;
  repositoryCredentialRefresh?: {
    generation: string;
    requestedAtMs: number;
    ownerSubjectSha256: string;
    method: "github-app";
    reason: "credential-invalid";
  };
};

type SetupCommand = { command: string; timeoutSeconds: number };
type SecretReference = { id: string; name: string };
type ParsedSettings = {
  document: Readonly<Record<string, unknown>>;
  secretRefs: readonly SecretReference[];
  setupCommands: readonly SetupCommand[];
};

type RedemptionContract = {
  accountUserId: string;
  ownerSubject: string;
  imageRef: string;
  imageSourceCommit: string;
  repository: {
    forge: "github.com";
    owner: string;
    name: string;
    revision: string;
    installationRowId: string;
    installationId: number;
  };
  settingsVersion: number;
  settingsSha256: string;
  settingsText: string;
  secretRows: Array<{
    id: string;
    name: string;
    key_version: number;
    nonce: Buffer;
    ciphertext: Buffer;
    auth_tag: Buffer;
  }>;
  engineInstanceId: string;
  bridgeToken: string;
  readinessProbeToken: string;
  registrationGrant: {
    id: string;
    token: string;
    expiresAt: Date;
  };
};

function materialError(
  code: CloudWorkspaceSetupMaterialError["code"],
  retryable: boolean,
): CloudWorkspaceSetupMaterialError {
  return new CloudWorkspaceSetupMaterialError(
    code,
    "Cloud workspace setup material request was not accepted",
    retryable,
  );
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !/[\0\r\n]/.test(value)
  );
}

function validPositiveInteger(
  value: unknown,
  maximum = 2_147_483_647,
): boolean {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= maximum
  );
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function randomCapability(prefix: "zwb_" | "zwr_" | "zwh_"): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function secretKey(raw: string): Buffer {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw)) {
    throw new Error(
      "cloud workspace setup secret key must be 32-byte base64url",
    );
  }
  const key = Buffer.from(raw, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== raw) {
    key.fill(0);
    throw new Error(
      "cloud workspace setup secret key must be canonical base64url",
    );
  }
  return key;
}

function secretAad(binding: {
  id: string;
  workspaceId: string;
  organizationId: string;
  generation: number;
  name: string;
}): Buffer {
  return Buffer.from(
    [
      "zeros-cloud-workspace-setup-secret-v1",
      binding.organizationId,
      binding.workspaceId,
      String(binding.generation),
      binding.id,
      binding.name,
    ].join("\0"),
    "utf8",
  );
}

export function sealCloudWorkspaceSetupSecret(
  value: string,
  binding: {
    id: string;
    workspaceId: string;
    organizationId: string;
    generation: number;
    name: string;
  },
  encodedKey: string,
): { nonce: Buffer; ciphertext: Buffer; authTag: Buffer } {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES ||
    value.includes("\0") ||
    !UUID_PATTERN.test(binding.id) ||
    !UUID_PATTERN.test(binding.workspaceId) ||
    !UUID_PATTERN.test(binding.organizationId) ||
    !validPositiveInteger(binding.generation) ||
    !safeSetupEnvironmentName(binding.name)
  ) {
    throw new Error("cloud workspace setup secret input is invalid");
  }
  const key = secretKey(encodedKey);
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(secretAad(binding));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return { nonce, ciphertext, authTag: cipher.getAuthTag() };
  } finally {
    key.fill(0);
  }
}

function openSetupSecret(
  row: RedemptionContract["secretRows"][number],
  binding: {
    workspaceId: string;
    organizationId: string;
    generation: number;
  },
  encodedKey: string,
): string {
  if (
    row.key_version !== 1 ||
    row.nonce.length !== 12 ||
    row.auth_tag.length !== 16 ||
    row.ciphertext.length < 1 ||
    row.ciphertext.length > MAX_SECRET_BYTES
  ) {
    throw materialError("setup_settings_invalid", false);
  }
  const key = secretKey(encodedKey);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, row.nonce);
    decipher.setAAD(
      secretAad({
        id: row.id,
        workspaceId: binding.workspaceId,
        organizationId: binding.organizationId,
        generation: binding.generation,
        name: row.name,
      }),
    );
    decipher.setAuthTag(row.auth_tag);
    const value = Buffer.concat([
      decipher.update(row.ciphertext),
      decipher.final(),
    ]).toString("utf8");
    if (
      Buffer.byteLength(value, "utf8") < 1 ||
      Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES ||
      value.includes("\0")
    ) {
      throw materialError("setup_settings_invalid", false);
    }
    return value;
  } catch (error) {
    if (error instanceof CloudWorkspaceSetupMaterialError) throw error;
    throw materialError("setup_settings_invalid", false);
  } finally {
    key.fill(0);
  }
}

function safeSetupEnvironmentName(name: string): boolean {
  return (
    ENV_NAME_PATTERN.test(name) &&
    !name.startsWith("ZEROS_") &&
    !name.startsWith("CONDUCTOR_") &&
    !name.startsWith("LD_") &&
    !name.startsWith("DYLD_") &&
    !name.startsWith("GIT_") &&
    ![
      "BASH_ENV",
      "ENV",
      "HOME",
      "PATH",
      "NODE_OPTIONS",
      "NODE_PATH",
      "PYTHONSTARTUP",
      "RUBYOPT",
      "PERL5OPT",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ].includes(name)
  );
}

function assertJsonValue(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): void {
  state.nodes += 1;
  if (depth > 32 || state.nodes > 20_000) {
    throw materialError("setup_settings_invalid", false);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "string"
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertJsonValue(entry, state, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) throw materialError("setup_settings_invalid", false);
  for (const [key, entry] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw materialError("setup_settings_invalid", false);
    }
    assertJsonValue(entry, state, depth + 1);
  }
}

function parseSettings(source: string): ParsedSettings {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source, "utf8") < 2 ||
    Buffer.byteLength(source, "utf8") > MAX_SETTINGS_BYTES
  ) {
    throw materialError("setup_settings_invalid", false);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw materialError("setup_settings_invalid", false);
  }
  if (!isRecord(parsed)) throw materialError("setup_settings_invalid", false);
  const keys = [
    "schemaVersion",
    "values",
    ...(parsed.secretRefs === undefined ? [] : ["secretRefs"]),
    ...(parsed.setupCommands === undefined ? [] : ["setupCommands"]),
  ];
  if (
    !exactKeys(parsed, keys) ||
    parsed.schemaVersion !== 1 ||
    !isRecord(parsed.values)
  ) {
    throw materialError("setup_settings_invalid", false);
  }
  assertJsonValue(parsed.values, { nodes: 0 });

  const rawRefs = parsed.secretRefs ?? [];
  if (!Array.isArray(rawRefs) || rawRefs.length > 128) {
    throw materialError("setup_settings_invalid", false);
  }
  const secretRefs: SecretReference[] = rawRefs.map((entry) => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["id", "name"]) ||
      typeof entry.id !== "string" ||
      !UUID_PATTERN.test(entry.id) ||
      typeof entry.name !== "string" ||
      !safeSetupEnvironmentName(entry.name)
    ) {
      throw materialError("setup_settings_invalid", false);
    }
    return { id: entry.id, name: entry.name };
  });
  if (
    new Set(secretRefs.map((entry) => entry.id)).size !== secretRefs.length ||
    new Set(secretRefs.map((entry) => entry.name)).size !== secretRefs.length
  ) {
    throw materialError("setup_settings_invalid", false);
  }

  const rawCommands = parsed.setupCommands ?? [];
  if (!Array.isArray(rawCommands) || rawCommands.length > MAX_SETUP_COMMANDS) {
    throw materialError("setup_settings_invalid", false);
  }
  const setupCommands: SetupCommand[] = rawCommands.map((entry) => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["command", "timeoutSeconds"]) ||
      typeof entry.command !== "string" ||
      entry.command.trim().length < 1 ||
      entry.command.includes("\0") ||
      Buffer.byteLength(entry.command, "utf8") > MAX_SETUP_COMMAND_BYTES ||
      !validPositiveInteger(entry.timeoutSeconds, 900)
    ) {
      throw materialError("setup_settings_invalid", false);
    }
    return {
      command: entry.command,
      timeoutSeconds: Number(entry.timeoutSeconds),
    };
  });
  return { document: parsed, secretRefs, setupCommands };
}

function validateRedemptionInput(
  input: CloudWorkspaceSetupRedemptionInput,
): void {
  if (
    !GRANT_TOKEN_PATTERN.test(input.token) ||
    !UUID_PATTERN.test(input.workspaceId) ||
    !UUID_PATTERN.test(input.organizationId) ||
    !UUID_PATTERN.test(input.setupRunId) ||
    !validPositiveInteger(input.generation) ||
    !validPositiveInteger(input.executionFence, Number.MAX_SAFE_INTEGER) ||
    !safeString(input.expected.imageRef, 1024) ||
    !COMMIT_PATTERN.test(input.expected.imageSourceCommit) ||
    !safeString(input.expected.repositoryRevision, 512) ||
    !validPositiveInteger(input.expected.settingsVersion) ||
    !SHA256_PATTERN.test(input.expected.settingsSha256)
  ) {
    throw materialError("setup_admission_rejected", false);
  }
}

function contractMatchesExpected(
  row: {
    image_ref: string;
    image_source_commit: string | null;
    repository_revision: string;
    settings_version: number;
    settings_sha256: string;
  },
  expected: CloudWorkspaceSetupRedemptionInput["expected"],
): boolean {
  return (
    row.image_ref === expected.imageRef &&
    row.image_source_commit === expected.imageSourceCommit &&
    row.repository_revision === expected.repositoryRevision &&
    row.settings_version === expected.settingsVersion &&
    row.settings_sha256 === expected.settingsSha256
  );
}

async function accountForGrant(
  tx: Tx,
  input:
    | CloudWorkspaceSetupRedemptionInput
    | CloudWorkspaceEngineRegistrationInput,
  audience: string,
): Promise<string | null> {
  const result = await tx.query<{ account_user_id: string }>(
    `SELECT account_user_id
     FROM cloud_workspace_endpoint_grants
     WHERE token_hash = $1 AND workspace_id = $2 AND generation = $3
       AND org_id = $4 AND purpose = 'setup' AND audience = $5
       AND setup_run_id = $6 AND setup_execution_fence = $7
       AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > now()`,
    [
      tokenHash(input.token),
      input.workspaceId,
      input.generation,
      input.organizationId,
      audience,
      input.setupRunId,
      input.executionFence,
    ],
  );
  return result.rows[0]?.account_user_id ?? null;
}

async function lockLiveSetupAuthority(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    setupRunId: string;
    executionFence: number;
    accountUserId: string;
  },
): Promise<boolean> {
  const workspace = await tx.query(
    `SELECT 1
     FROM cloud_workspaces cw
     JOIN organizations organization
       ON organization.id = cw.org_id AND organization.deleted_at IS NULL
     JOIN teams team
       ON team.id = cw.team_id AND team.org_id = cw.org_id
      AND team.deleted_at IS NULL
     JOIN organization_members om
       ON om.org_id = cw.org_id AND om.user_id = $4
     JOIN team_members tm
       ON tm.team_id = cw.team_id AND tm.org_id = cw.org_id
      AND tm.user_id = $4
     JOIN users account
       ON account.id = $4 AND account.deleted_at IS NULL
     JOIN cloud_workspace_provider_bindings pb
       ON pb.workspace_id = cw.id AND pb.generation = cw.current_generation
      AND pb.org_id = cw.org_id
     WHERE cw.id = $1 AND cw.org_id = $2 AND cw.current_generation = $3
       AND cw.desired_state = 'running' AND cw.status = 'setting_up'
       AND cw.deleted_at IS NULL AND pb.observed_state = 'running'
       AND pb.provider_resource_id IS NOT NULL
     FOR UPDATE OF cw`,
    [
      input.workspaceId,
      input.organizationId,
      input.generation,
      input.accountUserId,
    ],
  );
  if ((workspace.rowCount ?? 0) !== 1) return false;
  const setup = await tx.query(
    `SELECT 1 FROM cloud_workspace_setup_runs
     WHERE id = $1 AND workspace_id = $2 AND org_id = $3 AND generation = $4
       AND execution_fence = $5 AND state = 'running'
       AND lease_expires_at > now()
     FOR UPDATE`,
    [
      input.setupRunId,
      input.workspaceId,
      input.organizationId,
      input.generation,
      input.executionFence,
    ],
  );
  return (setup.rowCount ?? 0) === 1;
}

async function cleanupEngineStart(
  pool: pg.Pool,
  input: { engineInstanceId: string; registrationGrantId: string },
): Promise<void> {
  await withSystemTx(pool, async (tx) => {
    await tx.query(
      `UPDATE cloud_workspace_endpoint_grants
       SET revoked_at = coalesce(revoked_at, now())
       WHERE id = $1`,
      [input.registrationGrantId],
    );
    await tx.query(
      `UPDATE cloud_workspace_engine_instances
       SET state = 'revoked', revoked_at = coalesce(revoked_at, now()),
           updated_at = now()
       WHERE id = $1 AND state IN ('starting', 'ready')`,
      [input.engineInstanceId],
    );
  });
}

export class DatabaseCloudWorkspaceSetupMaterialService {
  private readonly pool: pg.Pool;
  private readonly setupAudience: string;
  private readonly engineRegistrationAudience: string;
  private readonly engineHeartbeatAudience: string;
  private readonly engineProtocolVersion: number;
  private readonly enginePort: number;
  private readonly engineRegistrationTtlSeconds: number;
  private readonly setupSecretKeyV1: string;
  private readonly github: CloudWorkspaceRepositoryCredentialBroker;
  private readonly accountIdentityProvider: "auth0" | "workos";
  private readonly accountAuth: CloudWorkspaceSetupMaterialServiceOptions["accountAuth"];
  private readonly now: () => number;

  constructor(options: CloudWorkspaceSetupMaterialServiceOptions) {
    this.pool = options.pool;
    this.setupAudience = normalizeCloudWorkspaceGrantAudience(
      options.setupAudience,
    );
    this.engineRegistrationAudience = normalizeCloudWorkspaceGrantAudience(
      options.engineRegistrationAudience,
    );
    this.engineHeartbeatAudience = normalizeCloudWorkspaceGrantAudience(
      options.engineHeartbeatAudience,
    );
    if (
      !validPositiveInteger(options.engineProtocolVersion, 65_535) ||
      !validPositiveInteger(options.enginePort, 65_535) ||
      options.enginePort === 22_222 ||
      !validPositiveInteger(
        options.engineRegistrationTtlSeconds ??
          DEFAULT_ENGINE_REGISTRATION_TTL_SECONDS,
        7_200,
      ) ||
      (options.engineRegistrationTtlSeconds ??
        DEFAULT_ENGINE_REGISTRATION_TTL_SECONDS) < 60 ||
      !safeString(options.accountAuth.jwksUrl, 4096) ||
      !safeString(options.accountAuth.audience, 512) ||
      options.accountAuth.issuers.length < 1 ||
      options.accountAuth.issuers.length > 8 ||
      options.accountAuth.issuers.some(
        (issuer) => !safeString(issuer, 4096) || issuer.includes(","),
      ) ||
      !["auth0", "workos"].includes(options.accountIdentityProvider) ||
      !(
        (options.accountAuth.contract === null &&
          options.accountAuth.clientId === null) ||
        (options.accountAuth.contract === "zeros-access-v1" &&
          safeString(options.accountAuth.clientId, 512) &&
          options.accountAuth.issuers.length === 1)
      )
    ) {
      throw new Error("cloud workspace setup material options are invalid");
    }
    for (const rawUrl of [
      options.accountAuth.jwksUrl,
      ...options.accountAuth.issuers,
    ]) {
      const url = new URL(rawUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error("cloud workspace account authority must use HTTPS");
      }
    }
    const parsedKey = secretKey(options.setupSecretKeyV1);
    parsedKey.fill(0);
    this.engineProtocolVersion = options.engineProtocolVersion;
    this.enginePort = options.enginePort;
    this.engineRegistrationTtlSeconds =
      options.engineRegistrationTtlSeconds ??
      DEFAULT_ENGINE_REGISTRATION_TTL_SECONDS;
    this.setupSecretKeyV1 = options.setupSecretKeyV1;
    this.github = options.github;
    this.accountIdentityProvider = options.accountIdentityProvider;
    const accountAuthBase = {
      jwksUrl: options.accountAuth.jwksUrl,
      audience: options.accountAuth.audience,
      issuers: [...options.accountAuth.issuers],
    };
    this.accountAuth =
      options.accountAuth.contract === "zeros-access-v1"
        ? {
            ...accountAuthBase,
            contract: options.accountAuth.contract,
            clientId: options.accountAuth.clientId,
          }
        : { ...accountAuthBase, contract: null, clientId: null };
    this.now = options.now ?? Date.now;
  }

  async redeem(input: CloudWorkspaceSetupRedemptionInput) {
    validateRedemptionInput(input);
    const engineInstanceId = randomUUID();
    const bridgeToken = randomCapability("zwb_");
    const readinessProbeToken = randomCapability("zwr_");

    const contract = await withSystemTx(this.pool, async (tx) => {
      const accountUserId = await accountForGrant(
        tx,
        input,
        this.setupAudience,
      );
      if (!accountUserId)
        throw materialError("setup_admission_rejected", false);
      if (
        !(await lockLiveSetupAuthority(tx, {
          ...input,
          accountUserId,
        }))
      ) {
        throw materialError("setup_admission_rejected", false);
      }

      const grant = await tx.query(
        `SELECT 1 FROM cloud_workspace_endpoint_grants
         WHERE token_hash = $1 AND workspace_id = $2 AND generation = $3
           AND org_id = $4 AND account_user_id = $5 AND purpose = 'setup'
           AND audience = $6 AND setup_run_id = $7
           AND setup_execution_fence = $8 AND revoked_at IS NULL
           AND consumed_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [
          tokenHash(input.token),
          input.workspaceId,
          input.generation,
          input.organizationId,
          accountUserId,
          this.setupAudience,
          input.setupRunId,
          input.executionFence,
        ],
      );
      if ((grant.rowCount ?? 0) !== 1) {
        throw materialError("setup_admission_rejected", false);
      }

      const loaded = await tx.query<{
        image_ref: string;
        image_source_commit: string | null;
        repository_forge: string;
        repository_owner: string;
        repository_name: string;
        repository_revision: string;
        github_installation_id: string | null;
        settings_version: number;
        settings_sha256: string;
        settings_text: string;
        numeric_installation_id: string | number | null;
        installation_variant: string | null;
        installation_account_login: string | null;
        installation_suspended_at: Date | null;
        installation_owner_user_id: string | null;
        installation_org_id: string | null;
        owner_subject: string | null;
      }>(
        `SELECT g.image_ref, g.source_commit AS image_source_commit,
                ss.repository_forge, ss.repository_owner,
                ss.repository_name, ss.repository_revision,
                ss.github_installation_id, ss.spec_version AS settings_version,
                encode(ss.settings_snapshot_sha256, 'hex') AS settings_sha256,
                ss.settings_snapshot::text AS settings_text,
                gi.github_installation_id AS numeric_installation_id,
                gi.app_variant AS installation_variant,
                gi.account_login AS installation_account_login,
                gi.suspended_at AS installation_suspended_at,
                gi.owner_user_id AS installation_owner_user_id,
                gi.org_id AS installation_org_id,
                identity.provider_sub AS owner_subject
         FROM cloud_workspace_generations g
         JOIN cloud_workspace_setup_specs ss
           ON ss.workspace_id = g.workspace_id
          AND ss.generation = g.generation AND ss.org_id = g.org_id
         LEFT JOIN github_installations gi ON gi.id = ss.github_installation_id
         LEFT JOIN LATERAL (
           SELECT ui.provider_sub
           FROM user_identities ui
           WHERE ui.user_id = $4 AND ui.provider = $5
           ORDER BY ui.created_at DESC, ui.id DESC
           LIMIT 1
         ) identity ON true
         WHERE g.workspace_id = $1 AND g.generation = $2 AND g.org_id = $3`,
        [
          input.workspaceId,
          input.generation,
          input.organizationId,
          accountUserId,
          this.accountIdentityProvider,
        ],
      );
      const row = loaded.rows[0];
      if (
        !row ||
        !contractMatchesExpected(row, input.expected) ||
        row.repository_forge !== "github.com" ||
        !REPOSITORY_NAME_PATTERN.test(row.repository_owner) ||
        !REPOSITORY_NAME_PATTERN.test(row.repository_name) ||
        !row.github_installation_id ||
        !validPositiveInteger(Number(row.numeric_installation_id)) ||
        row.installation_variant !== "github.com" ||
        row.installation_account_login?.toLowerCase() !==
          row.repository_owner.toLowerCase() ||
        row.installation_suspended_at !== null ||
        !row.owner_subject ||
        !safeString(row.owner_subject, 512) ||
        !(
          row.installation_org_id === input.organizationId ||
          row.installation_owner_user_id === accountUserId
        )
      ) {
        throw materialError("setup_admission_rejected", false);
      }
      if (row.installation_owner_user_id === accountUserId) {
        const authorization = await tx.query(
          `SELECT 1 FROM github_authorizations
           WHERE owner_user_id = $1 AND app_variant = 'github.com'`,
          [accountUserId],
        );
        if ((authorization.rowCount ?? 0) !== 1) {
          throw materialError("setup_admission_rejected", false);
        }
      }

      const consumed = await consumeCloudWorkspaceGrant(tx, {
        token: input.token,
        workspaceId: input.workspaceId,
        generation: input.generation,
        organizationId: input.organizationId,
        accountUserId,
        purpose: "setup",
        setup: {
          setupRunId: input.setupRunId,
          executionFence: input.executionFence,
        },
        audience: this.setupAudience,
      });
      if (!consumed) throw materialError("setup_admission_rejected", false);

      const secretRows = await tx.query<
        RedemptionContract["secretRows"][number]
      >(
        `SELECT id, name, key_version, nonce, ciphertext, auth_tag
         FROM cloud_workspace_setup_secrets
         WHERE workspace_id = $1 AND generation = $2 AND org_id = $3
         ORDER BY name, id`,
        [input.workspaceId, input.generation, input.organizationId],
      );

      const registrationGrant = await issueCloudWorkspaceGrant(tx, {
        workspaceId: input.workspaceId,
        generation: input.generation,
        organizationId: input.organizationId,
        accountUserId,
        purpose: "setup",
        setup: {
          setupRunId: input.setupRunId,
          executionFence: input.executionFence,
        },
        audience: this.engineRegistrationAudience,
        ttlSeconds: this.engineRegistrationTtlSeconds,
        issuedBy: null,
      });
      await tx.query(
        `UPDATE cloud_workspace_engine_instances
         SET state = 'superseded', revoked_at = coalesce(revoked_at, now()),
             updated_at = now()
         WHERE workspace_id = $1 AND generation = $2 AND org_id = $3
           AND state IN ('starting', 'ready')`,
        [input.workspaceId, input.generation, input.organizationId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_engine_instances (
           id, workspace_id, generation, org_id, account_user_id,
           setup_run_id, setup_execution_fence, registration_grant_id,
           protocol_version, state, bridge_token_hash
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'starting', $10)`,
        [
          engineInstanceId,
          input.workspaceId,
          input.generation,
          input.organizationId,
          accountUserId,
          input.setupRunId,
          input.executionFence,
          registrationGrant.id,
          this.engineProtocolVersion,
          tokenHash(bridgeToken),
        ],
      );
      await audit(
        tx,
        input.organizationId,
        null,
        "cloud_workspace.setup_materials_redeemed",
        {
          workspaceId: input.workspaceId,
          generation: input.generation,
          setupRunId: input.setupRunId,
          executionFence: input.executionFence,
          engineInstanceId,
          registrationGrantId: registrationGrant.id,
          secretCount: secretRows.rows.length,
        },
      );
      return {
        accountUserId,
        ownerSubject: row.owner_subject,
        imageRef: row.image_ref,
        imageSourceCommit: row.image_source_commit!,
        repository: {
          forge: "github.com",
          owner: row.repository_owner,
          name: row.repository_name,
          revision: row.repository_revision,
          installationRowId: row.github_installation_id,
          installationId: Number(row.numeric_installation_id),
        },
        settingsVersion: row.settings_version,
        settingsSha256: row.settings_sha256,
        settingsText: row.settings_text,
        secretRows: secretRows.rows,
        engineInstanceId,
        bridgeToken,
        readinessProbeToken,
        registrationGrant: {
          id: registrationGrant.id,
          token: registrationGrant.token,
          expiresAt: registrationGrant.expiresAt,
        },
      } satisfies RedemptionContract;
    });

    let settings: ParsedSettings;
    let setupEnvironment: Array<{ name: string; value: string }>;
    try {
      settings = parseSettings(contract.settingsText);
      const byIdentity = new Map(
        contract.secretRows.map((row) => [`${row.id}\0${row.name}`, row]),
      );
      const totalSecretBytes = contract.secretRows.reduce(
        (total, row) => total + row.ciphertext.length,
        0,
      );
      if (
        byIdentity.size !== settings.secretRefs.length ||
        totalSecretBytes > MAX_TOTAL_SECRET_BYTES
      ) {
        throw materialError("setup_settings_invalid", false);
      }
      setupEnvironment = settings.secretRefs.map((reference) => {
        const row = byIdentity.get(`${reference.id}\0${reference.name}`);
        if (!row) throw materialError("setup_settings_invalid", false);
        return {
          name: reference.name,
          value: openSetupSecret(
            row,
            {
              workspaceId: input.workspaceId,
              organizationId: input.organizationId,
              generation: input.generation,
            },
            this.setupSecretKeyV1,
          ),
        };
      });
    } catch (error) {
      await cleanupEngineStart(this.pool, {
        engineInstanceId,
        registrationGrantId: contract.registrationGrant.id,
      });
      if (error instanceof CloudWorkspaceSetupMaterialError) throw error;
      throw materialError("setup_settings_invalid", false);
    }

    let repositoryCredential: {
      token: string;
      expiresAtMs: number;
    } | null = null;
    const retireMintedCredential = async (token: unknown): Promise<void> => {
      await Promise.allSettled([
        ...(safeString(token, 4096)
          ? [Promise.resolve().then(() => this.github.revoke(token))]
          : []),
        cleanupEngineStart(this.pool, {
          engineInstanceId,
          registrationGrantId: contract.registrationGrant.id,
        }),
      ]);
    };
    try {
      repositoryCredential = await this.github.mint({
        installationId: contract.repository.installationId,
        owner: contract.repository.owner,
        repository: contract.repository.name,
      });
      const now = this.now();
      if (
        !safeString(repositoryCredential.token, 4096) ||
        !Number.isSafeInteger(repositoryCredential.expiresAtMs) ||
        repositoryCredential.expiresAtMs - now < 5 * 60_000 ||
        repositoryCredential.expiresAtMs - now > 70 * 60_000
      ) {
        throw new Error("invalid repository credential");
      }
    } catch {
      await retireMintedCredential(repositoryCredential?.token);
      throw materialError("setup_repository_unavailable", true);
    }
    if (!repositoryCredential) {
      throw materialError("setup_repository_unavailable", true);
    }

    let stillAuthorized: boolean;
    try {
      stillAuthorized = await withSystemTx(this.pool, async (tx) => {
        if (
          !(await lockLiveSetupAuthority(tx, {
            ...input,
            accountUserId: contract.accountUserId,
          }))
        ) {
          return false;
        }
        const current = await tx.query(
          `SELECT 1
           FROM cloud_workspace_engine_instances ei
           JOIN cloud_workspace_endpoint_grants eg
             ON eg.id = ei.registration_grant_id
           JOIN cloud_workspace_setup_specs ss
             ON ss.workspace_id = ei.workspace_id
            AND ss.generation = ei.generation AND ss.org_id = ei.org_id
           JOIN github_installations gi ON gi.id = ss.github_installation_id
           LEFT JOIN github_authorizations ga
             ON ga.owner_user_id = gi.owner_user_id
            AND ga.app_variant = gi.app_variant
           WHERE ei.id = $1 AND ei.workspace_id = $2 AND ei.generation = $3
             AND ei.org_id = $4 AND ei.state = 'starting'
             AND ei.setup_run_id = $5 AND ei.setup_execution_fence = $6
             AND eg.revoked_at IS NULL AND eg.consumed_at IS NULL
             AND eg.expires_at > now() AND gi.suspended_at IS NULL
             AND gi.app_variant = 'github.com'
             AND lower(gi.account_login) = lower(ss.repository_owner)
             AND (gi.org_id = $4 OR (gi.owner_user_id = $7 AND ga.owner_user_id IS NOT NULL))
           FOR UPDATE OF ei`,
          [
            engineInstanceId,
            input.workspaceId,
            input.generation,
            input.organizationId,
            input.setupRunId,
            input.executionFence,
            contract.accountUserId,
          ],
        );
        return (current.rowCount ?? 0) === 1;
      });
    } catch {
      await retireMintedCredential(repositoryCredential.token);
      throw materialError("setup_repository_unavailable", true);
    }
    if (!stillAuthorized) {
      await retireMintedCredential(repositoryCredential.token);
      throw materialError("setup_authority_changed", false);
    }

    const settingsBytes = Buffer.from(
      JSON.stringify(settings.document),
      "utf8",
    );
    return {
      version: 1 as const,
      audience: SETUP_MATERIALS_AUDIENCE,
      execution: {
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        generation: input.generation,
        setupRunId: input.setupRunId,
        executionFence: input.executionFence,
      },
      image: {
        ref: contract.imageRef,
        sourceCommit: contract.imageSourceCommit,
      },
      repository: {
        forge: contract.repository.forge,
        owner: contract.repository.owner,
        name: contract.repository.name,
        revision: contract.repository.revision,
        cloneUrl: `https://github.com/${contract.repository.owner}/${contract.repository.name}.git`,
        credential: {
          username: "x-access-token" as const,
          token: repositoryCredential.token,
          expiresAtMs: repositoryCredential.expiresAtMs,
        },
      },
      settings: {
        version: contract.settingsVersion,
        snapshotSha256: contract.settingsSha256,
        documentB64: settingsBytes.toString("base64url"),
        documentSha256: createHash("sha256")
          .update(settingsBytes)
          .digest("hex"),
        setupEnvironment,
        setupCommands: settings.setupCommands,
      },
      engine: {
        instanceId: engineInstanceId,
        protocolVersion: this.engineProtocolVersion,
        port: this.enginePort,
        bridgeToken,
        readinessProbeToken,
        ownerSubject: contract.ownerSubject,
        accountAuth: this.accountAuth,
        registration: {
          endpoint: this.engineRegistrationAudience,
          token: contract.registrationGrant.token,
          expiresAtMs: contract.registrationGrant.expiresAt.getTime(),
        },
      },
    };
  }

  async registerEngine(input: CloudWorkspaceEngineRegistrationInput) {
    if (
      !GRANT_TOKEN_PATTERN.test(input.token) ||
      !UUID_PATTERN.test(input.workspaceId) ||
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.setupRunId) ||
      !UUID_PATTERN.test(input.engineInstanceId) ||
      !validPositiveInteger(input.generation) ||
      !validPositiveInteger(input.executionFence, Number.MAX_SAFE_INTEGER) ||
      input.protocolVersion !== this.engineProtocolVersion
    ) {
      throw materialError("engine_registration_rejected", false);
    }
    const heartbeatToken = randomCapability("zwh_");
    return withSystemTx(this.pool, async (tx) => {
      const accountUserId = await accountForGrant(
        tx,
        input,
        this.engineRegistrationAudience,
      );
      if (
        !accountUserId ||
        !(await lockLiveSetupAuthority(tx, { ...input, accountUserId }))
      ) {
        throw materialError("engine_registration_rejected", false);
      }
      const consumed = await consumeCloudWorkspaceGrant(tx, {
        token: input.token,
        workspaceId: input.workspaceId,
        generation: input.generation,
        organizationId: input.organizationId,
        accountUserId,
        purpose: "setup",
        setup: {
          setupRunId: input.setupRunId,
          executionFence: input.executionFence,
        },
        audience: this.engineRegistrationAudience,
      });
      if (!consumed) {
        throw materialError("engine_registration_rejected", false);
      }
      // Membership/lifecycle retirement locks endpoint grants before engine
      // instances. Consume the one-use registration grant first, then lock the
      // exact engine carrying that grant so boot cannot invert that order.
      const instance = await tx.query(
        `SELECT 1
         FROM cloud_workspace_engine_instances
         WHERE id = $1 AND workspace_id = $2 AND generation = $3
           AND org_id = $4 AND account_user_id = $5
           AND setup_run_id = $6 AND setup_execution_fence = $7
           AND protocol_version = $8 AND state = 'starting'
           AND registration_grant_id = $9
         FOR UPDATE`,
        [
          input.engineInstanceId,
          input.workspaceId,
          input.generation,
          input.organizationId,
          accountUserId,
          input.setupRunId,
          input.executionFence,
          input.protocolVersion,
          consumed.id,
        ],
      );
      if ((instance.rowCount ?? 0) !== 1) {
        throw materialError("engine_registration_rejected", false);
      }
      const updated = await tx.query<{ lease_expires_at: Date }>(
        `UPDATE cloud_workspace_engine_instances
         SET state = 'ready', heartbeat_token_hash = $2,
             registered_at = now(), last_heartbeat_at = now(),
             lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
             updated_at = now()
         WHERE id = $1 AND state = 'starting'
         RETURNING lease_expires_at`,
        [
          input.engineInstanceId,
          tokenHash(heartbeatToken),
          ENGINE_HEARTBEAT_LEASE_MS,
        ],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw materialError("engine_registration_rejected", false);
      }
      await audit(
        tx,
        input.organizationId,
        null,
        "cloud_workspace.engine_registered",
        {
          workspaceId: input.workspaceId,
          generation: input.generation,
          setupRunId: input.setupRunId,
          executionFence: input.executionFence,
          engineInstanceId: input.engineInstanceId,
          protocolVersion: input.protocolVersion,
        },
      );
      return {
        version: 1 as const,
        audience: ENGINE_REGISTRATION_AUDIENCE,
        engineInstanceId: input.engineInstanceId,
        durableRecordConnected: true as const,
        leaseExpiresAtMs: updated.rows[0]!.lease_expires_at.getTime(),
        heartbeat: {
          endpoint: this.engineHeartbeatAudience,
          token: heartbeatToken,
          intervalMs: ENGINE_HEARTBEAT_INTERVAL_MS,
        },
      };
    });
  }

  async heartbeat(input: CloudWorkspaceEngineHeartbeatInput) {
    const refresh = input.repositoryCredentialRefresh;
    const requestNow = this.now();
    if (
      !HEARTBEAT_TOKEN_PATTERN.test(input.token) ||
      !UUID_PATTERN.test(input.workspaceId) ||
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.engineInstanceId) ||
      !validPositiveInteger(input.generation) ||
      (refresh !== undefined &&
        (!REFRESH_GENERATION_PATTERN.test(refresh.generation) ||
          !Number.isSafeInteger(refresh.requestedAtMs) ||
          refresh.requestedAtMs > requestNow + 30_000 ||
          refresh.requestedAtMs < 1 ||
          !SHA256_PATTERN.test(refresh.ownerSubjectSha256) ||
          refresh.method !== "github-app" ||
          refresh.reason !== "credential-invalid"))
    ) {
      throw materialError("engine_heartbeat_rejected", false);
    }
    const renewed = await withSystemTx(this.pool, async (tx) => {
      const renewed = await tx.query<{
        lease_expires_at: Date;
        account_user_id: string;
      }>(
        `UPDATE cloud_workspace_engine_instances ei
         SET last_heartbeat_at = now(),
             lease_expires_at = now() + ($6::bigint * interval '1 millisecond'),
             updated_at = now()
         FROM cloud_workspaces cw, organizations organization, teams team,
              organization_members om, team_members tm, users account
         WHERE ei.id = $1 AND ei.workspace_id = $2 AND ei.generation = $3
           AND ei.org_id = $4 AND ei.heartbeat_token_hash = $5
           AND ei.state = 'ready' AND ei.revoked_at IS NULL
           AND cw.id = ei.workspace_id AND cw.org_id = ei.org_id
           AND organization.id = cw.org_id
           AND organization.deleted_at IS NULL
           AND team.id = cw.team_id AND team.org_id = cw.org_id
           AND team.deleted_at IS NULL
           AND om.org_id = cw.org_id AND om.user_id = ei.account_user_id
           AND tm.team_id = cw.team_id AND tm.org_id = cw.org_id
           AND tm.user_id = ei.account_user_id
           AND account.id = ei.account_user_id
           AND account.deleted_at IS NULL
           AND cw.current_generation = ei.generation
           AND cw.desired_state = 'running' AND cw.deleted_at IS NULL
           AND cw.status IN ('setting_up', 'ready', 'busy')
         RETURNING ei.lease_expires_at, ei.account_user_id`,
        [
          input.engineInstanceId,
          input.workspaceId,
          input.generation,
          input.organizationId,
          tokenHash(input.token),
          ENGINE_HEARTBEAT_LEASE_MS,
        ],
      );
      if ((renewed.rowCount ?? 0) !== 1) {
        throw materialError("engine_heartbeat_rejected", false);
      }
      if (!refresh) {
        return {
          leaseExpiresAtMs: renewed.rows[0]!.lease_expires_at.getTime(),
          repository: null,
        };
      }
      const repository = await tx.query<{
        repository_owner: string;
        repository_name: string;
        installation_id: string | number;
        owner_subject: string | null;
      }>(
        `SELECT ss.repository_owner, ss.repository_name,
                gi.github_installation_id AS installation_id,
                identity.provider_sub AS owner_subject
         FROM cloud_workspace_engine_instances ei
         JOIN cloud_workspace_setup_specs ss
           ON ss.workspace_id = ei.workspace_id
          AND ss.generation = ei.generation AND ss.org_id = ei.org_id
         JOIN github_installations gi ON gi.id = ss.github_installation_id
         LEFT JOIN LATERAL (
           SELECT ui.provider_sub
           FROM user_identities ui
           WHERE ui.user_id = ei.account_user_id
             AND ui.provider = $6
             AND encode(digest(ui.provider_sub, 'sha256'), 'hex') = $5
           ORDER BY ui.created_at DESC, ui.id DESC
           LIMIT 1
         ) identity ON true
         WHERE ei.id = $1 AND ei.workspace_id = $2 AND ei.generation = $3
           AND ei.org_id = $4 AND ei.state = 'ready'
           AND ei.revoked_at IS NULL AND ei.lease_expires_at > now()
           AND gi.app_variant = 'github.com' AND gi.suspended_at IS NULL
           AND lower(gi.account_login) = lower(ss.repository_owner)
           AND (
             gi.org_id = ei.org_id
             OR (
               gi.owner_user_id = ei.account_user_id
               AND EXISTS (
                 SELECT 1 FROM github_authorizations ga
                 WHERE ga.owner_user_id = ei.account_user_id
                   AND ga.app_variant = gi.app_variant
               )
             )
           )`,
        [
          input.engineInstanceId,
          input.workspaceId,
          input.generation,
          input.organizationId,
          refresh.ownerSubjectSha256,
          this.accountIdentityProvider,
        ],
      );
      const scope = repository.rows[0];
      if (
        !scope ||
        !scope.owner_subject ||
        createHash("sha256")
          .update(scope.owner_subject, "utf8")
          .digest("hex") !== refresh.ownerSubjectSha256
      ) {
        return {
          leaseExpiresAtMs: renewed.rows[0]!.lease_expires_at.getTime(),
          repository: null,
        };
      }
      const claimed = await tx.query(
        `UPDATE cloud_workspace_engine_instances
         SET repository_refresh_generation = $2,
             repository_refresh_claimed_at = now(), updated_at = now()
         WHERE id = $1 AND state = 'ready' AND revoked_at IS NULL
           AND (
             repository_refresh_claimed_at IS NULL
             OR repository_refresh_claimed_at <=
                now() - ($3::bigint * interval '1 millisecond')
           )
         RETURNING id`,
        [
          input.engineInstanceId,
          refresh.generation,
          REPOSITORY_REFRESH_CLAIM_INTERVAL_MS,
        ],
      );
      if ((claimed.rowCount ?? 0) !== 1) {
        return {
          leaseExpiresAtMs: renewed.rows[0]!.lease_expires_at.getTime(),
          repository: null,
        };
      }
      return {
        leaseExpiresAtMs: renewed.rows[0]!.lease_expires_at.getTime(),
        repository: {
          accountUserId: renewed.rows[0]!.account_user_id,
          owner: scope.repository_owner,
          name: scope.repository_name,
          installationId: Number(scope.installation_id),
          ownerSubject: scope.owner_subject,
        },
      };
    });

    let repositoryCredential:
      | {
          requestGeneration: string;
          outcome: "rotated";
          document: Record<string, unknown>;
        }
      | {
          requestGeneration: string;
          outcome: "unavailable";
        }
      | undefined;
    if (refresh) {
      repositoryCredential = {
        requestGeneration: refresh.generation,
        outcome: "unavailable",
      };
      if (
        renewed.repository &&
        validPositiveInteger(renewed.repository.installationId) &&
        REPOSITORY_NAME_PATTERN.test(renewed.repository.owner) &&
        REPOSITORY_NAME_PATTERN.test(renewed.repository.name)
      ) {
        let credential: { token: string; expiresAtMs: number } | null = null;
        try {
          credential = await this.github.mint({
            installationId: renewed.repository.installationId,
            owner: renewed.repository.owner,
            repository: renewed.repository.name,
          });
          const now = this.now();
          if (
            !safeString(credential.token, 4096) ||
            !Number.isSafeInteger(credential.expiresAtMs) ||
            credential.expiresAtMs - now < 5 * 60_000 ||
            credential.expiresAtMs - now > 70 * 60_000
          ) {
            throw new Error("invalid repository credential");
          }
          const stillAuthorized = await withSystemTx(this.pool, async (tx) => {
            const current = await tx.query(
              `SELECT 1
               FROM cloud_workspace_engine_instances ei
               JOIN cloud_workspaces cw
                 ON cw.id = ei.workspace_id AND cw.org_id = ei.org_id
               JOIN organizations organization
                 ON organization.id = cw.org_id
                AND organization.deleted_at IS NULL
               JOIN teams team
                 ON team.id = cw.team_id AND team.org_id = cw.org_id
                AND team.deleted_at IS NULL
               JOIN organization_members om
                 ON om.org_id = cw.org_id AND om.user_id = ei.account_user_id
               JOIN team_members tm
                 ON tm.team_id = cw.team_id AND tm.org_id = cw.org_id
                AND tm.user_id = ei.account_user_id
               JOIN users account
                 ON account.id = ei.account_user_id
                AND account.deleted_at IS NULL
               JOIN cloud_workspace_setup_specs ss
                 ON ss.workspace_id = ei.workspace_id
                AND ss.generation = ei.generation AND ss.org_id = ei.org_id
               JOIN github_installations gi ON gi.id = ss.github_installation_id
               WHERE ei.id = $1 AND ei.workspace_id = $2
                 AND ei.generation = $3 AND ei.org_id = $4
                 AND ei.account_user_id = $5 AND ei.state = 'ready'
                 AND ei.revoked_at IS NULL AND ei.lease_expires_at > now()
                 AND cw.current_generation = ei.generation
                 AND cw.desired_state = 'running' AND cw.deleted_at IS NULL
                 AND cw.status IN ('setting_up', 'ready', 'busy')
                 AND gi.github_installation_id = $6
                 AND gi.app_variant = 'github.com'
                 AND gi.suspended_at IS NULL
                 AND lower(gi.account_login) = lower(ss.repository_owner)
                 AND (
                   gi.org_id = ei.org_id
                   OR (
                     gi.owner_user_id = ei.account_user_id
                     AND EXISTS (
                       SELECT 1 FROM github_authorizations ga
                       WHERE ga.owner_user_id = ei.account_user_id
                         AND ga.app_variant = gi.app_variant
                     )
                   )
                 )
               FOR UPDATE OF ei`,
              [
                input.engineInstanceId,
                input.workspaceId,
                input.generation,
                input.organizationId,
                renewed.repository!.accountUserId,
                renewed.repository!.installationId,
              ],
            );
            if ((current.rowCount ?? 0) !== 1) return false;
            await audit(
              tx,
              input.organizationId,
              null,
              "cloud_workspace.repository_credential_rotated",
              {
                workspaceId: input.workspaceId,
                generation: input.generation,
                engineInstanceId: input.engineInstanceId,
                requestGeneration: refresh.generation,
              },
            );
            return true;
          });
          if (!stillAuthorized) {
            await this.github.revoke(credential.token).catch(() => undefined);
          } else {
            const issuedAt = this.now();
            repositoryCredential = {
              requestGeneration: refresh.generation,
              outcome: "rotated",
              document: {
                version: 1,
                audience: "zeros-cloud-github-credential-v1",
                generation: randomBytes(24).toString("base64url"),
                issuedAt,
                expiresAt: credential.expiresAtMs,
                ownerSubjectSha256: createHash("sha256")
                  .update(renewed.repository.ownerSubject, "utf8")
                  .digest("hex"),
                method: "github-app",
                credential: {
                  method: "github-app",
                  accessToken: credential.token,
                  gitHost: "github.com",
                  gitHttpUsername: "x-access-token",
                  expiresAtMs: credential.expiresAtMs,
                },
              },
            };
          }
        } catch {
          if (credential) {
            await this.github.revoke(credential.token).catch(() => undefined);
          }
        }
      }
    }
    return {
      version: 1 as const,
      audience: ENGINE_HEARTBEAT_AUDIENCE,
      accepted: true as const,
      engineInstanceId: input.engineInstanceId,
      leaseExpiresAtMs: renewed.leaseExpiresAtMs,
      ...(repositoryCredential ? { repositoryCredential } : {}),
    };
  }
}
