import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type pg from "pg";

import { audit } from "../audit.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import {
  authorizeCloudWorkspaceOperation,
  CloudWorkspaceAuthorizationError,
} from "./authorization.js";
import {
  CloudProviderError,
  type CloudProviderPreviewEndpoint,
  type CloudProviderSshAccess,
  type CloudWorkspaceAccessProvider,
} from "./provider.js";
import type {
  CloudWorkspaceProviderPurpose,
  CloudWorkspaceProviderResolver,
} from "./provider-resolver.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const PREVIEW_CAPABILITY_PATTERN = /^zwp_[A-Za-z0-9_-]{43}$/;
// Request bodies are deliberately buffered before provider I/O so an
// oversized mutation cannot partially reach a dev server. Keep the aggregate
// bound below a small Railway instance's memory ceiling even when repository
// code opens every allowed request concurrently.
const MAX_PROXY_REQUEST_BYTES = 4 * 1024 * 1024;
const PREVIEW_ENDPOINT_CACHE_SIZE = 256;
const PREVIEW_ENDPOINT_CACHE_MS = 5_000;
const MAX_CONCURRENT_PREVIEW_REQUESTS = 32;
const MAX_CONCURRENT_PREVIEW_REQUESTS_PER_GRANT = 4;

export type CloudWorkspaceClientAccessKind = "ssh" | "tunnel" | "preview";
export type CloudWorkspaceAccessPurpose = "user" | "engine-runtime";

export type CloudWorkspaceAccessDocument = {
  grant: {
    id: string;
    kind: CloudWorkspaceClientAccessKind;
    workspaceId: string;
    generation: number;
    remotePort: number | null;
    expiresAt: string;
  };
  ssh?: {
    username: string;
    host: string;
    command: string;
  };
  tunnel?: {
    sshUsername: string;
    sshHost: string;
    remoteHost: "127.0.0.1";
    remotePort: number;
    session: {
      id: string;
      deviceId: string;
      state: "starting";
    };
  };
  preview?: {
    logicalUrl: string;
    origin: string;
    capability: string;
    headerName: "x-zeros-preview-capability";
  };
};

export type CloudWorkspaceAccessService = {
  issue(input: {
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    kind: CloudWorkspaceClientAccessKind;
    purpose?: CloudWorkspaceAccessPurpose;
    expectedGeneration?: number;
    deviceId?: string;
    requestedLocalPort?: number;
    remotePort?: number;
    expiresInMinutes: number;
    idempotencyKey: string;
  }): Promise<CloudWorkspaceAccessDocument>;
  activateTunnel(input: {
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    sessionId: string;
    deviceId: string;
    observedLocalPort: number;
  }): Promise<{
    id: string;
    deviceId: string;
    state: "active";
    bindAddress: "127.0.0.1";
    observedLocalPort: number;
  }>;
  revoke(input: {
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    grantId: string;
    credential: string;
  }): Promise<void>;
  /** Pure host recognition so ingress abuse controls can run before DB work. */
  recognizesPreviewRequest(request: Request): boolean;
  handlePreviewRequest(request: Request): Promise<Response | null>;
};

type AuthorizedWorkspace = {
  team_id: string;
  owner_user_id: string;
  generation: number;
  status: string;
  desired_state: string;
  provider_resource_id: string;
  provider_binding_updated_at: Date | string;
};

type GrantRow = {
  id: string;
  workspace_id: string;
  generation: number;
  org_id: string;
  account_user_id: string;
  kind: CloudWorkspaceClientAccessKind;
  remote_port: number | null;
  provider_resource_id: string;
  provider_access_id: string | null;
  preview_proxy_label: string | null;
  token_hash: Buffer | null;
  state: string;
  expires_at: Date | string | null;
};

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new HttpError(404, "not_found", `${label} not found`);
  }
}

function hashToken(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sameHash(left: Buffer | null, right: Buffer): boolean {
  return (
    left !== null &&
    left.length === right.length &&
    timingSafeEqual(left, right)
  );
}

function requestDigest(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function hasAsciiWhitespaceOrControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function providerHttpError(error: unknown, operation: string): HttpError {
  if (error instanceof CloudProviderError) {
    return new HttpError(
      error.retryable ? 503 : 502,
      error.retryable
        ? "cloud_access_provider_unavailable"
        : "cloud_access_provider_rejected",
      `Cloud workspace ${operation} did not complete`,
    );
  }
  return new HttpError(
    503,
    "cloud_access_provider_unavailable",
    `Cloud workspace ${operation} did not complete`,
  );
}

async function authorizedWorkspace(
  tx: Tx,
  input: {
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    workosEnabled: boolean;
  },
): Promise<AuthorizedWorkspace> {
  const scope = await tx.query<{ team_id: string; owner_user_id: string }>(
    `SELECT cw.team_id, cw.owner_user_id
     FROM cloud_workspaces cw
     WHERE cw.org_id = $1 AND cw.id = $2 AND cw.deleted_at IS NULL`,
    [input.organizationId, input.workspaceId],
  );
  const identity = scope.rows[0];
  if (!identity) {
    throw new HttpError(404, "not_found", "Cloud workspace not found");
  }
  try {
    await authorizeCloudWorkspaceOperation(tx, {
      organizationId: input.organizationId,
      teamId: identity.team_id,
      actorUserId: input.accountUserId,
      billingOwnerUserId: identity.owner_user_id,
      workosEnabled: input.workosEnabled,
      requireWorkspaceOwner: true,
    });
  } catch (error) {
    if (
      error instanceof CloudWorkspaceAuthorizationError &&
      error.status === 404
    ) {
      throw new HttpError(404, "not_found", "Cloud workspace not found");
    }
    throw error;
  }
  const selected = await tx.query<AuthorizedWorkspace>(
    `SELECT cw.team_id, cw.owner_user_id,
            cw.current_generation AS generation, cw.status, cw.desired_state,
            pb.provider_resource_id, pb.updated_at AS provider_binding_updated_at
     FROM cloud_workspaces cw
     JOIN organizations organization
       ON organization.id = cw.org_id AND organization.deleted_at IS NULL
     JOIN teams team
       ON team.id = cw.team_id AND team.org_id = cw.org_id
      AND team.deleted_at IS NULL
     JOIN organization_members om
       ON om.org_id = cw.org_id AND om.user_id = $3
     JOIN team_members tm
       ON tm.team_id = cw.team_id AND tm.org_id = cw.org_id
      AND tm.user_id = $3
     JOIN users account
       ON account.id = $3 AND account.deleted_at IS NULL
      AND account.auth_status = 'active'
     JOIN cloud_workspace_generations generation
       ON generation.workspace_id = cw.id
      AND generation.generation = cw.current_generation
      AND generation.org_id = cw.org_id
     JOIN provider_connections provider_connection
       ON provider_connection.id = generation.provider_connection_id
      AND provider_connection.org_id = generation.org_id
      AND provider_connection.state = 'active'
     JOIN cloud_workspace_provider_bindings pb
       ON pb.workspace_id = cw.id AND pb.org_id = cw.org_id
      AND pb.generation = cw.current_generation
     WHERE cw.org_id = $1 AND cw.id = $2 AND cw.deleted_at IS NULL
       AND cw.owner_user_id = $3 AND cw.single_member_mode
       AND pb.provider_resource_id IS NOT NULL
       AND pb.observed_state = 'running'
       AND cloud_workspace_generation_policy_current(
         cw.id, cw.current_generation, cw.org_id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM cloud_workspace_generation_secret_bindings secret_link
         JOIN secret_bindings secret
           ON secret.id = secret_link.binding_id
          AND secret.org_id = secret_link.org_id
         WHERE secret_link.workspace_id = cw.id
           AND secret_link.generation = cw.current_generation
           AND secret_link.org_id = cw.org_id
           AND secret.state <> 'active'
       )
     FOR UPDATE OF cw`,
    [input.organizationId, input.workspaceId, input.accountUserId],
  );
  const workspace = selected.rows[0];
  if (!workspace) {
    throw new HttpError(404, "not_found", "Cloud workspace not found");
  }
  if (
    workspace.desired_state !== "running" ||
    !["ready", "busy"].includes(workspace.status)
  ) {
    throw new HttpError(
      409,
      "cloud_workspace_access_unavailable",
      "Cloud workspace access is available only while the current generation is ready",
    );
  }
  return workspace;
}

function normalizedPort(
  kind: CloudWorkspaceClientAccessKind,
  value: number | undefined,
  forbiddenPorts: ReadonlySet<number>,
  purpose: CloudWorkspaceAccessPurpose,
  runtimeEnginePort: number | null,
): number | null {
  if (
    purpose === "engine-runtime" &&
    (kind !== "tunnel" || runtimeEnginePort === null || value !== runtimeEnginePort)
  ) {
    throw new HttpError(
      422,
      "cloud_access_port_forbidden",
      "Cloud runtime tunnels require the configured engine port",
    );
  }
  if (kind === "ssh") {
    if (value !== undefined) {
      throw new HttpError(
        422,
        "invalid_input",
        "SSH access does not accept a remote port",
      );
    }
    return null;
  }
  if (
    !Number.isSafeInteger(value) ||
    value === undefined ||
    value < 1_024 ||
    value > 65_535 ||
    (forbiddenPorts.has(value) && purpose !== "engine-runtime")
  ) {
    throw new HttpError(
      422,
      "cloud_access_port_forbidden",
      "Cloud preview and tunnel ports must be unreserved application ports",
    );
  }
  return value;
}

function normalizedTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 5 || value > 60) {
    throw new HttpError(
      422,
      "cloud_access_ttl_invalid",
      "Cloud workspace access expiry must be between 5 and 60 minutes",
    );
  }
  return value;
}

