import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import type { JWK } from "jose";
import pg from "pg";

import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { DaytonaSandboxCommandRunner } from "./daytona-command-runner.js";
import { DaytonaCloudWorkspaceSetupExecutor } from "./daytona-setup-executor.js";
import { GithubCloudWorkspaceCredentialBroker } from "./github-credentials.js";
import {
  CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH,
  CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH,
  CLOUD_WORKSPACE_SETUP_ADMISSION_PATH,
  createCloudWorkspaceInternalRoutes,
  type CloudWorkspaceInternalSetupService,
} from "./internal-routes.js";
import { DatabaseCloudWorkspaceSetupAdmissionBroker } from "./setup-admission-broker.js";
import { sanitizeCloudWorkspaceSetupLog } from "./setup-log.js";
import {
  DatabaseCloudWorkspaceSetupMaterialService,
  sealCloudWorkspaceSetupSecret,
} from "./setup-materials.js";
import { CloudWorkspaceSetupWorker } from "./setup-worker.js";

const ENGINE_PROTOCOL_VERSION = 11;
const ENGINE_PORT = 39_393;
const LOCAL_SERVER_PORT = 8_788;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

export type PrivateValidationState = {
  sandboxId: string;
  previewUrl: string;
  previewToken: string;
  snapshotId: string;
  snapshotImageName: string;
  runtimeAttestationSha256: string;
  region: string;
  engineIngress?: unknown;
};

type PrivateSnapshotAttestation = {
  version: 1;
  snapshotId: string;
  snapshotImageName: string;
  sourceCommit: string;
  imageContractSha256: string;
};

type QualificationSeed = {
  accountUserId: string;
  organizationId: string;
  workspaceId: string;
  setupRunId: string;
  settingsSha256: string;
  setupSecret: string;
};

type BridgeClientLike = {
  connect(): Promise<unknown>;
  request(operation: string, parameters?: unknown): Promise<unknown>;
  close(): void;
};

type BridgeClientConstructor = new (options: {
  url: string;
  cloudToken: string;
  accountToken: string;
  requestTimeoutMs: number;
}) => BridgeClientLike;

