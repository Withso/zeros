const RUNTIME_AUDIENCE = "zeros-cloud-engine-runtime-v1" as const;
const REGISTRATION_AUDIENCE =
  "zeros-cloud-workspace-engine-registration-v1" as const;
const HEARTBEAT_AUDIENCE = "zeros-cloud-workspace-engine-heartbeat-v1" as const;
export const CLOUD_RUNTIME_ENV = "ZEROS_CLOUD_RUNTIME_B64" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SETUP_TOKEN_PATTERN = /^zws_[A-Za-z0-9_-]{43}$/;
const HEARTBEAT_TOKEN_PATTERN = /^zwh_[A-Za-z0-9_-]{43}$/;
const READINESS_TOKEN_PATTERN = /^zwr_[A-Za-z0-9_-]{43}$/;
const MAX_RUNTIME_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export type CloudRuntimeConfig = {
  version: 1;
  audience: typeof RUNTIME_AUDIENCE;
  execution: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    setupRunId: string;
    executionFence: number;
  };
  engine: {
    instanceId: string;
    protocolVersion: number;
    readinessProbeToken: string;
  };
  registration: {
    endpoint: string;
    token: string;
    expiresAtMs: number;
  };
};

export type CloudRuntimeReadiness = {
  version: 1;
  instanceId: string;
  protocolVersion: number;
  health: "ready";
  durableRecordConnected: true;
};

type FetchLike = typeof fetch;

export type CloudRuntimeRegistrationDependencies = {
  fetch?: FetchLike;
  now?: () => number;
  onAuthorityLost: () => void;
  readRepositoryCredentialRefresh?: () => {
    version: 1;
    audience: "zeros-cloud-github-refresh-v1";
    generation: string;
    requestedAt: number;
    ownerSubjectSha256: string;
    method: "github-app" | "gh-cli" | "pat";
    reason: "credential-invalid";
  } | null;
  installRepositoryCredential?: (document: unknown) => void;
  acknowledgeRepositoryCredentialRefresh?: (generation: string) => boolean;
};

type RegistrationDocument = {
  leaseExpiresAtMs: number;
  heartbeat: {
    endpoint: string;
    token: string;
    intervalMs: number;
  };
};

class CloudRuntimeRequestError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean,
  ) {
    super(message);
    this.name = "CloudRuntimeRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= maximum
  );
}

function exactHttpsEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 4_096) {
    return null;
  }
  try {
    const value = new URL(raw);
    if (
      value.protocol !== "https:" ||
      value.username ||
      value.password ||
      value.search ||
      value.hash
    ) {
      return null;
    }
    return value.toString();
  } catch {
    return null;
  }
}

function parseRuntime(raw: unknown, now: number): CloudRuntimeConfig {
  if (
    !isRecord(raw) ||
    !exactKeys(raw, [
      "audience",
      "engine",
      "execution",
      "registration",
      "version",
    ]) ||
    raw.version !== 1 ||
    raw.audience !== RUNTIME_AUDIENCE ||
    !isRecord(raw.execution) ||
    !exactKeys(raw.execution, [
      "executionFence",
      "generation",
      "organizationId",
      "setupRunId",
      "workspaceId",
    ]) ||
    !UUID_PATTERN.test(String(raw.execution.workspaceId ?? "")) ||
    !UUID_PATTERN.test(String(raw.execution.organizationId ?? "")) ||
    !UUID_PATTERN.test(String(raw.execution.setupRunId ?? "")) ||
    !positiveInteger(raw.execution.generation) ||
    !positiveInteger(raw.execution.executionFence) ||
    !isRecord(raw.engine) ||
    !exactKeys(raw.engine, [
      "instanceId",
      "protocolVersion",
      "readinessProbeToken",
    ]) ||
    !UUID_PATTERN.test(String(raw.engine.instanceId ?? "")) ||
    !positiveInteger(raw.engine.protocolVersion, 65_535) ||
    !READINESS_TOKEN_PATTERN.test(
      String(raw.engine.readinessProbeToken ?? ""),
    ) ||
    !isRecord(raw.registration) ||
    !exactKeys(raw.registration, ["endpoint", "expiresAtMs", "token"]) ||
    exactHttpsEndpoint(raw.registration.endpoint) === null ||
    !SETUP_TOKEN_PATTERN.test(String(raw.registration.token ?? "")) ||
    !Number.isSafeInteger(raw.registration.expiresAtMs) ||
    Number(raw.registration.expiresAtMs) - now < 5_000 ||
    Number(raw.registration.expiresAtMs) - now > 2 * 60 * 60_000
  ) {
    throw new Error("cloud engine runtime material is invalid");
  }
  return {
    version: 1,
    audience: RUNTIME_AUDIENCE,
    execution: {
      workspaceId: String(raw.execution.workspaceId),
      organizationId: String(raw.execution.organizationId),
      generation: Number(raw.execution.generation),
      setupRunId: String(raw.execution.setupRunId),
      executionFence: Number(raw.execution.executionFence),
    },
    engine: {
      instanceId: String(raw.engine.instanceId),
      protocolVersion: Number(raw.engine.protocolVersion),
      readinessProbeToken: String(raw.engine.readinessProbeToken),
    },
    registration: {
      endpoint: exactHttpsEndpoint(raw.registration.endpoint)!,
      token: String(raw.registration.token),
      expiresAtMs: Number(raw.registration.expiresAtMs),
    },
  };
}