function normalizedOptionalPort(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_535) {
    throw new HttpError(
      422,
      "cloud_access_port_forbidden",
      "Local forwarding requires an application port",
    );
  }
  return value;
}

function normalizedRequiredPort(value: number): number {
  const normalized = normalizedOptionalPort(value);
  if (normalized === null) {
    throw new HttpError(
      422,
      "cloud_access_port_forbidden",
      "Local forwarding requires an application port",
    );
  }
  return normalized;
}

async function assertActiveDevice(
  tx: Tx,
  input: { deviceId: string; accountUserId: string },
): Promise<void> {
  const device = await tx.query(
    `SELECT 1 FROM devices
     WHERE id = $1 AND user_id = $2 AND trust_state = 'trusted'
       AND revoked_at IS NULL
     FOR UPDATE`,
    [input.deviceId, input.accountUserId],
  );
  if ((device.rowCount ?? 0) !== 1) {
    throw new HttpError(404, "not_found", "Cloud device not found");
  }
}

function normalizedCredential(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 4_096 ||
    hasAsciiWhitespaceOrControl(value)
  ) {
    throw new HttpError(404, "not_found", "Cloud access grant not found");
  }
  return value;
}

function safeProviderAccessId(value: string): string {
  if (
    value.length < 1 ||
    value.length > 512 ||
    hasAsciiWhitespaceOrControl(value)
  ) {
    throw new CloudProviderError(
      "provider_access_response_invalid",
      "Provider returned an invalid access identifier",
      false,
    );
  }
  return value;
}

/**
 * Daytona revokes SSH credentials for the whole sandbox, not one bearer. The
 * pending row that scheduled revocation prevents new issuance, while this
 * workspace-first fence also catches issuance whose provider request was
 * already in flight. It must commit before the remote revoke starts so a token
 * cannot be minted in the remote-revoke/database-completion gap and then be
 * represented locally as revoked.
 */
async function fenceProviderWideSshRevocation(
  pool: pg.Pool,
  input: {
    workspaceId: string;
    organizationId: string;
    providerResourceId: string;
    reason: string;
  },
): Promise<void> {
  await withSystemTx(pool, async (tx) => {
    await tx.query(
      `SELECT 1 FROM cloud_workspaces
       WHERE id = $1 AND org_id = $2
       FOR UPDATE`,
      [input.workspaceId, input.organizationId],
    );
    await tx.query(
      `UPDATE cloud_workspace_client_access_grants
       SET state = 'revocation_pending',
           revocation_reason = coalesce(revocation_reason, $4),
           next_revocation_at = now(), updated_at = now()
       WHERE workspace_id = $1 AND org_id = $2
         AND provider_resource_id = $3
         AND kind IN ('ssh', 'tunnel')
         AND state IN ('issuing', 'active', 'revocation_pending')`,
      [
        input.workspaceId,
        input.organizationId,
        input.providerResourceId,
        input.reason,
      ],
    );
  });
}

export class DatabaseCloudWorkspaceAccessService implements CloudWorkspaceAccessService {
  private readonly pool: pg.Pool;
  private readonly provider: CloudWorkspaceAccessProvider | null;
  private readonly providerResolver: CloudWorkspaceProviderResolver | null;
  private readonly previewBaseDomain: string | null;
  private readonly fetcher: Fetcher;
  private readonly forbiddenPorts: ReadonlySet<number>;
  private readonly runtimeEnginePort: number | null;
  private readonly workosEnabled: boolean;
  private readonly previewEndpoints = new Map<
    string,
    { endpoint: CloudProviderPreviewEndpoint; expiresAt: number }
  >();
  private readonly previewEndpointRequests = new Map<
    string,
    Promise<CloudProviderPreviewEndpoint>
  >();
  private concurrentPreviewRequests = 0;
  private readonly concurrentPreviewRequestsByGrant = new Map<string, number>();