function required(
  name: string,
  maximumBytes: number,
  options: { multiline?: boolean } = {},
): string {
  const raw = process.env[name];
  if (raw === undefined) throw new Error(`${name} is required`);
  const value = raw.trim();
  if (
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    value.includes("\0") ||
    (!options.multiline && /[\r\n]/.test(value))
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function positiveInteger(name: string, maximum: number): number {
  const raw = required(name, 32);
  if (!/^[1-9][0-9]{0,19}$/.test(raw)) {
    throw new Error(`${name} is invalid`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function qualificationDatabaseUrl(raw: string): string {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error("qualification database URL is invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(value.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(value.hostname) ||
    value.hash ||
    value.pathname.length < 2
  ) {
    throw new Error("qualification database must be loopback-only");
  }
  return value.toString();
}

function exactHttpsOrigin(raw: string): URL {
  const value = new URL(raw);
  if (
    value.protocol !== "https:" ||
    value.username ||
    value.password ||
    value.pathname !== "/" ||
    value.search ||
    value.hash
  ) {
    throw new Error("qualification tunnel must be an exact HTTPS origin");
  }
  return value;
}

const PREVIEW_SUFFIX_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function qualificationPreviewSuffixes(raw: string | undefined): string[] {
  const values = (raw?.trim() || "proxy.daytona.work")
    .split(",")
    .map((value) => value.trim());
  if (
    values.length < 1 ||
    values.length > 8 ||
    values.some(
      (value) =>
        value.length === 0 ||
        value !== value.toLowerCase() ||
        value.includes("..") ||
        !PREVIEW_SUFFIX_PATTERN.test(value),
    )
  ) {
    throw new Error("qualification preview host suffixes are invalid");
  }
  return [...new Set(values)];
}

export function validateQualificationPrivateState(
  raw: unknown,
  previewSuffixesRaw: string | undefined =
    process.env.DAYTONA_PREVIEW_HOST_SUFFIXES,
): PrivateValidationState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("qualification private state is invalid");
  }
  const state = raw as Record<string, unknown>;
  const ingress =
    state.engineIngress &&
    typeof state.engineIngress === "object" &&
    !Array.isArray(state.engineIngress)
      ? (state.engineIngress as Record<string, unknown>)
      : null;
  let previewUrl: URL;
  try {
    previewUrl = new URL(String(state.previewUrl ?? ""));
  } catch {
    throw new Error("qualification private state is invalid");
  }
  const previewToken =
    typeof state.previewToken === "string" ? state.previewToken : "";
  const expectedHostPrefix = `${ENGINE_PORT}-${previewToken.toLowerCase()}`;
  const exactProviderHost = qualificationPreviewSuffixes(
    previewSuffixesRaw,
  ).some(
    (suffix) => previewUrl.hostname === `${expectedHostPrefix}.${suffix}`,
  );
  if (
    typeof state.sandboxId !== "string" ||
    state.sandboxId.length < 1 ||
    state.sandboxId.length > 512 ||
    /[\0\r\n]/.test(state.sandboxId) ||
    typeof state.previewUrl !== "string" ||
    state.previewUrl.length > 4_096 ||
    state.previewUrl !== previewUrl.toString() ||
    previewUrl.protocol !== "https:" ||
    previewUrl.username ||
    previewUrl.password ||
    previewUrl.port ||
    previewUrl.pathname !== "/" ||
    previewUrl.search ||
    previewUrl.hash ||
    !exactProviderHost ||
    previewToken.length < 16 ||
    previewToken.length > 4_096 ||
    /[\0\r\n]/.test(previewToken) ||
    typeof state.snapshotId !== "string" ||
    state.snapshotId.length < 1 ||
    state.snapshotId.length > 512 ||
    /[\0\r\n]/.test(state.snapshotId) ||
    typeof state.snapshotImageName !== "string" ||
    state.snapshotImageName.length < 1 ||
    state.snapshotImageName.length > 512 ||
    /[\0\r\n]/.test(state.snapshotImageName) ||
    typeof state.runtimeAttestationSha256 !== "string" ||
    !SHA256_PATTERN.test(state.runtimeAttestationSha256) ||
    typeof state.region !== "string" ||
    state.region.length < 1 ||
    state.region.length > 64 ||
    /[\0\r\n]/.test(state.region) ||
    !ingress ||
    ingress.port !== ENGINE_PORT ||
    ingress.token !== previewToken ||
    ingress.url !== state.previewUrl
  ) {
    throw new Error("qualification private state is invalid");
  }
  return {
    sandboxId: state.sandboxId,
    previewUrl: state.previewUrl,
    previewToken,
    snapshotId: state.snapshotId,
    snapshotImageName: state.snapshotImageName,
    runtimeAttestationSha256: state.runtimeAttestationSha256,
    region: state.region,
    engineIngress: state.engineIngress,
  };
}

function readOwnerFile(file: string, maximumBytes: number): unknown {
  const stat = lstatSync(file);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 2 ||
    stat.size > maximumBytes ||
    (uid !== null && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(file) !== file
  ) {
    throw new Error("qualification private state file is unsafe");
  }
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function privateValidationState(directory: string): {
  state: PrivateValidationState;
  snapshot: PrivateSnapshotAttestation;
} {
  if (!path.isAbsolute(directory)) {
    throw new Error("qualification state directory must be absolute");
  }
  const state = validateQualificationPrivateState(
    readOwnerFile(path.join(directory, "state.json"), 2 * 1024 * 1024),
  );
  const snapshot = readOwnerFile(
    path.join(directory, "snapshot-attestation.json"),
    256 * 1024,
  ) as Partial<PrivateSnapshotAttestation>;
  if (
    snapshot.version !== 1 ||
    snapshot.snapshotId !== state.snapshotId ||
    snapshot.snapshotImageName !== state.snapshotImageName ||
    typeof snapshot.sourceCommit !== "string" ||
    !COMMIT_PATTERN.test(snapshot.sourceCommit) ||
    typeof snapshot.imageContractSha256 !== "string" ||
    !SHA256_PATTERN.test(snapshot.imageContractSha256)
  ) {
    throw new Error("qualification private state is invalid");
  }
  return {
    state,
    snapshot: snapshot as PrivateSnapshotAttestation,
  };
}

function repositoryIdentity(raw: string): { owner: string; name: string } {
  const parts = raw.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !SAFE_NAME_PATTERN.test(part))
  ) {
    throw new Error("qualification repository is invalid");
  }
  return { owner: parts[0]!, name: parts[1]! };
}

function toolboxOrigins(raw: string): string[] {
  const values = [...new Set(raw.split(",").map((value) => value.trim()))];
  if (values.length < 1 || values.length > 8) {
    throw new Error("qualification toolbox origins are invalid");
  }
  for (const rawValue of values) {
    const value = new URL(rawValue);
    if (
      value.protocol !== "https:" ||
      value.username ||
      value.password ||
      value.pathname !== "/" ||
      value.search ||
      value.hash ||
      rawValue.replace(/\/$/, "") !== value.origin
    ) {
      throw new Error("qualification toolbox origins are invalid");
    }
  }
  return values.map((value) => value.replace(/\/$/, ""));
}

async function verifyQualificationIdentity(input: {
  token: string;
  publicKey: string;
  keyId: string;
  issuer: string;
  audience: string;
  clientId: string;
  ownerSubject: string;
}): Promise<JWK> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.keyId)) {
    throw new Error("qualification account key id is invalid");
  }
  const header = decodeProtectedHeader(input.token);
  if (
    header.alg !== "RS256" ||
    header.typ !== "JWT" ||
    header.kid !== input.keyId
  ) {
    throw new Error("qualification account token header is invalid");
  }
  const key = await importSPKI(input.publicKey, "RS256");
  const verified = await jwtVerify(input.token, key, {
    algorithms: ["RS256"],
    audience: input.audience,
    issuer: input.issuer,
    requiredClaims: ["sub", "sid", "jti", "client_id", "iat", "exp"],
  });
  if (
    verified.payload.sub !== input.ownerSubject ||
    verified.payload.client_id !== input.clientId ||
    typeof verified.payload.sid !== "string" ||
    typeof verified.payload.jti !== "string" ||
    verified.payload["https://zeros.build/email_verified"] !== true
  ) {
    throw new Error("qualification account token claims are invalid");
  }
  const jwk = createPublicKey(input.publicKey).export({ format: "jwk" });
  if (
    jwk.kty !== "RSA" ||
    typeof jwk.n !== "string" ||
    typeof jwk.e !== "string"
  ) {
    throw new Error("qualification account public key is invalid");
  }
  return { ...jwk, alg: "RS256", kid: input.keyId, use: "sig" };
}

