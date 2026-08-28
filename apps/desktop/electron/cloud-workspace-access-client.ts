const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SSH_CREDENTIAL_PATTERN = /^[A-Za-z0-9._~-]{16,4096}$/;
const PREVIEW_CAPABILITY_PATTERN = /^zwp_[A-Za-z0-9_-]{43}$/;
const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const DEFAULT_SSH_HOSTS = ["ssh.app.daytona.io"] as const;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const SAFE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  cloud_access_credential_required:
    "An exact cloud workspace access credential is required",
  cloud_access_not_active: "Cloud workspace access is no longer active",
  cloud_access_port_forbidden:
    "That cloud workspace application port is unavailable",
  cloud_access_provider_rejected:
    "The cloud workspace provider rejected the access request",
  cloud_access_provider_unavailable:
    "The cloud workspace provider is temporarily unavailable",
  cloud_access_response_not_replayable:
    "Cloud workspace access was already issued; request a fresh grant",
  cloud_access_revocation_in_progress:
    "Prior cloud workspace SSH access is still being revoked",
  cloud_access_ttl_invalid: "Cloud workspace access expiry is invalid",
  cloud_preview_not_configured:
    "Cloud workspace preview access is not configured",
  cloud_workspace_access_not_configured:
    "Cloud workspace access is not configured",
  cloud_workspace_access_superseded:
    "The cloud workspace changed while access was being issued",
  cloud_workspace_access_unavailable:
    "Cloud workspace access is available only while the workspace is ready",
  forbidden: "Cloud workspace access is not permitted",
  idempotency_key_required:
    "Cloud workspace access request identity is required",
  idempotency_key_reused:
    "Cloud workspace access request identity was already used",
  invalid_input: "The cloud workspace access request is invalid",
  not_found: "Cloud workspace access was not found or is no longer available",
  rate_limited: "Too many cloud workspace access requests; try again shortly",
};

type AccessKind = "ssh" | "tunnel" | "preview";

export type CloudWorkspaceAccessGrant = {
  id: string;
  kind: AccessKind;
  workspaceId: string;
  generation: number;
  remotePort: number | null;
  expiresAt: string;
};

export type CloudWorkspaceSshAccess = {
  grant: CloudWorkspaceAccessGrant & { kind: "ssh"; remotePort: null };
  ssh: { username: string; host: string; command: string };
};

export type CloudWorkspaceTunnelAccess = {
  grant: CloudWorkspaceAccessGrant & {
    kind: "tunnel";
    remotePort: number;
  };
  tunnel: {
    sshUsername: string;
    sshHost: string;
    remoteHost: "127.0.0.1";
    remotePort: number;
  };
};

export type CloudWorkspacePreviewAccess = {
  grant: CloudWorkspaceAccessGrant & {
    kind: "preview";
    remotePort: number;
  };
  preview: {
    logicalUrl: string;
    origin: string;
    capability: string;
    headerName: "x-zeros-preview-capability";
  };
};

type Fetch = typeof fetch;

export class CloudWorkspaceAccessClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudWorkspaceAccessClientError";
  }

  toJSON(): { status: number; code: string; message: string } {
    return { status: this.status, code: this.code, message: this.message };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeBaseUrl(value: string, allowInsecureLoopback: boolean): string {
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
    throw new CloudWorkspaceAccessClientError(
      0,
      "invalid_request",
      `${label} is invalid`,
    );
  }
  return value;
}

function port(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_535) {
    throw new CloudWorkspaceAccessClientError(
      0,
      "invalid_request",
      `${label} must be an application port`,
    );
  }
  return value;
}

function ttl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 5 || value > 60) {
    throw new CloudWorkspaceAccessClientError(
      0,
      "invalid_request",
      "Cloud workspace access expiry must be between 5 and 60 minutes",
    );
  }
  return value;
}

function idempotencyKey(value: string): string {
  if (!IDEMPOTENCY_PATTERN.test(value)) {
    throw new CloudWorkspaceAccessClientError(
      0,
      "invalid_request",
      "Cloud workspace access request identity is invalid",
    );
  }
  return value;
}