  constructor(input: {
    pool: pg.Pool;
    provider?: CloudWorkspaceAccessProvider;
    providerResolver?: CloudWorkspaceProviderResolver;
    previewBaseDomain: string | null;
    fetcher?: Fetcher;
    forbiddenPorts?: readonly number[];
    runtimeEnginePort?: number;
    workosEnabled?: boolean;
  }) {
    if ((input.provider ? 1 : 0) + (input.providerResolver ? 1 : 0) !== 1) {
      throw new Error(
        "Cloud workspace access requires exactly one provider boundary",
      );
    }
    this.pool = input.pool;
    this.provider = input.provider ?? null;
    this.providerResolver = input.providerResolver ?? null;
    this.previewBaseDomain = input.previewBaseDomain;
    this.fetcher = input.fetcher ?? fetch;
    this.forbiddenPorts = new Set(input.forbiddenPorts ?? [22_222, 39_393]);
    this.runtimeEnginePort = input.runtimeEnginePort ?? null;
    if (
      this.runtimeEnginePort !== null &&
      (!Number.isSafeInteger(this.runtimeEnginePort) ||
        this.runtimeEnginePort < 1_024 ||
        this.runtimeEnginePort > 65_535 ||
        this.runtimeEnginePort === 22_222)
    ) {
      throw new Error("Cloud workspace runtime engine port is invalid");
    }
    this.workosEnabled = input.workosEnabled === true;
  }