async function seedQualification(input: {
  pool: pg.Pool;
  state: PrivateValidationState;
  snapshot: PrivateSnapshotAttestation;
  repository: { owner: string; name: string };
  repositoryCommit: string;
  installationId: number;
  ownerSubject: string;
  setupSecretKey: string;
}): Promise<QualificationSeed> {
  const accountUserId = randomUUID();
  const organizationId = randomUUID();
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  const installationRowId = randomUUID();
  const setupSecretId = randomUUID();
  const setupSecret = randomBytes(32).toString("base64url");
  const settings = {
    schemaVersion: 1,
    values: { cloud: { qualification: true } },
    secretRefs: [
      { id: setupSecretId, name: "QUALIFICATION_SETUP_SECRET" },
    ],
    setupCommands: [
      {
        command:
          "test -n \"${QUALIFICATION_SETUP_SECRET:-}\" && test -d .git",
        timeoutSeconds: 30,
      },
    ],
  };
  const sealed = sealCloudWorkspaceSetupSecret(
    setupSecret,
    {
      id: setupSecretId,
      workspaceId,
      organizationId,
      generation: 1,
      name: "QUALIFICATION_SETUP_SECRET",
    },
    input.setupSecretKey,
  );

  return withSystemTx(input.pool, async (tx) => {
    await tx.query(
      `INSERT INTO users (id, email, display_name)
       VALUES ($1, $2, 'Cloud Qualification Owner')`,
      [accountUserId, `cloud-qualification-${accountUserId}@zeros.invalid`],
    );
    await tx.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub)
       VALUES ($1, 'workos', $2)`,
      [accountUserId, input.ownerSubject],
    );
    await tx.query(
      `INSERT INTO organizations (
         id, slug, name, created_by, is_personal, cloud_workspaces_allowed
       ) VALUES ($1, $2, 'Cloud Qualification', $3, false, true)`,
      [organizationId, `cloud-qualification-${randomUUID()}`, accountUserId],
    );
    await tx.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [organizationId, accountUserId],
    );
    await tx.query(
      `INSERT INTO teams (id, org_id, slug, name, is_default, created_by)
       VALUES ($1, $2, 'default', 'Default', true, $3)`,
      [teamId, organizationId, accountUserId],
    );
    await tx.query(
      `INSERT INTO team_members (team_id, org_id, user_id, role)
       VALUES ($1, $2, $3, 'maintainer')`,
      [teamId, organizationId, accountUserId],
    );
    await tx.query(
      `INSERT INTO github_installations (
         id, github_installation_id, app_variant, org_id,
         account_login, account_type, target_type
       ) VALUES ($1, $2, 'github.com', $3, $4, 'Organization', 'Organization')`,
      [
        installationRowId,
        input.installationId,
        organizationId,
        input.repository.owner,
      ],
    );
    await tx.query(
      `INSERT INTO cloud_workspaces (
         id, org_id, team_id, created_by, display_name,
         repository_forge, repository_owner, repository_name,
         repository_revision, github_installation_id, status, desired_state
       ) VALUES ($1, $2, $3, $4, 'Live Setup Qualification',
                 'github.com', $5, $6, $7, $8, 'setting_up', 'running')`,
      [
        workspaceId,
        organizationId,
        teamId,
        accountUserId,
        input.repository.owner,
        input.repository.name,
        input.repositoryCommit,
        installationRowId,
      ],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_generations (
         workspace_id, generation, org_id, provider, image_ref,
         architecture, cpu_millicores, memory_mib, storage_mib,
         source_commit, created_by
       ) VALUES ($1, 1, $2, 'daytona', $3, 'linux/amd64',
                 2000, 4096, 20480, $4, $5)`,
      [
        workspaceId,
        organizationId,
        input.snapshot.snapshotId,
        input.snapshot.sourceCommit,
        accountUserId,
      ],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_provider_bindings (
         workspace_id, generation, org_id, provider,
         provider_resource_id, observed_state, last_observed_at
       ) VALUES ($1, 1, $2, 'daytona', $3, 'running', now())`,
      [workspaceId, organizationId, input.state.sandboxId],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_setup_specs (
         workspace_id, generation, org_id, repository_forge,
         repository_owner, repository_name, repository_revision,
         github_installation_id, settings_snapshot, settings_snapshot_sha256
       ) VALUES ($1, 1, $2, 'github.com', $3, $4, $5, $6,
                 $7::jsonb, digest($7::jsonb::text, 'sha256'))`,
      [
        workspaceId,
        organizationId,
        input.repository.owner,
        input.repository.name,
        input.repositoryCommit,
        installationRowId,
        JSON.stringify(settings),
      ],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_setup_secrets (
         id, workspace_id, generation, org_id, name, key_version,
         nonce, ciphertext, auth_tag
       ) VALUES ($1, $2, 1, $3, 'QUALIFICATION_SETUP_SECRET', 1, $4, $5, $6)`,
      [
        setupSecretId,
        workspaceId,
        organizationId,
        sealed.nonce,
        sealed.ciphertext,
        sealed.authTag,
      ],
    );
    const run = await tx.query<{ id: string }>(
      `INSERT INTO cloud_workspace_setup_runs (
         workspace_id, generation, org_id, attempt
       ) VALUES ($1, 1, $2, 1) RETURNING id`,
      [workspaceId, organizationId],
    );
    const digest = await tx.query<{ value: string }>(
      `SELECT encode(settings_snapshot_sha256, 'hex') AS value
       FROM cloud_workspace_setup_specs
       WHERE workspace_id = $1 AND generation = 1`,
      [workspaceId],
    );
    return {
      accountUserId,
      organizationId,
      workspaceId,
      setupRunId: run.rows[0]!.id,
      settingsSha256: digest.rows[0]!.value,
      setupSecret,
    };
  });
}

function bridgeUrl(previewUrl: string): string {
  const value = new URL(previewUrl);
  value.protocol = "wss:";
  value.pathname = "/ws";
  value.searchParams.delete("token");
  return value.toString();
}

async function verifyProductionBridge(input: {
  state: PrivateValidationState;
  bridgeToken: string;
  accountToken: string;
}): Promise<void> {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../",
  );
  const bridgeModule = (await import(
    pathToFileURL(
      path.join(
        root,
        "scripts/cloud-workspace-validation/lib/bridge-client.ts",
      ),
    ).href
  )) as { BridgeClient: BridgeClientConstructor };
  const targetModule = (await import(
    pathToFileURL(
      path.join(
        root,
        "scripts/cloud-workspace-validation/lib/workspace-target.ts",
      ),
    ).href
  )) as { selectCloudPrimaryWorkspaceId(value: unknown): string };
  const client = new bridgeModule.BridgeClient({
    url: bridgeUrl(input.state.previewUrl),
    cloudToken: input.bridgeToken,
    accountToken: input.accountToken,
    requestTimeoutMs: 90_000,
  });
  try {
    await client.connect();
    const workspaceId = targetModule.selectCloudPrimaryWorkspaceId(
      await client.request("workspace.list"),
    );
    const tree = (await client.request("file.tree", {
      workspaceId,
      limit: 50,
    })) as { files?: unknown };
    if (!Array.isArray(tree.files) || tree.files.length < 1) {
      throw new Error("production setup private repository is empty");
    }
  } finally {
    client.close();
  }
}

async function waitForTunnel(input: {
  origin: URL;
  runId: string;
  runAttempt: string;
}): Promise<void> {
  const deadline = Date.now() + 90_000;
  const endpoint = new URL("/internal/qualification/health", input.origin);
  endpoint.searchParams.set("run", input.runId);
  endpoint.searchParams.set("attempt", input.runAttempt);
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (
        response.ok &&
        response.headers.get("content-type")
          ?.split(";", 1)[0]
          ?.trim() === "application/json"
      ) {
        const body = (await response.json()) as Record<string, unknown>;
        if (
          body.ok === true &&
          body.runId === input.runId &&
          body.runAttempt === input.runAttempt
        ) {
          return;
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
    } catch {
      // The named tunnel may still be establishing its edge connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("qualification tunnel did not reach this exact runner");
}

async function setupObservation(pool: pg.Pool, seed: QualificationSeed) {
  const result = await pool.query<{
    workspace_status: string;
    setup_state: string;
    setup_error: string | null;
    log_excerpt: string;
    repository_commit: string;
    image_source_commit: string;
    settings_sha256: string;
    engine_instance_id: string;
    engine_state: string;
    engine_protocol_version: number;
    last_heartbeat_at: Date;
    lease_expires_at: Date;
    live_setup_grants: string | number;
    visible_engine: string;
    visible_audit: string;
  }>(
    `SELECT cw.status AS workspace_status, sr.state AS setup_state,
            sr.error_code AS setup_error, coalesce(sr.log_excerpt, '') AS log_excerpt,
            sa.repository_commit, sa.image_source_commit,
            encode(sa.settings_snapshot_sha256, 'hex') AS settings_sha256,
            ei.id AS engine_instance_id, ei.state AS engine_state,
            ei.protocol_version AS engine_protocol_version,
            ei.last_heartbeat_at, ei.lease_expires_at,
            (SELECT count(*) FROM cloud_workspace_endpoint_grants eg
             WHERE eg.workspace_id = cw.id AND eg.generation = cw.current_generation
               AND eg.purpose = 'setup' AND eg.revoked_at IS NULL
               AND eg.consumed_at IS NULL) AS live_setup_grants,
            row_to_json(ei)::text AS visible_engine,
            coalesce((SELECT string_agg(a.details::text, '') FROM audit_log a
                      WHERE a.org_id = cw.org_id), '') AS visible_audit
     FROM cloud_workspaces cw
     JOIN cloud_workspace_setup_runs sr ON sr.id = $2
     JOIN cloud_workspace_setup_attestations sa ON sa.setup_run_id = sr.id
     JOIN cloud_workspace_engine_instances ei ON ei.id = sa.engine_instance_id
     WHERE cw.id = $1 AND cw.org_id = $3`,
    [seed.workspaceId, seed.setupRunId, seed.organizationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("production setup evidence is missing");
  return row;
}

async function main(): Promise<void> {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.CLOUD_WORKSPACE_SETUP_WORKER_ENABLED === "true" ||
    process.env.ZEROS_CLOUD_QUALIFICATION_ALLOW_DATABASE_RESET !== "1"
  ) {
    throw new Error("live setup qualification is outside its protected gate");
  }
  const runId = required("GITHUB_RUN_ID", 32);
  const runAttempt = required("GITHUB_RUN_ATTEMPT", 16);
  if (!/^[1-9][0-9]{0,19}$/.test(runId) || !/^[1-9][0-9]{0,19}$/.test(runAttempt)) {
    throw new Error("qualification workflow identity is invalid");
  }
  const databaseUrl = qualificationDatabaseUrl(
    required("ZEROS_CLOUD_QUALIFICATION_DATABASE_URL", 4_096),
  );
  const origin = exactHttpsOrigin(
    required("ZEROS_CLOUD_QUALIFICATION_TUNNEL_ORIGIN", 4_096),
  );
  const stateDirectory = required(
    "ZEROS_CLOUD_VALIDATION_STATE_DIR",
    4_096,
  );
  const { state, snapshot } = privateValidationState(stateDirectory);
  if (
    snapshot.sourceCommit !== required("GITHUB_SHA", 128) ||
    state.region !== required("DAYTONA_TARGET", 64)
  ) {
    throw new Error("qualification provider state is from another workflow source");
  }
  const repository = repositoryIdentity(
    required("ZEROS_CLOUD_GITHUB_REPOSITORY", 256),
  );
  const repositoryCommit = required(
    "ZEROS_CLOUD_GITHUB_REPOSITORY_COMMIT",
    128,
  );
  if (!COMMIT_PATTERN.test(repositoryCommit)) {
    throw new Error("qualification repository commit is invalid");
  }
  const githubAppId = positiveInteger(
    "ZEROS_CLOUD_GITHUB_APP_ID",
    Number.MAX_SAFE_INTEGER,
  );
  const githubInstallationId = positiveInteger(
    "ZEROS_CLOUD_GITHUB_INSTALLATION_ID",
    Number.MAX_SAFE_INTEGER,
  );
  const githubPrivateKey = required(
    "ZEROS_CLOUD_GITHUB_APP_PRIVATE_KEY",
    64 * 1024,
    { multiline: true },
  ).replaceAll("\\n", "\n");
  if (createPrivateKey(githubPrivateKey).asymmetricKeyType !== "rsa") {
    throw new Error("qualification GitHub App key must be RSA");
  }
  const ownerSubject = required("ZEROS_CLOUD_OWNER_SUB", 512);
  const accountToken = required("ZEROS_ACCOUNT_ACCESS_TOKEN", 16 * 1024);
  const accountPublicKey = required(
    "ZEROS_ACCOUNT_JWT_PUBLIC_KEY",
    16 * 1024,
    { multiline: true },
  );
  const accountKeyId = required("ZEROS_ACCOUNT_JWT_KID", 128);
  const accountIssuer = required("ZEROS_ACCOUNT_JWT_ISS", 4_096);
  const accountAudience = required("ZEROS_ACCOUNT_JWT_AUD", 512);
  const accountClientId = required("ZEROS_ACCOUNT_JWT_CLIENT_ID", 512);
  const accountJwk = await verifyQualificationIdentity({
    token: accountToken,
    publicKey: accountPublicKey,
    keyId: accountKeyId,
    issuer: accountIssuer,
    audience: accountAudience,
    clientId: accountClientId,
    ownerSubject,
  });
  const setupSecretKey = randomBytes(32).toString("base64url");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  let server: ReturnType<typeof serve> | null = null;
  let bridgeToken: string | null = null;
  let engineInstanceId: string | null = null;
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    const seed = await seedQualification({
      pool,
      state,
      snapshot,
      repository,
      repositoryCommit,
      installationId: githubInstallationId,
      ownerSubject,
      setupSecretKey,
    });
    const setupAudience = new URL(
      CLOUD_WORKSPACE_SETUP_ADMISSION_PATH,
      origin,
    ).toString();
    const registrationAudience = new URL(
      CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH,
      origin,
    ).toString();
    const heartbeatAudience = new URL(
      CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH,
      origin,
    ).toString();
    const github = new GithubCloudWorkspaceCredentialBroker({
      appId: githubAppId,
      clientId: "qualification-only",
      clientSecret: "qualification-only",
      privateKey: githubPrivateKey,
      refreshBindingSecret: "qualification-only",
      appSlug: "qualification-only",
      oauthCallbackUrl: "https://invalid.zeros.invalid/github/callback",
      completionPageUrl: "https://invalid.zeros.invalid/github/connected",
      webBaseUrl: "https://github.com",
      apiBaseUrl: "https://api.github.com",
      variantKey: "github.com",
      desktopSchemes: ["zeros", "zeros-alpha", "zeros-beta", "zeros-dev"],
    });
    const materials = new DatabaseCloudWorkspaceSetupMaterialService({
      pool,
      setupAudience,
      engineRegistrationAudience: registrationAudience,
      engineHeartbeatAudience: heartbeatAudience,
      engineProtocolVersion: ENGINE_PROTOCOL_VERSION,
      enginePort: ENGINE_PORT,
      engineRegistrationTtlSeconds: 1_860,
      setupSecretKeyV1: setupSecretKey,
      github,
      accountIdentityProvider: "workos",
      accountAuth: {
        jwksUrl: new URL("/.well-known/jwks.json", origin).toString(),
        audience: accountAudience,
        issuers: [accountIssuer],
        contract: "zeros-access-v1",
        clientId: accountClientId,
      },
    });
    const service: CloudWorkspaceInternalSetupService = {
      redeem: async (input) => {
        const result = await materials.redeem(input);
        bridgeToken = result.engine.bridgeToken;
        engineInstanceId = result.engine.instanceId;
        return result;
      },
      registerEngine: (input) => materials.registerEngine(input),
      heartbeat: (input) => materials.heartbeat(input),
    };
    const app = new Hono();
    app.use("*", async (c, next) => {
      if (c.req.header("host")?.toLowerCase() !== origin.host.toLowerCase()) {
        return c.json({ error: { code: "not_found" } }, 404);
      }
      await next();
    });
    app.get("/internal/qualification/health", async (c) => {
      await pool.query("SELECT 1");
      c.header("Cache-Control", "no-store");
      return c.json({ ok: true, runId, runAttempt });
    });
    app.get("/.well-known/jwks.json", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ keys: [accountJwk] });
    });
    app.route("/", createCloudWorkspaceInternalRoutes(service));
    app.onError((_error, c) =>
      c.json({ error: { code: "internal" } }, 500),
    );
    await new Promise<void>((resolve) => {
      server = serve(
        {
          fetch: app.fetch,
          hostname: "127.0.0.1",
          port: LOCAL_SERVER_PORT,
        },
        () => resolve(),
      );
    });
    await waitForTunnel({ origin, runId, runAttempt });

    const admission = new DatabaseCloudWorkspaceSetupAdmissionBroker({
      pool,
      endpoint: setupAudience,
      ttlSeconds: 900,
    });
    const runner = new DaytonaSandboxCommandRunner({
      apiKey: required("DAYTONA_API_KEY", 4_096),
      apiUrl: required("DAYTONA_API_URL", 4_096),
      allowedToolboxOrigins: toolboxOrigins(
        required("ZEROS_CLOUD_QUALIFICATION_TOOLBOX_ORIGINS", 32 * 1024),
      ),
      lookupTimeoutMs: 15_000,
      maxCommandTimeoutSeconds: 1_800,
      maxOutputBytes: 256 * 1024,
    });
    const executor = new DaytonaCloudWorkspaceSetupExecutor({
      admissionBroker: admission,
      commandRunner: runner,
      engineProtocolVersion: ENGINE_PROTOCOL_VERSION,
      timeoutSeconds: 1_800,
    });
    const worker = new CloudWorkspaceSetupWorker({
      pool,
      executor,
      sanitizeLog: sanitizeCloudWorkspaceSetupLog,
      intervalMs: 1_000,
      leaseMs: 60_000,
      heartbeatMs: 20_000,
      executionTimeoutMs: 1_815_000,
      maxClaims: 1,
      workerId: `qualification:${runId}:${runAttempt}`,
    });
    if (!(await worker.runOnce()) || !bridgeToken || !engineInstanceId) {
      throw new Error("production setup worker did not publish readiness");
    }
    const first = await setupObservation(pool, seed);
    if (
      first.workspace_status !== "ready" ||
      first.setup_state !== "succeeded" ||
      first.setup_error !== null ||
      first.repository_commit !== repositoryCommit ||
      first.image_source_commit !== snapshot.sourceCommit ||
      first.settings_sha256 !== seed.settingsSha256 ||
      first.engine_instance_id !== engineInstanceId ||
      first.engine_state !== "ready" ||
      first.engine_protocol_version !== ENGINE_PROTOCOL_VERSION ||
      Number(first.live_setup_grants) !== 0 ||
      first.log_excerpt.includes(seed.setupSecret) ||
      first.visible_engine.includes(bridgeToken) ||
      first.visible_audit.includes(seed.setupSecret)
    ) {
      throw new Error("production setup durable evidence is invalid");
    }
    await verifyProductionBridge({
      state,
      bridgeToken,
      accountToken,
    });
    await new Promise((resolve) => setTimeout(resolve, 35_000));
    const second = await setupObservation(pool, seed);
    if (
      second.engine_instance_id !== engineInstanceId ||
      second.engine_state !== "ready" ||
      second.last_heartbeat_at.getTime() <= first.last_heartbeat_at.getTime() ||
      second.lease_expires_at.getTime() <= Date.now()
    ) {
      throw new Error("production engine heartbeat did not renew its lease");
    }
    console.log(
      "Production setup worker qualification passed: admission, encrypted settings/secret, private clone, engine registration, strict JWKS bridge, heartbeat, and durable readiness are green.",
    );
  } finally {
    bridgeToken = null;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await pool.end();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(
      "live cloud setup qualification failed:",
      error instanceof Error ? error.message : "unknown failure",
    );
    process.exit(1);
  });
}
