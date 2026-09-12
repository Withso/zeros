const RUNTIME_AUDIENCE = "zeros-cloud-engine-runtime-v1" as const;
const REGISTRATION_AUDIENCE =
  "zeros-cloud-workspace-engine-registration-v1" as const;
const HEARTBEAT_AUDIENCE = "zeros-cloud-workspace-engine-heartbeat-v1" as const;
const ENGINE_CLIENT_ADMISSION_AUDIENCE =
  "zeros-cloud-workspace-engine-client-admission-v1" as const;
const ENGINE_CLIENT_ADMISSION_PATH =
  "/internal/v1/cloud-workspaces/engine/client-admission" as const;
export const CLOUD_RUNTIME_ENV = "ZEROS_CLOUD_RUNTIME_B64" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SETUP_TOKEN_PATTERN = /^zws_[A-Za-z0-9_-]{43}$/;
const HEARTBEAT_TOKEN_PATTERN = /^zwh_[A-Za-z0-9_-]{43}$/;
const READINESS_TOKEN_PATTERN = /^zwr_[A-Za-z0-9_-]{43}$/;
const MAX_RUNTIME_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export type CloudRuntimeAuthority = {
  heartbeatEndpoint: string;
  heartbeatToken: string;
  workspaceId: string;
  organizationId: string;
  generation: number;
  engineInstanceId: string;
};

export type CloudCheckpointDirective = {
  id: string;
  reason:
    | "before_stop"
    | "before_archive"
    | "before_delete"
    | "before_fork"
    | "before_rebuild"
    | "manual";
  deadlineAtMs: number;
};

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

export type CloudRuntimeClientAdmission = {
  accountUserId: string;
  authorityEpoch: number;
};

export type CloudDurableRecordSyncContext = {
  initial: boolean;
};

type FetchLike = typeof fetch;