  private async providerFor(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    purpose: CloudWorkspaceProviderPurpose;
  }): Promise<CloudWorkspaceAccessProvider> {
    if (this.providerResolver) {
      return (await this.providerResolver.resolve(input)).provider;
    }
    return this.provider!;
  }

  async issue(input: {
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    kind: CloudWorkspaceClientAccessKind;
    purpose?: CloudWorkspaceAccessPurpose;
    expectedGeneration?: number;
    deviceId?: string;
    requestedLocalPort?: number;
    remotePort?: number;
    expiresInMinutes: number;
    idempotencyKey: string;
  }): Promise<CloudWorkspaceAccessDocument> {
    assertUuid(input.organizationId, "Organization");
    assertUuid(input.workspaceId, "Cloud workspace");
    assertUuid(input.accountUserId, "Account");
    if (!IDEMPOTENCY_PATTERN.test(input.idempotencyKey)) {
      throw new HttpError(
        422,
        "idempotency_key_required",
        "Idempotency-Key must contain 8-128 safe ASCII characters",
      );
    }
    const purpose = input.purpose ?? "user";
    if (
      !["user", "engine-runtime"].includes(purpose) ||
      (input.expectedGeneration !== undefined &&
        (!Number.isSafeInteger(input.expectedGeneration) ||
          input.expectedGeneration < 1)) ||
      (purpose === "engine-runtime" && input.expectedGeneration === undefined)
    ) {
      throw new HttpError(
        422,
        "invalid_input",
        "Cloud workspace access scope is invalid",
      );
    }
    const deviceId = input.kind === "tunnel" ? input.deviceId : undefined;
    if (
      (input.kind === "tunnel" &&
        (typeof deviceId !== "string" || !UUID_PATTERN.test(deviceId))) ||
      (input.kind !== "tunnel" &&
        (input.deviceId !== undefined || input.requestedLocalPort !== undefined))
    ) {
      throw new HttpError(
        422,
        "invalid_input",
        "Cloud tunnel device scope is invalid",
      );
    }
    const requestedLocalPort = normalizedOptionalPort(input.requestedLocalPort);
    const expiresInMinutes = normalizedTtl(input.expiresInMinutes);
    const remotePort = normalizedPort(
      input.kind,
      input.remotePort,
      this.forbiddenPorts,
      purpose,
      this.runtimeEnginePort,
    );
    if (input.kind === "preview" && !this.previewBaseDomain) {
      throw new HttpError(
        503,
        "cloud_preview_not_configured",
        "Cloud workspace preview proxy is not configured",
      );
    }
    const digest = requestDigest({
      operation: "issue-cloud-access",
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      accountUserId: input.accountUserId,
      kind: input.kind,
      purpose,
      expectedGeneration: input.expectedGeneration ?? null,
      deviceId: deviceId ?? null,
      requestedLocalPort,
      remotePort,
      expiresInMinutes,
    });
    const requestedExpiresAt = new Date(Date.now() + expiresInMinutes * 60_000);
    const grantId = randomUUID();
    const forwardSessionId = input.kind === "tunnel" ? randomUUID() : null;
    const previewProxyLabel =
      input.kind === "preview" ? randomBytes(16).toString("hex") : null;

    const prepared = await withSystemTx(this.pool, async (tx) => {
      const workspace = await authorizedWorkspace(tx, {
        ...input,
        workosEnabled: this.workosEnabled,
      });
      if (
        input.expectedGeneration !== undefined &&
        workspace.generation !== input.expectedGeneration
      ) {
        throw new HttpError(
          409,
          "cloud_workspace_access_superseded",
          "Cloud workspace changed before access could be issued",
        );
      }
      if (deviceId) {
        await assertActiveDevice(tx, {
          deviceId,
          accountUserId: input.accountUserId,
        });
      }
      // The account-scoped key spans workspaces, while the workspace row lock
      // above only serializes requests for one workspace. Let the unique index
      // arbitrate cross-workspace races instead of leaking a raw 23505 when
      // two transactions both observe no prior row.
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspace_client_access_grants (
           id, workspace_id, generation, org_id, account_user_id, kind,
           remote_port, provider_resource_id, preview_proxy_label,
           idempotency_key, request_sha256, requested_expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (org_id, account_user_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          grantId,
          input.workspaceId,
          workspace.generation,
          input.organizationId,
          input.accountUserId,
          input.kind,
          remotePort,
          workspace.provider_resource_id,
          previewProxyLabel,
          input.idempotencyKey,
          digest,
          requestedExpiresAt,
        ],
      );
      if ((inserted.rowCount ?? 0) !== 1) {
        const existing = await tx.query<{
          workspace_id: string;
          request_sha256: Buffer;
        }>(
          `/* idempotency-conflict */
           SELECT workspace_id, request_sha256
           FROM cloud_workspace_client_access_grants
           WHERE org_id = $1 AND account_user_id = $2
             AND idempotency_key = $3`,
          [input.organizationId, input.accountUserId, input.idempotencyKey],
        );
        const replay = existing.rows[0];
        if (!replay) {
          throw new Error("cloud access idempotency conflict disappeared");
        }
        if (
          replay.workspace_id !== input.workspaceId ||
          !sameHash(replay.request_sha256, digest)
        ) {
          throw new HttpError(
            409,
            "idempotency_key_reused",
            "Idempotency-Key was already used with different parameters",
          );
        }
        // The raw bearer is deliberately absent from PostgreSQL, so a replay
        // can never reproduce the original response safely.
        throw new HttpError(
          409,
          "cloud_access_response_not_replayable",
          "Cloud access was already issued; request a fresh grant",
        );
      }
      if (input.kind !== "preview") {
        const revoking = await tx.query(
          `SELECT 1 FROM cloud_workspace_client_access_grants
           WHERE workspace_id = $1 AND generation = $2
             AND kind IN ('ssh', 'tunnel')
             AND state = 'revocation_pending'
           LIMIT 1`,
          [input.workspaceId, workspace.generation],
        );
        if ((revoking.rowCount ?? 0) !== 0) {
          throw new HttpError(
            409,
            "cloud_access_revocation_in_progress",
            "Prior SSH access is still being revoked",
          );
        }
      }
      return workspace;
    });

    let credential: string;
    let expiresAt: Date;
    let ssh: CloudProviderSshAccess | null = null;
    let providerAccessId: string | null = null;
    try {
      const provider = await this.providerFor({
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        generation: prepared.generation,
        purpose: input.kind === "preview" ? "preview" : "ssh",
      });
      if (input.kind === "preview") {
        credential = `zwp_${randomBytes(32).toString("base64url")}`;
        if (!PREVIEW_CAPABILITY_PATTERN.test(credential)) {
          throw new Error("preview capability generation failed");
        }
        expiresAt = requestedExpiresAt;
        // Prove the exact private provider endpoint now; the raw provider
        // token is intentionally discarded and resolved again only in proxy
        // memory while a request is authorized.
        await provider.getPreviewEndpoint(
          prepared.provider_resource_id,
          remotePort!,
        );
      } else {
        ssh = await provider.createSshAccess(
          prepared.provider_resource_id,
          expiresInMinutes,
        );
        providerAccessId = safeProviderAccessId(ssh.providerAccessId);
        credential = ssh.credential;
        expiresAt = ssh.expiresAt;
      }
    } catch (error) {
      // Failure recording is best-effort at this boundary. The durable
      // `issuing` row remains a recovery marker when PostgreSQL is temporarily
      // unavailable, and the revocation worker converts stale issuance into a
      // provider-wide drain. Do not mask the fixed, non-oracular provider error
      // with an internal database exception returned to the caller.
      await withSystemTx(this.pool, async (tx) => {
        if (input.kind === "preview") {
          await tx.query(
            `UPDATE cloud_workspace_client_access_grants
             SET state = 'failed', error_code = 'provider_access_failed',
                 error_message = 'Provider access issuance did not complete',
                 updated_at = now()
             WHERE id = $1 AND state = 'issuing'`,
            [grantId],
          );
        } else {
          // A timeout or malformed response can occur after Daytona minted an
          // SSH bearer. No raw token may be available to revoke exactly, so
          // durably schedule provider-wide revocation instead of publishing a
          // terminal local failure that could leave remote access live.
          await tx.query(
            `UPDATE cloud_workspace_client_access_grants
             SET state = 'revocation_pending',
                 revocation_reason = 'access_issue_unknown',
                 next_revocation_at = now(),
                 error_code = 'provider_access_failed',
                 error_message = 'Provider access issuance did not complete',
                 updated_at = now()
             WHERE id = $1 AND state = 'issuing'`,
            [grantId],
          );
        }
        await audit(
          tx,
          input.organizationId,
          input.accountUserId,
          "cloud_workspace.access_issue_failed",
          {
            workspaceId: input.workspaceId,
            grantId,
            kind: input.kind,
            purpose,
            generation: prepared.generation,
          },
        );
      }).catch(() => undefined);
      throw providerHttpError(error, "access issuance");
    }

    let published = false;
    try {
      published = await withSystemTx(this.pool, async (tx) => {
        const current = await authorizedWorkspace(tx, {
          ...input,
          workosEnabled: this.workosEnabled,
        });
        const grant = await tx.query<{ state: string }>(
          `SELECT state FROM cloud_workspace_client_access_grants
           WHERE id = $1 FOR UPDATE`,
          [grantId],
        );
        if (
          grant.rows[0]?.state !== "issuing" ||
          current.generation !== prepared.generation ||
          current.provider_resource_id !== prepared.provider_resource_id
        ) {
          return false;
        }
        const updated = await tx.query(
          `UPDATE cloud_workspace_client_access_grants
           SET state = 'active', token_hash = $2, provider_access_id = $3,
               expires_at = $4, issued_at = now(), updated_at = now()
           WHERE id = $1 AND state = 'issuing'`,
          [
            grantId,
            hashToken(credential),
            providerAccessId,
            expiresAt,
          ],
        );
        if ((updated.rowCount ?? 0) !== 1) return false;
        if (deviceId && forwardSessionId) {
          await assertActiveDevice(tx, {
            deviceId,
            accountUserId: input.accountUserId,
          });
          await tx.query(
            `INSERT INTO port_forward_sessions (
               id, workspace_id, generation, org_id, user_id, device_id,
               access_grant_id, remote_port, requested_local_port, expires_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              forwardSessionId,
              input.workspaceId,
              prepared.generation,
              input.organizationId,
              input.accountUserId,
              deviceId,
              grantId,
              remotePort,
              requestedLocalPort,
              expiresAt,
            ],
          );
        }
        await audit(
          tx,
          input.organizationId,
          input.accountUserId,
          "cloud_workspace.access_issued",
          {
            workspaceId: input.workspaceId,
            grantId,
            kind: input.kind,
            purpose,
            generation: prepared.generation,
            remotePort,
            expiresAt: expiresAt.toISOString(),
          },
        );
        return true;
      });
    } catch (error) {
      await this.cleanupUnpublishedGrant({
        grantId,
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        generation: prepared.generation,
        providerResourceId: prepared.provider_resource_id,
        credential,
        expiresAt,
        providerAccessId: ssh?.providerAccessId ?? null,
        kind: input.kind,
      });
      throw error;
    }
    if (!published) {
      await this.cleanupUnpublishedGrant({
        grantId,
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        generation: prepared.generation,
        providerResourceId: prepared.provider_resource_id,
        credential,
        expiresAt,
        providerAccessId: ssh?.providerAccessId ?? null,
        kind: input.kind,
      });
      throw new HttpError(
        409,
        "cloud_workspace_access_superseded",
        "Cloud workspace changed while access was being issued",
      );
    }

    const common = {
      id: grantId,
      kind: input.kind,
      workspaceId: input.workspaceId,
      generation: prepared.generation,
      remotePort,
      expiresAt: expiresAt.toISOString(),
    };
    if (input.kind === "ssh") {
      return {
        grant: common,
        ssh: {
          username: credential,
          host: ssh!.host,
          command: ssh!.command,
        },
      };
    }
    if (input.kind === "tunnel") {
      return {
        grant: common,
        tunnel: {
          sshUsername: credential,
          sshHost: ssh!.host,
          remoteHost: "127.0.0.1",
          remotePort: remotePort!,
          session: {
            id: forwardSessionId!,
            deviceId: deviceId!,
            state: "starting",
          },
        },
      };
    }
    return {
      grant: common,
      preview: {
        logicalUrl: `http://localhost:${remotePort}/`,
        origin: `https://${previewProxyLabel}.${this.previewBaseDomain}`,
        capability: credential,
        headerName: "x-zeros-preview-capability",
      },
    };
  }

  async activateTunnel(input: {
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    sessionId: string;
    deviceId: string;
    observedLocalPort: number;
  }): Promise<{
    id: string;
    deviceId: string;
    state: "active";
    bindAddress: "127.0.0.1";
    observedLocalPort: number;
  }> {
    assertUuid(input.organizationId, "Organization");
    assertUuid(input.workspaceId, "Cloud workspace");
    assertUuid(input.accountUserId, "Account");
    assertUuid(input.sessionId, "Port forward session");
    assertUuid(input.deviceId, "Device");
    const observedLocalPort = normalizedRequiredPort(input.observedLocalPort);
    return withSystemTx(this.pool, async (tx) => {
      const workspace = await authorizedWorkspace(tx, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        accountUserId: input.accountUserId,
        workosEnabled: this.workosEnabled,
      });
      await assertActiveDevice(tx, {
        deviceId: input.deviceId,
        accountUserId: input.accountUserId,
      });
      const updated = await tx.query<{ id: string }>(
        `UPDATE port_forward_sessions session
         SET state = 'active', observed_local_port = $6, updated_at = now()
         FROM cloud_workspace_client_access_grants access
         WHERE session.id = $1 AND session.workspace_id = $2
           AND session.org_id = $3 AND session.user_id = $4
           AND session.device_id = $5 AND session.state = 'starting'
           AND session.generation = $7
           AND session.expires_at > now()
           AND access.id = session.access_grant_id
           AND access.workspace_id = session.workspace_id
           AND access.generation = session.generation
           AND access.org_id = session.org_id
           AND access.kind = 'tunnel' AND access.state = 'active'
           AND access.expires_at > now()
         RETURNING session.id`,
        [
          input.sessionId,
          input.workspaceId,
          input.organizationId,
          input.accountUserId,
          input.deviceId,
          observedLocalPort,
          workspace.generation,
        ],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new HttpError(
          409,
          "cloud_access_not_active",
          "Cloud tunnel is no longer eligible for activation",
        );
      }
      await audit(
        tx,
        input.organizationId,
        input.accountUserId,
        "cloud_workspace.tunnel_activated",
        {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          deviceId: input.deviceId,
          generation: workspace.generation,
          observedLocalPort,
        },
      );
      return {
        id: input.sessionId,
        deviceId: input.deviceId,
        state: "active" as const,
        bindAddress: "127.0.0.1" as const,
        observedLocalPort,
      };
    });
  }

  private async cleanupUnpublishedGrant(input: {
    grantId: string;
    workspaceId: string;
    organizationId: string;
    generation: number;
    providerResourceId: string;
    credential: string;
    expiresAt: Date;
    providerAccessId: string | null;
    kind: CloudWorkspaceClientAccessKind;
  }): Promise<void> {
    if (input.kind === "preview") {
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE cloud_workspace_client_access_grants
           SET state = 'failed', error_code = 'access_issue_superseded',
               error_message = 'Workspace changed before access publication',
               updated_at = now()
           WHERE id = $1 AND state IN ('issuing', 'revocation_pending')`,
          [input.grantId],
        ),
      ).catch(() => undefined);
      return;
    }
    await withSystemTx(this.pool, (tx) =>
      tx.query(
        `UPDATE cloud_workspace_client_access_grants
         SET state = 'revocation_pending', token_hash = $2,
             provider_access_id = $3, expires_at = $4,
             issued_at = coalesce(issued_at, now()),
             revocation_reason = 'access_issue_superseded',
             next_revocation_at = now(), updated_at = now()
         WHERE id = $1 AND state IN ('issuing', 'failed', 'revocation_pending')`,
        [
          input.grantId,
          hashToken(input.credential),
          input.providerAccessId,
          input.expiresAt,
        ],
      ),
    ).catch(() => undefined);
    try {
      await fenceProviderWideSshRevocation(this.pool, {
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        providerResourceId: input.providerResourceId,
        reason: "access_issue_superseded",
      });
      const provider = await this.providerFor({
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        generation: input.generation,
        purpose: "cleanup",
      });
      await provider.revokeSshAccess(input.providerResourceId);
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE cloud_workspace_client_access_grants
           SET state = 'revoked', revoked_at = coalesce(revoked_at, now()),
               revocation_lease_owner = NULL,
               revocation_lease_expires_at = NULL, updated_at = now()
           WHERE provider_resource_id = $1 AND kind IN ('ssh', 'tunnel')
             AND state IN ('issuing', 'active', 'revocation_pending')`,
          [input.providerResourceId],
        ),
      );
    } catch {
      // The durable revocation worker owns the provider-wide fallback.
    }
  }

  async revoke(input: {
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    grantId: string;
    credential: string;
  }): Promise<void> {
    assertUuid(input.organizationId, "Organization");
    assertUuid(input.workspaceId, "Cloud workspace");
    assertUuid(input.accountUserId, "Account");
    assertUuid(input.grantId, "Cloud access grant");
    const credential = normalizedCredential(input.credential);
    const selected = await withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<GrantRow>(
        `SELECT access.id, access.workspace_id, access.generation,
                access.org_id, access.account_user_id, access.kind,
                access.remote_port, access.provider_resource_id,
                access.provider_access_id, access.preview_proxy_label,
                access.token_hash, access.state, access.expires_at
         FROM cloud_workspace_client_access_grants access
         JOIN cloud_workspaces cw
           ON cw.id = access.workspace_id AND cw.org_id = access.org_id
         JOIN organization_members om
           ON om.org_id = cw.org_id AND om.user_id = $3
         JOIN team_members tm
           ON tm.team_id = cw.team_id AND tm.org_id = cw.org_id
          AND tm.user_id = $3
         WHERE access.id = $4 AND access.workspace_id = $2
           AND access.org_id = $1 AND access.account_user_id = $3
         FOR UPDATE OF access`,
        [
          input.organizationId,
          input.workspaceId,
          input.accountUserId,
          input.grantId,
        ],
      );
      const grant = result.rows[0];
      if (!grant || !sameHash(grant.token_hash, hashToken(credential))) {
        throw new HttpError(404, "not_found", "Cloud access grant not found");
      }
      if (grant.state === "revoked") return grant;
      if (!["active", "revocation_pending"].includes(grant.state)) {
        throw new HttpError(
          409,
          "cloud_access_not_active",
          "Cloud access grant is not active",
        );
      }
      await tx.query(
        `UPDATE cloud_workspace_client_access_grants
         SET state = 'revocation_pending',
             revocation_reason = 'account_revoked',
             next_revocation_at = now(), updated_at = now()
         WHERE id = $1`,
        [grant.id],
      );
      return grant;
    });
    if (selected.state === "revoked") return;
    try {
      if (selected.kind !== "preview") {
        await fenceProviderWideSshRevocation(this.pool, {
          workspaceId: selected.workspace_id,
          organizationId: selected.org_id,
          providerResourceId: selected.provider_resource_id,
          reason: "provider_wide_account_revoked",
        });
        // The submitted bearer proved possession against our verifier. Do not
        // forward it to Daytona's exact-revoke query parameter: revoke every
        // sandbox SSH token and reflect that broader provider fact below.
        const provider = await this.providerFor({
          workspaceId: selected.workspace_id,
          organizationId: selected.org_id,
          generation: selected.generation,
          purpose: "cleanup",
        });
        await provider.revokeSshAccess(selected.provider_resource_id);
      }
    } catch (error) {
      throw providerHttpError(error, "access revocation");
    }
    await withSystemTx(this.pool, async (tx) => {
      if (selected.kind === "preview") {
        await tx.query(
          `UPDATE cloud_workspace_client_access_grants
           SET state = 'revoked', revoked_at = coalesce(revoked_at, now()),
               revocation_lease_owner = NULL,
               revocation_lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND state = 'revocation_pending'`,
          [selected.id],
        );
      } else {
        await tx.query(
          `UPDATE cloud_workspace_client_access_grants
           SET state = 'revoked', revoked_at = coalesce(revoked_at, now()),
               revocation_lease_owner = NULL,
               revocation_lease_expires_at = NULL, updated_at = now()
           WHERE provider_resource_id = $1 AND kind IN ('ssh', 'tunnel')
             AND state IN ('issuing', 'active', 'revocation_pending')`,
          [selected.provider_resource_id],
        );
      }
      await audit(
        tx,
        input.organizationId,
        input.accountUserId,
        "cloud_workspace.access_revoked",
        {
          workspaceId: input.workspaceId,
          grantId: selected.id,
          generation: selected.generation,
          kind: selected.kind,
        },
      );
    });
  }

  async handlePreviewRequest(request: Request): Promise<Response | null> {
    const identity = this.previewIdentity(request.url);
    if (!identity) return null;
    if (request.headers.get("upgrade")) {
      return new Response("Use Forward to this Mac for WebSocket previews", {
        status: 426,
        headers: { "cache-control": "no-store" },
      });
    }
    const capability = request.headers.get("x-zeros-preview-capability");
    if (!capability || !PREVIEW_CAPABILITY_PATTERN.test(capability)) {
      return this.previewDenied();
    }
    const grant = await withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<
        GrantRow & { provider_binding_updated_at: Date | string }
      >(
        `SELECT access.id, access.workspace_id, access.generation,
                access.org_id, access.account_user_id, access.kind,
                access.remote_port, access.provider_resource_id,
                access.provider_access_id, access.preview_proxy_label,
                access.token_hash, access.state, access.expires_at,
                pb.updated_at AS provider_binding_updated_at
         FROM cloud_workspace_client_access_grants access
         JOIN cloud_workspaces cw
           ON cw.id = access.workspace_id AND cw.org_id = access.org_id
          AND cw.current_generation = access.generation
         JOIN organizations organization
           ON organization.id = cw.org_id
          AND organization.deleted_at IS NULL
         JOIN teams team
           ON team.id = cw.team_id AND team.org_id = cw.org_id
          AND team.deleted_at IS NULL
         JOIN organization_members om
           ON om.org_id = cw.org_id AND om.user_id = access.account_user_id
         JOIN team_members tm
           ON tm.team_id = cw.team_id AND tm.org_id = cw.org_id
          AND tm.user_id = access.account_user_id
         JOIN users account
           ON account.id = access.account_user_id
          AND account.deleted_at IS NULL AND account.auth_status = 'active'
         JOIN cloud_workspace_generations generation
           ON generation.workspace_id = access.workspace_id
          AND generation.generation = access.generation
          AND generation.org_id = access.org_id
         JOIN provider_connections provider_connection
           ON provider_connection.id = generation.provider_connection_id
          AND provider_connection.org_id = generation.org_id
          AND provider_connection.state = 'active'
         JOIN cloud_workspace_provider_bindings pb
           ON pb.workspace_id = access.workspace_id
          AND pb.generation = access.generation AND pb.org_id = access.org_id
          AND pb.provider_resource_id = access.provider_resource_id
         WHERE access.preview_proxy_label = $1 AND access.kind = 'preview'
           AND access.state = 'active' AND access.expires_at > now()
           AND cw.deleted_at IS NULL AND cw.desired_state = 'running'
           AND cw.single_member_mode
           AND cw.owner_user_id = access.account_user_id
           AND cw.status IN ('ready', 'busy')
           AND pb.observed_state = 'running'
           AND cloud_workspace_generation_policy_current(
             cw.id, cw.current_generation, cw.org_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM cloud_workspace_generation_secret_bindings secret_link
             JOIN secret_bindings secret
               ON secret.id = secret_link.binding_id
              AND secret.org_id = secret_link.org_id
             WHERE secret_link.workspace_id = access.workspace_id
               AND secret_link.generation = access.generation
               AND secret_link.org_id = access.org_id
               AND secret.state <> 'active'
           )
           AND cloud_workspace_runtime_authority_live(
             cw.id, access.generation, access.account_user_id, $2
           )`,
        [identity.label, this.workosEnabled],
      );
      return result.rows[0] ?? null;
    });
    if (!grant || !sameHash(grant.token_hash, hashToken(capability))) {
      return this.previewDenied();
    }

    const releasePreviewRequest = this.acquirePreviewRequest(grant.id);
    if (!releasePreviewRequest) {
      return new Response("Too many concurrent preview requests", {
        status: 429,
        headers: { "cache-control": "no-store", "retry-after": "1" },
      });
    }

    let responseOwnsRelease = false;
    try {
      const inputUrl = new URL(request.url);
      const endpoint = await this.cachedPreviewEndpoint(
        grant.workspace_id,
        grant.org_id,
        grant.generation,
        grant.provider_resource_id,
        grant.remote_port!,
        iso(grant.provider_binding_updated_at),
      ).catch(() => null);
      if (!endpoint) {
        return new Response("Preview is temporarily unavailable", {
          status: 503,
          headers: { "cache-control": "no-store" },
        });
      }
      const upstreamUrl = new URL(endpoint.url);
      upstreamUrl.pathname = inputUrl.pathname;
      upstreamUrl.search = inputUrl.search;
      const headers = this.proxyRequestHeaders(request.headers, inputUrl.host);
      headers.set(endpoint.headerName, endpoint.headerValue);
      let body: Buffer | undefined;
      try {
        body = await this.boundedRequestBody(request);
      } catch {
        return new Response("Preview request body is too large", {
          status: 413,
          headers: { "cache-control": "no-store" },
        });
      }
      const init: RequestInit = {
        method: request.method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
        ...(body ? { body } : {}),
      };
      let response: Response;
      try {
        response = await this.fetcher(upstreamUrl.toString(), init);
      } catch {
        return new Response("Preview is temporarily unavailable", {
          status: 502,
          headers: { "cache-control": "no-store" },
        });
      }
      const proxied = this.proxyResponse(
        response,
        inputUrl.origin,
        endpoint.url,
        releasePreviewRequest,
      );
      responseOwnsRelease = true;
      return proxied;
    } finally {
      if (!responseOwnsRelease) releasePreviewRequest();
    }
  }

  recognizesPreviewRequest(request: Request): boolean {
    return this.previewIdentity(request.url) !== null;
  }

  private previewIdentity(rawUrl: string): { label: string } | null {
    if (!this.previewBaseDomain) return null;
    try {
      const url = new URL(rawUrl);
      const suffix = `.${this.previewBaseDomain}`;
      if (
        url.protocol !== "https:" ||
        url.port ||
        !url.hostname.endsWith(suffix)
      ) {
        return null;
      }
      const label = url.hostname.slice(0, -suffix.length);
      return /^[a-f0-9]{32}$/.test(label) ? { label } : null;
    } catch {
      return null;
    }
  }

  private previewDenied(): Response {
    return new Response("Preview authorization is invalid or expired", {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": 'ZerosPreview realm="cloud-workspace"',
      },
    });
  }

  private acquirePreviewRequest(grantId: string): (() => void) | null {
    const perGrant = this.concurrentPreviewRequestsByGrant.get(grantId) ?? 0;
    if (
      this.concurrentPreviewRequests >= MAX_CONCURRENT_PREVIEW_REQUESTS ||
      perGrant >= MAX_CONCURRENT_PREVIEW_REQUESTS_PER_GRANT
    ) {
      return null;
    }
    this.concurrentPreviewRequests += 1;
    this.concurrentPreviewRequestsByGrant.set(grantId, perGrant + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.concurrentPreviewRequests = Math.max(
        0,
        this.concurrentPreviewRequests - 1,
      );
      const remaining =
        (this.concurrentPreviewRequestsByGrant.get(grantId) ?? 1) - 1;
      if (remaining <= 0) {
        this.concurrentPreviewRequestsByGrant.delete(grantId);
      } else {
        this.concurrentPreviewRequestsByGrant.set(grantId, remaining);
      }
    };
  }

  private async cachedPreviewEndpoint(
    workspaceId: string,
    organizationId: string,
    generation: number,
    resourceId: string,
    port: number,
    bindingVersion: string,
  ): Promise<CloudProviderPreviewEndpoint> {
    const key = `${workspaceId}\0${organizationId}\0${generation}\0${resourceId}\0${port}\0${bindingVersion}`;
    const now = Date.now();
    const cached = this.previewEndpoints.get(key);
    if (cached && cached.expiresAt > now) return cached.endpoint;
    this.previewEndpoints.delete(key);
    const pending = this.previewEndpointRequests.get(key);
    if (pending) return pending;
    if (this.previewEndpointRequests.size >= PREVIEW_ENDPOINT_CACHE_SIZE) {
      throw new Error("cloud preview endpoint lookup capacity exceeded");
    }
    const request = (async () => {
      const provider = await this.providerFor({
        workspaceId,
        organizationId,
        generation,
        purpose: "preview",
      });
      const endpoint = await provider.getPreviewEndpoint(resourceId, port);
      this.previewEndpoints.set(key, {
        endpoint,
        expiresAt: Date.now() + PREVIEW_ENDPOINT_CACHE_MS,
      });
      while (this.previewEndpoints.size > PREVIEW_ENDPOINT_CACHE_SIZE) {
        const oldest = this.previewEndpoints.keys().next().value as
          | string
          | undefined;
        if (!oldest) break;
        this.previewEndpoints.delete(oldest);
      }
      return endpoint;
    })();
    this.previewEndpointRequests.set(key, request);
    try {
      return await request;
    } finally {
      if (this.previewEndpointRequests.get(key) === request) {
        this.previewEndpointRequests.delete(key);
      }
    }
  }

  private proxyRequestHeaders(source: Headers, publicHost: string): Headers {
    const allowed = new Set([
      "accept",
      "accept-language",
      "authorization",
      "cache-control",
      "content-type",
      "cookie",
      "if-match",
      "if-modified-since",
      "if-none-match",
      "if-unmodified-since",
      "range",
      "user-agent",
    ]);
    const headers = new Headers();
    for (const [name, value] of source) {
      if (allowed.has(name.toLowerCase())) headers.set(name, value);
    }
    headers.set("x-forwarded-host", publicHost);
    headers.set("x-forwarded-proto", "https");
    headers.set("x-daytona-skip-last-activity-update", "true");
    return headers;
  }

  private async boundedRequestBody(
    request: Request,
  ): Promise<Buffer | undefined> {
    if (["GET", "HEAD"].includes(request.method.toUpperCase()))
      return undefined;
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_PROXY_REQUEST_BYTES) {
      throw new Error("body too large");
    }
    if (!request.body) return undefined;
    const reader = request.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      total += chunk.length;
      if (total > MAX_PROXY_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("body too large");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }

  private proxyResponse(
    upstream: Response,
    publicOrigin: string,
    endpointUrl: string,
    release: () => void,
  ): Response {
    const headers = new Headers();
    const blocked = new Set([
      "connection",
      "content-encoding",
      "content-length",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "set-cookie",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]);
    for (const [name, value] of upstream.headers) {
      if (blocked.has(name.toLowerCase())) continue;
      if (name.toLowerCase().startsWith("x-daytona-")) continue;
      headers.append(name, value);
    }
    const location = upstream.headers.get("location");
    if (location) {
      try {
        const endpoint = new URL(endpointUrl);
        const target = new URL(location, endpoint);
        if (target.origin === endpoint.origin) {
          headers.set(
            "location",
            `${publicOrigin}${target.pathname}${target.search}${target.hash}`,
          );
        } else {
          headers.set("location", target.toString());
        }
      } catch {
        headers.delete("location");
      }
    }
    const getSetCookie = (
      upstream.headers as Headers & { getSetCookie?: () => string[] }
    ).getSetCookie;
    for (const cookie of getSetCookie?.call(upstream.headers) ?? []) {
      headers.append("set-cookie", cookie.replace(/;\s*domain=[^;]*/gi, ""));
    }
    headers.set("cache-control", "no-store");
    headers.set("referrer-policy", "no-referrer");
    const body = this.releaseTrackedBody(upstream.body, release);
    try {
      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (error) {
      void body?.cancel().catch(() => undefined);
      throw error;
    }
  }

  private releaseTrackedBody(
    source: ReadableStream<Uint8Array> | null,
    release: () => void,
  ): ReadableStream<Uint8Array> | null {
    if (!source) {
      release();
      return null;
    }
    const reader = source.getReader();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      release();
    };
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) {
            finish();
            controller.close();
          } else {
            controller.enqueue(item.value);
          }
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    });
  }
}