function bearer(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 32_768 ||
    // eslint-disable-next-line no-control-regex -- bearer headers reject C0/space/DEL
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new CloudWorkspaceAccessClientError(
      401,
      "signed_out",
      "A current account session is required",
    );
  }
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("response too large");
  }
  if (!response.body) throw new Error("response missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response too large");
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function safeError(
  response: Response,
  body: unknown,
): CloudWorkspaceAccessClientError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const candidate = typeof error?.code === "string" ? error.code : "";
  const code = Object.hasOwn(SAFE_ERROR_MESSAGES, candidate)
    ? candidate
    : "request_failed";
  // A control-plane response is untrusted at this boundary. Never reflect its
  // free-form message or an unknown code into renderer-visible errors: either
  // field could accidentally contain a provider credential.
  const message =
    SAFE_ERROR_MESSAGES[code] ??
    `Cloud workspace access request failed (${response.status})`;
  return new CloudWorkspaceAccessClientError(response.status, code, message);
}

function validExpiry(
  value: unknown,
  now: number,
  expiresInMinutes: number,
): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds <= now ||
    milliseconds > now + expiresInMinutes * 60_000 + 120_000
  ) {
    return null;
  }
  return new Date(milliseconds).toISOString() === value ? value : null;
}

function validatedGrant(
  value: unknown,
  expected: {
    kind: AccessKind;
    workspaceId: string;
    remotePort: number | null;
    expiresInMinutes: number;
    now: number;
  },
): CloudWorkspaceAccessGrant | null {
  if (!isRecord(value)) return null;
  const expiresAt = validExpiry(
    value.expiresAt,
    expected.now,
    expected.expiresInMinutes,
  );
  if (
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    value.kind !== expected.kind ||
    value.workspaceId !== expected.workspaceId ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    value.remotePort !== expected.remotePort ||
    !expiresAt
  ) {
    return null;
  }
  return {
    id: value.id,
    kind: expected.kind,
    workspaceId: expected.workspaceId,
    generation: Number(value.generation),
    remotePort: expected.remotePort,
    expiresAt,
  };
}

export class CloudWorkspaceAccessClient {
  private readonly baseUrl: string;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly allowedSshHosts: ReadonlySet<string>;
  private readonly allowedPreviewHostSuffixes: ReadonlySet<string>;

  constructor(input: {
    baseUrl: string;
    fetch?: Fetch;
    now?: () => number;
    allowedSshHosts?: readonly string[];
    allowedPreviewHostSuffixes?: readonly string[];
    allowInsecureLoopback?: boolean;
  }) {
    this.baseUrl = safeBaseUrl(
      input.baseUrl,
      input.allowInsecureLoopback === true,
    );
    this.fetch = input.fetch ?? globalThis.fetch;
    this.now = input.now ?? Date.now;
    const hosts = input.allowedSshHosts ?? DEFAULT_SSH_HOSTS;
    if (
      hosts.length < 1 ||
      hosts.some(
        (host) =>
          host !== host.toLowerCase() ||
          !HOST_PATTERN.test(host) ||
          host.includes(".."),
      )
    ) {
      throw new Error("Cloud workspace SSH host allowlist is invalid");
    }
    this.allowedSshHosts = new Set(hosts);
    const previewSuffixes = input.allowedPreviewHostSuffixes ?? [];
    if (
      previewSuffixes.some(
        (suffix) =>
          suffix !== suffix.toLowerCase() ||
          !suffix.includes(".") ||
          !HOST_PATTERN.test(suffix) ||
          suffix.includes(".."),
      )
    ) {
      throw new Error("Cloud workspace preview host allowlist is invalid");
    }
    this.allowedPreviewHostSuffixes = new Set(previewSuffixes);
  }

  private path(organizationId: string, workspaceId: string): string {
    return `/v1/organizations/${uuid(organizationId, "Organization")}/cloud-workspaces/${uuid(workspaceId, "Cloud workspace")}/access`;
  }

  private async request(
    accessToken: string,
    input: {
      method: "POST" | "DELETE";
      path: string;
      expectedStatus: number;
      body?: unknown;
      idempotencyKey?: string;
      credential?: string;
    },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${bearer(accessToken)}`,
      "cache-control": "no-store",
      pragma: "no-cache",
      ...(input.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(input.idempotencyKey
        ? { "idempotency-key": idempotencyKey(input.idempotencyKey) }
        : {}),
      ...(input.credential
        ? { "x-zeros-access-credential": input.credential }
        : {}),
    };
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${input.path}`, {
        method: input.method,
        headers,
        ...(input.body === undefined
          ? {}
          : { body: JSON.stringify(input.body) }),
        redirect: "error",
        referrerPolicy: "no-referrer",
        credentials: "omit",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CloudWorkspaceAccessClientError(
        0,
        "control_plane_unavailable",
        "The cloud workspace control plane is temporarily unavailable",
      );
    }
    if (response.status === input.expectedStatus) {
      if (input.expectedStatus === 204) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      try {
        return await boundedJson(response);
      } catch {
        throw new CloudWorkspaceAccessClientError(
          response.status,
          "bad_response",
          "The cloud workspace control plane returned an invalid response",
        );
      }
    }
    let body: unknown = null;
    try {
      body = await boundedJson(response);
    } catch {
      // The public error below intentionally excludes an untrusted response.
    }
    throw safeError(response, body);
  }