/** Read once and erase immediately so later agent environment construction
 * cannot inherit setup authority even if engine startup eventually fails. */
export function consumeCloudRuntimeEnvironment(
  env: Record<string, string | undefined> = process.env,
  now: () => number = Date.now,
): CloudRuntimeConfig | null {
  const encoded = env[CLOUD_RUNTIME_ENV];
  delete env[CLOUD_RUNTIME_ENV];
  if (encoded === undefined) return null;
  if (
    encoded.length < 2 ||
    Buffer.byteLength(encoded, "utf8") > MAX_RUNTIME_BYTES * 2 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw new Error("cloud engine runtime material is invalid");
  }
  const decoded = Buffer.from(encoded, "base64url");
  try {
    if (
      decoded.length > MAX_RUNTIME_BYTES ||
      decoded.toString("base64url") !== encoded
    ) {
      throw new Error("cloud engine runtime material is invalid");
    }
    return parseRuntime(JSON.parse(decoded.toString("utf8")), now());
  } catch {
    throw new Error("cloud engine runtime material is invalid");
  } finally {
    decoded.fill(0);
  }
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declared) &&
    (declared < 0 || declared > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudRuntimeRequestError(
      "cloud runtime response is invalid",
      false,
    );
  }
  if (!response.body) {
    throw new CloudRuntimeRequestError(
      "cloud runtime response is invalid",
      false,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CloudRuntimeRequestError(
          "cloud runtime response is invalid",
          false,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } catch {
    throw new CloudRuntimeRequestError(
      "cloud runtime response is invalid",
      false,
    );
  }
}

export class CloudRuntimeRegistration {
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly onAuthorityLost: () => void;
  private readonly readRepositoryCredentialRefresh:
    | NonNullable<
        CloudRuntimeRegistrationDependencies["readRepositoryCredentialRefresh"]
      >
    | undefined;
  private readonly installRepositoryCredential:
    | NonNullable<
        CloudRuntimeRegistrationDependencies["installRepositoryCredential"]
      >
    | undefined;
  private readonly acknowledgeRepositoryCredentialRefresh:
    | NonNullable<
        CloudRuntimeRegistrationDependencies["acknowledgeRepositoryCredentialRefresh"]
      >
    | undefined;
  private readonly abortController = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private document: RegistrationDocument | null = null;
  private started = false;
  private stopped = false;
  private authorityLost = false;

  constructor(
    readonly config: CloudRuntimeConfig,
    dependencies: CloudRuntimeRegistrationDependencies,
  ) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
    this.onAuthorityLost = dependencies.onAuthorityLost;
    this.readRepositoryCredentialRefresh =
      dependencies.readRepositoryCredentialRefresh;
    this.installRepositoryCredential = dependencies.installRepositoryCredential;
    this.acknowledgeRepositoryCredentialRefresh =
      dependencies.acknowledgeRepositoryCredentialRefresh;
  }

  readiness(): CloudRuntimeReadiness | null {
    if (!this.document || this.stopped || this.authorityLost) return null;
    return {
      version: 1,
      instanceId: this.config.engine.instanceId,
      protocolVersion: this.config.engine.protocolVersion,
      health: "ready",
      durableRecordConnected: true,
    };
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) {
      throw new Error("cloud engine registration lifecycle is invalid");
    }
    this.started = true;
    if (this.config.registration.expiresAtMs - this.now() < 5_000) {
      throw new Error("cloud engine registration capability expired");
    }
    const raw = await this.post(
      this.config.registration.endpoint,
      this.config.registration.token,
      {
        workspaceId: this.config.execution.workspaceId,
        organizationId: this.config.execution.organizationId,
        generation: this.config.execution.generation,
        setupRunId: this.config.execution.setupRunId,
        executionFence: this.config.execution.executionFence,
        engineInstanceId: this.config.engine.instanceId,
        protocolVersion: this.config.engine.protocolVersion,
      },
    );
    const document = this.parseRegistration(raw);
    this.document = document;
    this.scheduleHeartbeat(document.heartbeat.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abortController.abort();
    this.document = null;
  }

  private parseRegistration(raw: unknown): RegistrationDocument {
    const now = this.now();
    if (
      !isRecord(raw) ||
      !exactKeys(raw, [
        "audience",
        "durableRecordConnected",
        "engineInstanceId",
        "heartbeat",
        "leaseExpiresAtMs",
        "version",
      ]) ||
      raw.version !== 1 ||
      raw.audience !== REGISTRATION_AUDIENCE ||
      raw.engineInstanceId !== this.config.engine.instanceId ||
      raw.durableRecordConnected !== true ||
      !Number.isSafeInteger(raw.leaseExpiresAtMs) ||
      Number(raw.leaseExpiresAtMs) - now < 5_000 ||
      Number(raw.leaseExpiresAtMs) - now > 10 * 60_000 ||
      !isRecord(raw.heartbeat) ||
      !exactKeys(raw.heartbeat, ["endpoint", "intervalMs", "token"]) ||
      exactHttpsEndpoint(raw.heartbeat.endpoint) === null ||
      new URL(String(raw.heartbeat.endpoint)).origin !==
        new URL(this.config.registration.endpoint).origin ||
      !HEARTBEAT_TOKEN_PATTERN.test(String(raw.heartbeat.token ?? "")) ||
      !positiveInteger(raw.heartbeat.intervalMs, 60_000) ||
      Number(raw.heartbeat.intervalMs) < 5_000
    ) {
      throw new Error("cloud engine registration response is invalid");
    }
    return {
      leaseExpiresAtMs: Number(raw.leaseExpiresAtMs),
      heartbeat: {
        endpoint: exactHttpsEndpoint(raw.heartbeat.endpoint)!,
        token: String(raw.heartbeat.token),
        intervalMs: Number(raw.heartbeat.intervalMs),
      },
    };
  }

  private scheduleHeartbeat(delayMs: number): void {
    if (this.stopped || this.authorityLost) return;
    this.timer = setTimeout(() => void this.runHeartbeat(), delayMs);
    this.timer.unref?.();
  }

  private async runHeartbeat(): Promise<void> {
    this.timer = null;
    const document = this.document;
    if (!document || this.stopped || this.authorityLost) return;
    try {
      const credentialRefresh = this.readCredentialRefresh();
      const raw = await this.post(
        document.heartbeat.endpoint,
        document.heartbeat.token,
        {
          workspaceId: this.config.execution.workspaceId,
          organizationId: this.config.execution.organizationId,
          generation: this.config.execution.generation,
          engineInstanceId: this.config.engine.instanceId,
          ...(credentialRefresh
            ? { repositoryCredentialRefresh: credentialRefresh }
            : {}),
        },
      );
      const now = this.now();
      const responseKeys = [
        "accepted",
        "audience",
        "engineInstanceId",
        "leaseExpiresAtMs",
        ...(isRecord(raw) && raw.repositoryCredential !== undefined
          ? ["repositoryCredential"]
          : []),
        "version",
      ];
      if (
        !isRecord(raw) ||
        !exactKeys(raw, responseKeys) ||
        raw.version !== 1 ||
        raw.audience !== HEARTBEAT_AUDIENCE ||
        raw.accepted !== true ||
        raw.engineInstanceId !== this.config.engine.instanceId ||
        !Number.isSafeInteger(raw.leaseExpiresAtMs) ||
        Number(raw.leaseExpiresAtMs) - now < 5_000 ||
        Number(raw.leaseExpiresAtMs) - now > 10 * 60_000
      ) {
        throw new CloudRuntimeRequestError(
          "cloud engine heartbeat response is invalid",
          true,
        );
      }
      this.applyCredentialRefreshResponse(
        credentialRefresh,
        raw.repositoryCredential,
      );
      document.leaseExpiresAtMs = Number(raw.leaseExpiresAtMs);
      this.scheduleHeartbeat(document.heartbeat.intervalMs);
    } catch (error) {
      const terminal =
        error instanceof CloudRuntimeRequestError && error.terminal;
      if (terminal || this.now() >= document.leaseExpiresAtMs - 1_000) {
        this.loseAuthority();
        return;
      }
      this.scheduleHeartbeat(
        Math.min(
          5_000,
          Math.max(250, document.leaseExpiresAtMs - this.now() - 1_000),
        ),
      );
    }
  }

  private readCredentialRefresh(): {
    generation: string;
    requestedAtMs: number;
    ownerSubjectSha256: string;
    method: "github-app";
    reason: "credential-invalid";
  } | null {
    if (!this.readRepositoryCredentialRefresh) return null;
    let value;
    try {
      value = this.readRepositoryCredentialRefresh();
    } catch {
      return null;
    }
    if (
      !value ||
      value.version !== 1 ||
      value.audience !== "zeros-cloud-github-refresh-v1" ||
      !/^[A-Za-z0-9_-]{20,64}$/.test(value.generation) ||
      !Number.isSafeInteger(value.requestedAt) ||
      value.requestedAt < 1 ||
      !/^[a-f0-9]{64}$/.test(value.ownerSubjectSha256) ||
      value.method !== "github-app" ||
      value.reason !== "credential-invalid"
    ) {
      return null;
    }
    return {
      generation: value.generation,
      requestedAtMs: value.requestedAt,
      ownerSubjectSha256: value.ownerSubjectSha256,
      method: "github-app",
      reason: "credential-invalid",
    };
  }

  private applyCredentialRefreshResponse(
    request: { generation: string } | null,
    raw: unknown,
  ): void {
    if (!request) {
      if (raw !== undefined) {
        throw new CloudRuntimeRequestError(
          "cloud engine credential response is invalid",
          true,
        );
      }
      return;
    }
    if (
      !isRecord(raw) ||
      raw.requestGeneration !== request.generation ||
      !["rotated", "unavailable"].includes(String(raw.outcome))
    ) {
      throw new CloudRuntimeRequestError(
        "cloud engine credential response is invalid",
        true,
      );
    }
    if (raw.outcome === "unavailable") {
      if (!exactKeys(raw, ["outcome", "requestGeneration"])) {
        throw new CloudRuntimeRequestError(
          "cloud engine credential response is invalid",
          true,
        );
      }
      return;
    }
    if (
      !exactKeys(raw, ["document", "outcome", "requestGeneration"]) ||
      !this.installRepositoryCredential ||
      !this.acknowledgeRepositoryCredentialRefresh
    ) {
      throw new CloudRuntimeRequestError(
        "cloud engine credential response is invalid",
        true,
      );
    }
    try {
      this.installRepositoryCredential(raw.document);
      this.acknowledgeRepositoryCredentialRefresh(request.generation);
    } catch {
      throw new CloudRuntimeRequestError(
        "cloud engine credential response is invalid",
        true,
      );
    }
  }

  private loseAuthority(): void {
    if (this.authorityLost || this.stopped) return;
    this.authorityLost = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.document = null;
    this.onAuthorityLost();
  }

  private async post(
    endpoint: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(endpoint, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([
          this.abortController.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "zeros-cloud-engine",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new CloudRuntimeRequestError(
        "cloud engine registration request failed",
        false,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CloudRuntimeRequestError(
        "cloud engine registration request rejected",
        response.status >= 400 && response.status < 500,
      );
    }
    if (
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/json"
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new CloudRuntimeRequestError(
        "cloud engine registration response is invalid",
        true,
      );
    }
    return boundedResponseJson(response);
  }
}