type RevocationClaim = {
  id: string;
  workspace_id: string;
  generation: number;
  org_id: string;
  kind: CloudWorkspaceClientAccessKind;
  provider_resource_id: string;
  revocation_attempt_count: number;
};

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
}

export class CloudWorkspaceAccessRevocationWorker {
  private readonly workerId = `access-revoker:${randomUUID()}`;
  private readonly pool: pg.Pool;
  private readonly provider: CloudWorkspaceAccessProvider | null;
  private readonly providerResolver: CloudWorkspaceProviderResolver | null;
  private readonly leaseMs: number;
  private readonly intervalMs: number;
  private readonly maxBatch: number;
  private readonly logger: Pick<Console, "error">;
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;
  private stopped = false;

  constructor(input: {
    pool: pg.Pool;
    provider?: CloudWorkspaceAccessProvider;
    providerResolver?: CloudWorkspaceProviderResolver;
    leaseMs: number;
    intervalMs?: number;
    maxBatch?: number;
    logger?: Pick<Console, "error">;
  }) {
    if ((input.provider ? 1 : 0) + (input.providerResolver ? 1 : 0) !== 1) {
      throw new Error(
        "Cloud access revocation requires exactly one provider boundary",
      );
    }
    this.pool = input.pool;
    this.provider = input.provider ?? null;
    this.providerResolver = input.providerResolver ?? null;
    this.leaseMs = input.leaseMs;
    this.intervalMs = input.intervalMs ?? 1_000;
    this.maxBatch = input.maxBatch ?? 100;
    this.logger = input.logger ?? console;
    if (
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 1_000 ||
      this.leaseMs > 60 * 60_000 ||
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 100 ||
      this.intervalMs > 60_000 ||
      !Number.isSafeInteger(this.maxBatch) ||
      this.maxBatch < 1 ||
      this.maxBatch > 1_000
    ) {
      throw new Error("Cloud access revocation worker timing is invalid");
    }
  }