  private validateSshFields(value: unknown): {
    username: string;
    host: string;
    command: string;
  } | null {
    if (!isRecord(value)) return null;
    const username = typeof value.username === "string" ? value.username : "";
    const host = typeof value.host === "string" ? value.host.toLowerCase() : "";
    if (
      !SSH_CREDENTIAL_PATTERN.test(username) ||
      value.host !== host ||
      !this.allowedSshHosts.has(host) ||
      value.command !== `ssh ${username}@${host}`
    ) {
      return null;
    }
    return { username, host, command: value.command };
  }

  private async rejectInvalidPublishedAccess(input: {
    accessToken: string;
    organizationId: string;
    workspaceId: string;
    grant: unknown;
    credential: unknown;
    message: string;
  }): Promise<never> {
    const grant = isRecord(input.grant) ? input.grant : null;
    const credential =
      typeof input.credential === "string" ? input.credential : "";
    const canRevoke =
      grant !== null &&
      typeof grant.id === "string" &&
      UUID_PATTERN.test(grant.id) &&
      (SSH_CREDENTIAL_PATTERN.test(credential) ||
        PREVIEW_CAPABILITY_PATTERN.test(credential));
    if (canRevoke) {
      try {
        await this.revoke(input.accessToken, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          grantId: grant.id as string,
          credential,
        });
      } catch {
        throw new CloudWorkspaceAccessClientError(
          503,
          "bad_response_cleanup_unverified",
          "Invalid cloud workspace access could not be safely revoked",
        );
      }
    }
    throw new CloudWorkspaceAccessClientError(
      201,
      "bad_response",
      input.message,
    );
  }

  async issueSsh(
    accessToken: string,
    input: {
      organizationId: string;
      workspaceId: string;
      expiresInMinutes: number;
      idempotencyKey: string;
    },
  ): Promise<CloudWorkspaceSshAccess> {
    const expiresInMinutes = ttl(input.expiresInMinutes);
    const body = await this.request(accessToken, {
      method: "POST",
      path: `${this.path(input.organizationId, input.workspaceId)}/ssh`,
      expectedStatus: 201,
      body: { expiresInMinutes },
      idempotencyKey: input.idempotencyKey,
    });
    const record = isRecord(body) ? body : null;
    const grant = validatedGrant(record?.grant, {
      kind: "ssh",
      workspaceId: input.workspaceId,
      remotePort: null,
      expiresInMinutes,
      now: this.now(),
    });
    const ssh = this.validateSshFields(record?.ssh);
    if (!grant || !ssh) {
      return await this.rejectInvalidPublishedAccess({
        accessToken,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        grant: record?.grant,
        credential: isRecord(record?.ssh) ? record.ssh.username : null,
        message:
          "The cloud workspace control plane returned invalid SSH access",
      });
    }
    return {
      grant: { ...grant, kind: "ssh", remotePort: null },
      ssh,
    };
  }

  async issueTunnel(
    accessToken: string,
    input: {
      organizationId: string;
      workspaceId: string;
      remotePort: number;
      expiresInMinutes: number;
      idempotencyKey: string;
    },
  ): Promise<CloudWorkspaceTunnelAccess> {
    const remotePort = port(input.remotePort, "Remote port");
    const expiresInMinutes = ttl(input.expiresInMinutes);
    const body = await this.request(accessToken, {
      method: "POST",
      path: `${this.path(input.organizationId, input.workspaceId)}/tunnels`,
      expectedStatus: 201,
      body: { remotePort, expiresInMinutes },
      idempotencyKey: input.idempotencyKey,
    });
    const record = isRecord(body) ? body : null;
    const grant = validatedGrant(record?.grant, {
      kind: "tunnel",
      workspaceId: input.workspaceId,
      remotePort,
      expiresInMinutes,
      now: this.now(),
    });
    const tunnel = isRecord(record?.tunnel) ? record.tunnel : null;
    const ssh = this.validateSshFields(
      tunnel
        ? {
            username: tunnel.sshUsername,
            host: tunnel.sshHost,
            command: `ssh ${String(tunnel.sshUsername)}@${String(tunnel.sshHost)}`,
          }
        : null,
    );
    if (
      !grant ||
      !tunnel ||
      !ssh ||
      tunnel.remoteHost !== "127.0.0.1" ||
      tunnel.remotePort !== remotePort
    ) {
      return await this.rejectInvalidPublishedAccess({
        accessToken,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        grant: record?.grant,
        credential: tunnel?.sshUsername,
        message:
          "The cloud workspace control plane returned invalid tunnel access",
      });
    }
    return {
      grant: { ...grant, kind: "tunnel", remotePort },
      tunnel: {
        sshUsername: ssh.username,
        sshHost: ssh.host,
        remoteHost: "127.0.0.1",
        remotePort,
      },
    };
  }

  async issuePreview(
    accessToken: string,
    input: {
      organizationId: string;
      workspaceId: string;
      port: number;
      expiresInMinutes: number;
      idempotencyKey: string;
    },
  ): Promise<CloudWorkspacePreviewAccess> {
    const remotePort = port(input.port, "Preview port");
    const expiresInMinutes = ttl(input.expiresInMinutes);
    if (this.allowedPreviewHostSuffixes.size === 0) {
      throw new CloudWorkspaceAccessClientError(
        0,
        "cloud_preview_not_configured",
        "Cloud workspace preview access is not configured",
      );
    }
    const body = await this.request(accessToken, {
      method: "POST",
      path: `${this.path(input.organizationId, input.workspaceId)}/previews`,
      expectedStatus: 201,
      body: { port: remotePort, expiresInMinutes },
      idempotencyKey: input.idempotencyKey,
    });
    const record = isRecord(body) ? body : null;
    const grant = validatedGrant(record?.grant, {
      kind: "preview",
      workspaceId: input.workspaceId,
      remotePort,
      expiresInMinutes,
      now: this.now(),
    });
    const preview = isRecord(record?.preview) ? record.preview : null;
    let origin: URL | null = null;
    try {
      origin =
        typeof preview?.origin === "string" ? new URL(preview.origin) : null;
    } catch {
      origin = null;
    }
    const previewOriginAllowed =
      origin !== null &&
      !origin.port &&
      [...this.allowedPreviewHostSuffixes].some((suffix) => {
        const ending = `.${suffix}`;
        return (
          origin!.hostname.endsWith(ending) &&
          /^[a-f0-9]{32}$/.test(origin!.hostname.slice(0, -ending.length))
        );
      });
    if (
      !grant ||
      !preview ||
      preview.logicalUrl !== `http://localhost:${remotePort}/` ||
      !origin ||
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.origin !== preview.origin ||
      !previewOriginAllowed ||
      !PREVIEW_CAPABILITY_PATTERN.test(String(preview.capability ?? "")) ||
      preview.headerName !== "x-zeros-preview-capability"
    ) {
      return await this.rejectInvalidPublishedAccess({
        accessToken,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        grant: record?.grant,
        credential: preview?.capability,
        message:
          "The cloud workspace control plane returned invalid preview access",
      });
    }
    return {
      grant: { ...grant, kind: "preview", remotePort },
      preview: {
        logicalUrl: preview.logicalUrl,
        origin: preview.origin as string,
        capability: preview.capability as string,
        headerName: "x-zeros-preview-capability",
      },
    };
  }

  async revoke(
    accessToken: string,
    input: {
      organizationId: string;
      workspaceId: string;
      grantId: string;
      credential: string;
    },
  ): Promise<void> {
    if (
      !SSH_CREDENTIAL_PATTERN.test(input.credential) &&
      !PREVIEW_CAPABILITY_PATTERN.test(input.credential)
    ) {
      throw new CloudWorkspaceAccessClientError(
        0,
        "invalid_request",
        "Cloud workspace access verifier is invalid",
      );
    }
    await this.request(accessToken, {
      method: "DELETE",
      path: `${this.path(input.organizationId, input.workspaceId)}/${uuid(input.grantId, "Access grant")}`,
      expectedStatus: 204,
      credential: input.credential,
    });
  }
}