export type CloudRuntimeRegistrationDependencies = {
  fetch?: FetchLike;
  now?: () => number;
  onAuthorityLost: () => void;
  onDurableRecordSync: (
    authority: CloudRuntimeAuthority,
    context: CloudDurableRecordSyncContext,
  ) => Promise<void>;
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
  onCheckpointRequested?: (
    directive: CloudCheckpointDirective,
    authority: CloudRuntimeAuthority,
  ) => Promise<void>;
  /** `undefined` means observation was unavailable; `[]` is an authoritative
   * empty listener scan. Only ports/protocols cross the control-plane boundary. */
  readObservedPorts?: () => Promise<
    readonly { port: number; protocol: "tcp" }[] | undefined
  >;
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
  private readonly onDurableRecordSync: CloudRuntimeRegistrationDependencies["onDurableRecordSync"];
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
  private readonly onCheckpointRequested:
    | NonNullable<CloudRuntimeRegistrationDependencies["onCheckpointRequested"]>
    | undefined;
  private readonly readObservedPorts:
    | NonNullable<CloudRuntimeRegistrationDependencies["readObservedPorts"]>
    | undefined;
  private readonly abortController = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private document: RegistrationDocument | null = null;
  private started = false;
  private stopped = false;
  private authorityLost = false;
  private durableRecordConnected = false;
  private durableRecordSyncInFlight: Promise<void> | null = null;
  private checkpointInFlight: string | null = null;

  constructor(
    readonly config: CloudRuntimeConfig,
    dependencies: CloudRuntimeRegistrationDependencies,
  ) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
    this.onAuthorityLost = dependencies.onAuthorityLost;
    this.onDurableRecordSync = dependencies.onDurableRecordSync;
    this.readRepositoryCredentialRefresh =
      dependencies.readRepositoryCredentialRefresh;
    this.installRepositoryCredential = dependencies.installRepositoryCredential;
    this.acknowledgeRepositoryCredentialRefresh =
      dependencies.acknowledgeRepositoryCredentialRefresh;
    this.onCheckpointRequested = dependencies.onCheckpointRequested;
    this.readObservedPorts = dependencies.readObservedPorts;
  }

  readiness(): CloudRuntimeReadiness | null {
    if (
      !this.document ||
      !this.durableRecordConnected ||
      this.stopped ||
      this.authorityLost
    ) {
      return null;
    }
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
    try {
      await this.synchronizeDurableRecord(document, { initial: true });
    } catch (error) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.document = null;
      this.durableRecordConnected = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.durableRecordConnected = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abortController.abort();
    this.document = null;
    await this.durableRecordSyncInFlight?.catch(() => undefined);
  }

  /** Redeem one desktop connection capability through this engine's current
   * heartbeat authority. A failed admission is deliberately local to the
   * connecting socket; ordinary network failure does not surrender the engine
   * lease or disclose why a bearer was rejected. */
  async verifyClientAdmission(
    grantToken: string,
  ): Promise<CloudRuntimeClientAdmission | null> {
    const document = this.document;
    if (
      !SETUP_TOKEN_PATTERN.test(grantToken) ||
      !document ||
      !this.durableRecordConnected ||
      this.stopped ||
      this.authorityLost
    ) {
      return null;
    }
    const endpoint = new URL(
      ENGINE_CLIENT_ADMISSION_PATH,
      document.heartbeat.endpoint,
    ).toString();
    try {
      const raw = await this.post(endpoint, document.heartbeat.token, {
        workspaceId: this.config.execution.workspaceId,
        organizationId: this.config.execution.organizationId,
        generation: this.config.execution.generation,
        engineInstanceId: this.config.engine.instanceId,
        grantToken,
      });
      if (
        isRecord(raw) &&
        exactKeys(raw, [
          "accountUserId",
          "admitted",
          "audience",
          "authorityEpoch",
          "version",
        ]) &&
        raw.version === 1 &&
        raw.audience === ENGINE_CLIENT_ADMISSION_AUDIENCE &&
        raw.admitted === true &&
        positiveInteger(raw.authorityEpoch) &&
        typeof raw.accountUserId === "string" &&
        UUID_PATTERN.test(raw.accountUserId)
      ) {
        return {
          accountUserId: raw.accountUserId,
          authorityEpoch: Number(raw.authorityEpoch),
        };
      }
      return null;
    } catch {
      return null;
    }
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
    this.timer = setTimeout(() => {
      // A timer callback has no caller to observe a rejected heartbeat. The
      // normal path handles protocol/network failures in runHeartbeat; this
      // final boundary also contains host authority-cleanup failures.
      void this.runHeartbeat().catch(() => {
        try {
          this.loseAuthority();
        } catch {
          // The timer boundary is terminal; never surface a host callback as
          // an unhandled rejection from the engine event loop.
        }
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async runHeartbeat(): Promise<void> {
    this.timer = null;
    const document = this.document;
    if (!document || this.stopped || this.authorityLost) return;
    try {
      const credentialRefresh = this.readCredentialRefresh();
      const observedPorts = await this.observedPorts();
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
          ...(observedPorts === undefined ? {} : { observedPorts }),
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
        ...(isRecord(raw) && raw.checkpointRequest !== undefined
          ? ["checkpointRequest"]
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
      const checkpointRequest = this.parseCheckpointRequest(
        raw.checkpointRequest,
        now,
      );
      document.leaseExpiresAtMs = Number(raw.leaseExpiresAtMs);
      this.scheduleHeartbeat(document.heartbeat.intervalMs);
      void this.synchronizeDurableRecord(document, { initial: false }).catch(
        () => undefined,
      );
      if (checkpointRequest) {
        this.dispatchCheckpointRequest(checkpointRequest, document);
      }
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

  private async observedPorts(): Promise<
    readonly { port: number; protocol: "tcp" }[] | undefined
  > {
    if (!this.readObservedPorts) return undefined;
    let raw: readonly { port: number; protocol: "tcp" }[] | undefined;
    try {
      raw = await this.readObservedPorts();
    } catch {
      return undefined;
    }
    if (raw === undefined || raw.length > 128) return undefined;
    const ports = new Set<number>();
    for (const item of raw) {
      if (
        !item ||
        item.protocol !== "tcp" ||
        !Number.isSafeInteger(item.port) ||
        item.port < 1_024 ||
        item.port > 65_535 ||
        ports.has(item.port)
      ) {
        return undefined;
      }
      ports.add(item.port);
    }
    return [...ports]
      .sort((left, right) => left - right)
      .map((port) => ({ port, protocol: "tcp" as const }));
  }

  private parseCheckpointRequest(
    raw: unknown,
    now: number,
  ): CloudCheckpointDirective | null {
    if (raw === undefined || raw === null) return null;
    if (
      !isRecord(raw) ||
      !exactKeys(raw, ["deadlineAtMs", "id", "reason"]) ||
      !UUID_PATTERN.test(String(raw.id ?? "")) ||
      ![
        "before_stop",
        "before_archive",
        "before_delete",
        "before_fork",
        "before_rebuild",
        "manual",
      ].includes(String(raw.reason)) ||
      !Number.isSafeInteger(raw.deadlineAtMs) ||
      Number(raw.deadlineAtMs) < now - 30_000 ||
      Number(raw.deadlineAtMs) > now + 30 * 60_000
    ) {
      throw new CloudRuntimeRequestError(
        "cloud checkpoint directive is invalid",
        true,
      );
    }
    return {
      id: String(raw.id),
      reason: raw.reason as CloudCheckpointDirective["reason"],
      deadlineAtMs: Number(raw.deadlineAtMs),
    };
  }

  private dispatchCheckpointRequest(
    directive: CloudCheckpointDirective,
    document: RegistrationDocument,
  ): void {
    if (!this.onCheckpointRequested || this.checkpointInFlight !== null) return;
    this.checkpointInFlight = directive.id;
    void this.onCheckpointRequested(directive, this.authority(document))
      .catch(() => undefined)
      .finally(() => {
        if (this.checkpointInFlight === directive.id) {
          this.checkpointInFlight = null;
        }
      });
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
    this.durableRecordConnected = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.document = null;
    this.onAuthorityLost();
  }

  private authority(document: RegistrationDocument): CloudRuntimeAuthority {
    return {
      heartbeatEndpoint: document.heartbeat.endpoint,
      heartbeatToken: document.heartbeat.token,
      workspaceId: this.config.execution.workspaceId,
      organizationId: this.config.execution.organizationId,
      generation: this.config.execution.generation,
      engineInstanceId: this.config.engine.instanceId,
    };
  }

  private synchronizeDurableRecord(
    document: RegistrationDocument,
    context: CloudDurableRecordSyncContext,
  ): Promise<void> {
    if (this.durableRecordSyncInFlight) return this.durableRecordSyncInFlight;
    const task = Promise.resolve()
      .then(() => this.onDurableRecordSync(this.authority(document), context))
      .then(() => {
        if (
          this.document === document &&
          !this.stopped &&
          !this.authorityLost
        ) {
          this.durableRecordConnected = true;
        }
      })
      .catch((error) => {
        this.durableRecordConnected = false;
        throw error;
      })
      .finally(() => {
        if (this.durableRecordSyncInFlight === task) {
          this.durableRecordSyncInFlight = null;
        }
      });
    this.durableRecordSyncInFlight = task;
    return task;
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