  async runOnce(): Promise<boolean> {
    const claim = await this.claim();
    if (!claim) return false;
    try {
      if (claim.kind !== "preview") {
        await fenceProviderWideSshRevocation(this.pool, {
          workspaceId: claim.workspace_id,
          organizationId: claim.org_id,
          providerResourceId: claim.provider_resource_id,
          reason: "provider_wide_revocation",
        });
        const provider = this.providerResolver
          ? (
              await this.providerResolver.resolve({
                workspaceId: claim.workspace_id,
                organizationId: claim.org_id,
                generation: claim.generation,
                purpose: "cleanup",
              })
            ).provider
          : this.provider!;
        await provider.revokeSshAccess(claim.provider_resource_id);
      }
      await this.complete(claim);
    } catch (error) {
      await this.retry(claim, error);
    }
    return true;
  }

  start(): () => Promise<void> {
    if (this.timer || this.activeTick || this.stopped) {
      return async () => this.stop();
    }
    const run = () => {
      if (this.stopped || this.activeTick) return;
      const task = this.drain().catch((error) => {
        this.logger.error(
          `[cloud-workspace] access revocation tick failed: ${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      });
      this.activeTick = task;
      void task.finally(() => {
        if (this.activeTick === task) this.activeTick = null;
      });
    };
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref();
    run();
    return async () => this.stop();
  }

  private async drain(): Promise<void> {
    let processed = 0;
    while (
      !this.stopped &&
      processed < this.maxBatch &&
      (await this.runOnce())
    ) {
      processed += 1;
    }
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activeTick;
  }

  private claim(): Promise<RevocationClaim | null> {
    return withSystemTx(this.pool, async (tx) => {
      // Provider TTL is authoritative after expiry; no remote mutation is
      // needed merely to retire the local verifier.
      await tx.query(
        `UPDATE cloud_workspace_client_access_grants
         SET state = 'revoked', revoked_at = coalesce(revoked_at, now()),
             updated_at = now()
         WHERE state = 'active' AND expires_at <= now()`,
      );
      // A process can die after provider issuance and before publication.
      // Convert the durable `issuing` marker into a provider-wide drain.
      await tx.query(
        `UPDATE cloud_workspace_client_access_grants
         SET state = 'revocation_pending',
             revocation_reason = 'stale_issuance',
             next_revocation_at = now(), updated_at = now()
         WHERE state = 'issuing'
           AND created_at < now() - interval '2 minutes'`,
      );
      const selected = await tx.query<RevocationClaim>(
        `SELECT id, workspace_id, generation, org_id, kind,
                provider_resource_id, revocation_attempt_count
         FROM cloud_workspace_client_access_grants
         WHERE state = 'revocation_pending' AND next_revocation_at <= now()
           AND (
             revocation_lease_expires_at IS NULL
             OR revocation_lease_expires_at <= now()
           )
         ORDER BY next_revocation_at, created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      const row = selected.rows[0];
      if (!row) return null;
      await tx.query(
        `UPDATE cloud_workspace_client_access_grants
         SET revocation_attempt_count = revocation_attempt_count + 1,
             revocation_lease_owner = $2,
             revocation_lease_expires_at =
               now() + ($3::bigint * interval '1 millisecond'),
             updated_at = now()
         WHERE id = $1`,
        [row.id, this.workerId, this.leaseMs],
      );
      return {
        ...row,
        revocation_attempt_count: row.revocation_attempt_count + 1,
      };
    });
  }

  private complete(claim: RevocationClaim): Promise<void> {
    return withSystemTx(this.pool, async (tx) => {
      const owned = await tx.query(
        `SELECT 1 FROM cloud_workspace_client_access_grants
         WHERE id = $1 AND state = 'revocation_pending'
           AND revocation_lease_owner = $2
         FOR UPDATE`,
        [claim.id, this.workerId],
      );
      if ((owned.rowCount ?? 0) !== 1) return;
      if (claim.kind === "preview") {
        await tx.query(
          `UPDATE cloud_workspace_client_access_grants
           SET state = 'revoked', revoked_at = coalesce(revoked_at, now()),
               revocation_lease_owner = NULL,
               revocation_lease_expires_at = NULL, updated_at = now()
           WHERE id = $1`,
          [claim.id],
        );
      } else {
        // Daytona's credential-free revocation invalidates every SSH token for
        // the sandbox. Reflect that provider fact for all matching grants.
        await tx.query(
          `UPDATE cloud_workspace_client_access_grants
           SET state = 'revoked', revoked_at = coalesce(revoked_at, now()),
               revocation_lease_owner = NULL,
               revocation_lease_expires_at = NULL, updated_at = now()
           WHERE provider_resource_id = $1 AND kind IN ('ssh', 'tunnel')
             AND state IN ('issuing', 'active', 'revocation_pending')`,
          [claim.provider_resource_id],
        );
      }
      await audit(
        tx,
        claim.org_id,
        null,
        "cloud_workspace.access_provider_revoked",
        {
          workspaceId: claim.workspace_id,
          grantId: claim.id,
          generation: claim.generation,
          kind: claim.kind,
        },
      );
    });
  }

  private retry(claim: RevocationClaim, error: unknown): Promise<void> {
    const code =
      error instanceof CloudProviderError
        ? error.code
        : "provider_temporarily_unavailable";
    return withSystemTx(this.pool, async (tx) => {
      await tx.query(
        `UPDATE cloud_workspace_client_access_grants
         SET revocation_lease_owner = NULL,
             revocation_lease_expires_at = NULL,
             next_revocation_at =
               now() + ($3::bigint * interval '1 millisecond'),
             error_code = $4,
             error_message = 'Provider access revocation will be retried',
             updated_at = now()
         WHERE id = $1 AND state = 'revocation_pending'
           AND revocation_lease_owner = $2`,
        [
          claim.id,
          this.workerId,
          retryDelayMs(claim.revocation_attempt_count),
          code.slice(0, 128),
        ],
      );
      await audit(
        tx,
        claim.org_id,
        null,
        "cloud_workspace.access_revoke_retry_scheduled",
        {
          workspaceId: claim.workspace_id,
          grantId: claim.id,
          generation: claim.generation,
          kind: claim.kind,
          code,
          attempt: claim.revocation_attempt_count,
        },
      );
    });
  }
}
