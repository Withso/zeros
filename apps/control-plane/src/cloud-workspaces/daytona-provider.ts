import {
  Configuration,
  SandboxApi,
  type CreateSandbox,
  type PortPreviewUrl,
  type Sandbox,
  type SandboxListItem,
  type SshAccessDto,
} from "@daytona/api-client";

import {
  assertProviderResourceIdentity,
  assertSingleProviderResource,
  CloudProviderError,
  type CloudProviderCreateInput,
  type CloudProviderIdentity,
  type CloudProviderObservedState,
  type CloudProviderResource,
  type CloudProviderPreviewEndpoint,
  type CloudProviderSshAccess,
  type CloudWorkspaceAccessProvider,
  type CloudWorkspaceProvider,
} from "./provider.js";

const MANAGED_LABEL = "zeros_managed";
const WORKSPACE_LABEL = "zeros_workspace";
const GENERATION_LABEL = "zeros_generation";
const API_CLIENT_VERSION = "0.190.1";
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,4096}$/;
const PROVIDER_ACCESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEFAULT_SSH_HOSTS = ["ssh.app.daytona.io"] as const;
const DEFAULT_PREVIEW_HOST_SUFFIXES = ["proxy.daytona.work"] as const;

export type DaytonaSandboxLike = Pick<
  Sandbox | SandboxListItem,
  | "id"
  | "state"
  | "target"
  | "labels"
  | "snapshot"
  | "cpu"
  | "memory"
  | "disk"
  | "public"
  | "errorReason"
  | "autoStopInterval"
  | "autoArchiveInterval"
  | "autoDeleteInterval"
>;

type DaytonaCreateParams = {
  name: string;
  snapshot: string;
  target: string;
  labels: Record<string, string>;
  public: false;
  cpu: number;
  memory: number;
  disk: number;
  autoStopInterval: number;
  autoArchiveInterval: number;
  autoDeleteInterval: number;
};

export interface DaytonaClientLike {
  create(
    params: DaytonaCreateParams,
    options: { timeoutSeconds: number },
  ): Promise<DaytonaSandboxLike>;
  get(
    resourceId: string,
    options?: { timeoutSeconds: number },
  ): Promise<DaytonaSandboxLike>;
  list(query: {
    labels: Record<string, string>;
    limit: number;
  }): AsyncIterableIterator<DaytonaSandboxLike>;
  start(
    resourceId: string,
    timeoutSeconds: number,
  ): Promise<DaytonaSandboxLike>;
  stop(resourceId: string, timeoutSeconds: number): Promise<DaytonaSandboxLike>;
  archive(
    resourceId: string,
    timeoutSeconds: number,
  ): Promise<DaytonaSandboxLike>;
  delete(resourceId: string, timeoutSeconds: number): Promise<void>;
  createSshAccess(
    resourceId: string,
    expiresInMinutes: number,
  ): Promise<SshAccessDto>;
  revokeSshAccess(
    resourceId: string,
    token?: string,
  ): Promise<DaytonaSandboxLike>;
  getPreviewUrl(resourceId: string, port: number): Promise<PortPreviewUrl>;
}

export type DaytonaWorkspaceProviderConfig = {
  apiKey: string;
  apiUrl: string;
  target: string;
  snapshotId: string;
  architecture: "linux/amd64" | "linux/arm64";
  cpuMillicores: number;
  memoryMiB: number;
  storageMiB: number;
  operationTimeoutSeconds: number;
  /** Production uses 0 because the engine owns idleness. */
  autoStopMinutes: number;
  autoArchiveMinutes: number;
  /** -1 disables it in production; qualification uses a bounded orphan backstop. */
  autoDeleteMinutes: number;
  /** Exact provider SSH gateways accepted from the API response. */
  allowedSshHosts?: readonly string[];
  /** Exact DNS suffixes accepted for standard private preview URLs. */
  allowedPreviewHostSuffixes?: readonly string[];
};

/** Test seam for transport failures without depending on Axios internals. */
export class DaytonaTransportError extends Error {
  readonly statusCode: number | undefined;
  readonly transportCode: string | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      transportCode?: string;
      headers?: Readonly<Record<string, string>>;
    } = {},
  ) {
    super(message);
    this.name = "DaytonaTransportError";
    this.statusCode = options.statusCode;
    this.transportCode = options.transportCode;
    this.headers = options.headers;
  }
}

type ErrorShape = {
  code?: unknown;
  headers?: unknown;
  status?: unknown;
  statusCode?: unknown;
  response?: { headers?: unknown; status?: unknown };
};

function errorShape(error: unknown): ErrorShape | null {
  return typeof error === "object" && error !== null
    ? (error as ErrorShape)
    : null;
}

function transportStatus(error: unknown): number | undefined {
  if (error instanceof DaytonaTransportError) return error.statusCode;
  const shape = errorShape(error);
  const value = shape?.response?.status ?? shape?.statusCode ?? shape?.status;
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function transportCode(error: unknown): string | undefined {
  if (error instanceof DaytonaTransportError) return error.transportCode;
  const code = errorShape(error)?.code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

const RETRY_AFTER_HEADERS = [
  "retry-after-sandbox-create",
  "retry-after-sandbox-lifecycle",
  "retry-after-authenticated",
  "retry-after-anonymous",
  "retry-after",
] as const;

function retryAfterMilliseconds(error: unknown): number | undefined {
  const shape = errorShape(error);
  const headers = shape?.headers ?? shape?.response?.headers;
  if (typeof headers !== "object" || headers === null) return undefined;

  const values: unknown[] = [];
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    for (const name of RETRY_AFTER_HEADERS) {
      values.push((get as (name: string) => unknown).call(headers, name));
    }
  }
  for (const [name, value] of Object.entries(headers)) {
    if (/^retry-after(?:-|$)/i.test(name)) values.push(value);
  }

  const seconds = values
    .map((value) =>
      typeof value === "number" || typeof value === "string"
        ? Number(value)
        : Number.NaN,
    )
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (seconds.length === 0) return undefined;
  return Math.ceil(Math.max(...seconds) * 1_000);
}

function isNetworkFailure(error: unknown): boolean {
  return [
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
  ].includes(transportCode(error) ?? "");
}

function isRetryableTransportFailure(error: unknown): boolean {
  const status = transportStatus(error);
  return (
    isNetworkFailure(error) ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  );
}

function requestTimeout(timeoutSeconds: number): { timeout: number } {
  return { timeout: timeoutSeconds * 1_000 };
}

class GeneratedDaytonaClient implements DaytonaClientLike {
  private readonly api: SandboxApi;

  constructor(private readonly config: DaytonaWorkspaceProviderConfig) {
    const configuration = new Configuration({
      basePath: config.apiUrl,
      accessToken: config.apiKey,
      baseOptions: {
        headers: {
          "X-Daytona-Source": "zeros-control-plane",
          "X-Daytona-SDK-Version": API_CLIENT_VERSION,
          "User-Agent": `zeros-control-plane/daytona-api-client-${API_CLIENT_VERSION}`,
        },
      },
    });
    this.api = new SandboxApi(configuration);
  }

  async create(
    params: DaytonaCreateParams,
    options: { timeoutSeconds: number },
  ): Promise<DaytonaSandboxLike> {
    const body: CreateSandbox = {
      name: params.name,
      snapshot: params.snapshot,
      target: params.target,
      labels: params.labels,
      public: params.public,
      cpu: params.cpu,
      memory: params.memory,
      disk: params.disk,
      autoStopInterval: params.autoStopInterval,
      autoArchiveInterval: params.autoArchiveInterval,
      autoDeleteInterval: params.autoDeleteInterval,
    };
    return (
      await this.api.createSandbox(
        body,
        undefined,
        requestTimeout(options.timeoutSeconds),
      )
    ).data;
  }

  async get(
    resourceId: string,
    options = { timeoutSeconds: this.config.operationTimeoutSeconds },
  ): Promise<DaytonaSandboxLike> {
    return (
      await this.api.getSandbox(
        resourceId,
        undefined,
        false,
        requestTimeout(options.timeoutSeconds),
      )
    ).data;
  }

  async *list(query: {
    labels: Record<string, string>;
    limit: number;
  }): AsyncIterableIterator<DaytonaSandboxLike> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const args: Parameters<SandboxApi["listSandboxes"]> = [];
      if (cursor) args[1] = cursor;
      args[2] = Math.min(100, Math.max(1, query.limit));
      args[5] = JSON.stringify(query.labels);
      args[25] = requestTimeout(this.config.operationTimeoutSeconds);
      const response = await this.api.listSandboxes(...args);
      for (const item of response.data.items) yield item;
      const next = response.data.nextCursor ?? undefined;
      if (!next) return;
      if (seenCursors.has(next)) {
        throw new DaytonaTransportError("Daytona repeated a pagination cursor");
      }
      seenCursors.add(next);
      cursor = next;
    } while (true);
  }

  async start(
    resourceId: string,
    timeoutSeconds: number,
  ): Promise<DaytonaSandboxLike> {
    return (
      await this.api.startSandbox(
        resourceId,
        undefined,
        requestTimeout(timeoutSeconds),
      )
    ).data;
  }

  async stop(
    resourceId: string,
    timeoutSeconds: number,
  ): Promise<DaytonaSandboxLike> {
    return (
      await this.api.stopSandbox(
        resourceId,
        undefined,
        false,
        requestTimeout(timeoutSeconds),
      )
    ).data;
  }

  async archive(
    resourceId: string,
    timeoutSeconds: number,
  ): Promise<DaytonaSandboxLike> {
    return (
      await this.api.archiveSandbox(
        resourceId,
        undefined,
        requestTimeout(timeoutSeconds),
      )
    ).data;
  }

  async delete(resourceId: string, timeoutSeconds: number): Promise<void> {
    await this.api.deleteSandbox(
      resourceId,
      undefined,
      requestTimeout(timeoutSeconds),
    );
  }

  async createSshAccess(
    resourceId: string,
    expiresInMinutes: number,
  ): Promise<SshAccessDto> {
    return (
      await this.api.createSshAccess(
        resourceId,
        undefined,
        expiresInMinutes,
        requestTimeout(this.config.operationTimeoutSeconds),
      )
    ).data;
  }

  async revokeSshAccess(
    resourceId: string,
    token?: string,
  ): Promise<DaytonaSandboxLike> {
    return (
      await this.api.revokeSshAccess(
        resourceId,
        undefined,
        token,
        requestTimeout(this.config.operationTimeoutSeconds),
      )
    ).data;
  }

  async getPreviewUrl(
    resourceId: string,
    port: number,
  ): Promise<PortPreviewUrl> {
    return (
      await this.api.getPortPreviewUrl(
        resourceId,
        port,
        undefined,
        requestTimeout(this.config.operationTimeoutSeconds),
      )
    ).data;
  }
}

function providerName(identity: CloudProviderIdentity): string {
  // UUID + generation is deterministic and below Daytona's documented name
  // ceiling. It is also safe to query after a create response times out.
  return `zeros-${identity.workspaceId}-g${identity.generation}`;
}

function identityLabels(
  identity: CloudProviderIdentity,
): Record<string, string> {
  return {
    [MANAGED_LABEL]: "true",
    [WORKSPACE_LABEL]: identity.workspaceId,
    [GENERATION_LABEL]: String(identity.generation),
  };
}

export function mapDaytonaState(
  raw: string | undefined,
): CloudProviderObservedState {
  switch (raw) {
    case "creating":
    case "restoring":
    case "starting":
    case "pending_build":
    case "building_snapshot":
    case "pulling_snapshot":
    case "resizing":
    case "snapshotting":
    case "forking":
    case "resuming":
      return "provisioning";
    case "started":
      return "running";
    case "pausing":
      return "stopping";
    case "paused":
      return "stopped";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "archiving":
      return "archiving";
    case "archived":
      return "archived";
    case "destroying":
      return "deleting";
    case "destroyed":
      return "deleted";
    case "error":
    case "build_failed":
      return "failed";
    default:
      return "unknown";
  }
}

function parseIdentity(
  labels: Readonly<Record<string, string>>,
): CloudProviderIdentity {
  const workspaceId = labels[WORKSPACE_LABEL];
  const generation = Number(labels[GENERATION_LABEL]);
  if (
    !workspaceId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      workspaceId,
    ) ||
    !Number.isSafeInteger(generation) ||
    generation <= 0
  ) {
    throw new CloudProviderError(
      "provider_identity_invalid",
      "Managed Daytona resource has invalid Zeros identity labels",
      false,
    );
  }
  return { workspaceId, generation };
}

function resource(sandbox: DaytonaSandboxLike): CloudProviderResource {
  assertResourceId(sandbox.id);
  const identity = parseIdentity(sandbox.labels);
  return {
    resourceId: sandbox.id,
    state: mapDaytonaState(String(sandbox.state ?? "unknown")),
    target: sandbox.target || null,
    ...identity,
    metadata: {
      snapshot: sandbox.snapshot ?? null,
      cpu: sandbox.cpu,
      memoryGiB: sandbox.memory,
      diskGiB: sandbox.disk,
      publicPreview: sandbox.public,
      autoStopMinutes: sandbox.autoStopInterval ?? null,
      autoArchiveMinutes: sandbox.autoArchiveInterval ?? null,
      autoDeleteMinutes: sandbox.autoDeleteInterval ?? null,
      hasProviderError: Boolean(sandbox.errorReason),
    },
  };
}

function resourceForId(
  sandbox: DaytonaSandboxLike,
  expectedResourceId: string,
): CloudProviderResource {
  const observed = resource(sandbox);
  if (observed.resourceId !== expectedResourceId) {
    throw new CloudProviderError(
      "provider_resource_mismatch",
      "Daytona resolved a different sandbox than the requested resource",
      false,
    );
  }
  return observed;
}

function sameNumber(actual: unknown, expected: number): boolean {
  return typeof actual === "number" && Math.abs(actual - expected) < 1e-9;
}

function invalidAccessResponse(message: string): CloudProviderError {
  return new CloudProviderError(
    "provider_access_response_invalid",
    message,
    false,
  );
}

function exactAllowedHost(value: string, allowed: readonly string[]): boolean {
  const normalized = value.toLowerCase();
  return allowed.some((candidate) => normalized === candidate.toLowerCase());
}

function normalizedExpiry(value: unknown): Date | null {
  const parsed =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

function assertAccessToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !ACCESS_TOKEN_PATTERN.test(value)) {
    throw invalidAccessResponse(`Daytona returned an invalid ${label}`);
  }
  return value;
}

function assertResourceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PROVIDER_ACCESS_ID_PATTERN.test(value)) {
    throw new CloudProviderError(
      "provider_resource_id_invalid",
      "Provider resource identifier is invalid",
      false,
    );
  }
}

function assertConfiguredResource(
  value: CloudProviderResource,
  input: CloudProviderCreateInput,
  config: DaytonaWorkspaceProviderConfig,
): void {
  const metadata = value.metadata;
  if (
    value.target !== config.target ||
    metadata.snapshot !== input.imageRef ||
    !sameNumber(metadata.cpu, input.cpuMillicores / 1_000) ||
    !sameNumber(metadata.memoryGiB, input.memoryMiB / 1_024) ||
    !sameNumber(metadata.diskGiB, input.storageMiB / 1_024) ||
    metadata.publicPreview !== false ||
    metadata.autoStopMinutes !== config.autoStopMinutes ||
    metadata.autoArchiveMinutes !== config.autoArchiveMinutes ||
    metadata.autoDeleteMinutes !== config.autoDeleteMinutes
  ) {
    throw new CloudProviderError(
      "provider_resource_configuration_mismatch",
      "Daytona resource does not match the pinned Zeros generation",
      false,
    );
  }
}

export function normalizeDaytonaError(
  error: unknown,
  operation: string,
): CloudProviderError {
  if (error instanceof CloudProviderError) return error;
  const message = `Daytona ${operation} did not complete`;
  const status = transportStatus(error);
  if (status === 401 || status === 403) {
    return new CloudProviderError(
      "provider_authorization_failed",
      message,
      false,
      {
        cause: error,
      },
    );
  }
  if (status === 400 || status === 422) {
    return new CloudProviderError("provider_request_invalid", message, false, {
      cause: error,
    });
  }
  if (isRetryableTransportFailure(error) || status === undefined) {
    return new CloudProviderError(
      "provider_temporarily_unavailable",
      message,
      true,
      {
        cause: error,
        retryAfterMs: retryAfterMilliseconds(error),
      },
    );
  }
  return new CloudProviderError("provider_request_failed", message, false, {
    cause: error,
  });
}

export class DaytonaWorkspaceProvider
  implements CloudWorkspaceProvider, CloudWorkspaceAccessProvider
{
  readonly name = "daytona";
  private readonly client: DaytonaClientLike;

  constructor(
    private readonly config: DaytonaWorkspaceProviderConfig,
    client?: DaytonaClientLike,
  ) {
    this.client = client ?? new GeneratedDaytonaClient(config);
  }

  async find(
    identity: CloudProviderIdentity,
  ): Promise<CloudProviderResource[]> {
    try {
      const resources: CloudProviderResource[] = [];
      for await (const sandbox of this.client.list({
        labels: identityLabels(identity),
        limit: 100,
      })) {
        const observed = resource(sandbox);
        assertProviderResourceIdentity(observed, identity);
        resources.push(observed);
        if (resources.length > 1) break;
      }
      return resources;
    } catch (error) {
      throw normalizeDaytonaError(error, "find");
    }
  }

  private async hydrateExisting(
    candidate: CloudProviderResource,
    input: CloudProviderCreateInput,
  ): Promise<CloudProviderResource | null> {
    // Daytona list items may omit optional lifecycle/resource fields. Always
    // hydrate a discovered identity through the detail endpoint before we
    // decide whether it matches the immutable generation contract.
    const hydrated = await this.inspect(candidate.resourceId);
    if (!hydrated) return null;
    const exact = assertSingleProviderResource([hydrated], input);
    if (!exact) return null;
    assertConfiguredResource(exact, input, this.config);
    return exact;
  }

  async create(
    input: CloudProviderCreateInput,
  ): Promise<CloudProviderResource> {
    if (
      input.imageRef !== this.config.snapshotId ||
      input.architecture !== this.config.architecture ||
      input.cpuMillicores !== this.config.cpuMillicores ||
      input.memoryMiB !== this.config.memoryMiB ||
      input.storageMiB !== this.config.storageMiB
    ) {
      throw new CloudProviderError(
        "provider_generation_mismatch",
        "Requested cloud generation does not match the configured Daytona image and resources",
        false,
      );
    }
    const existing = assertSingleProviderResource(
      await this.find(input),
      input,
    );
    if (existing) {
      const hydrated = await this.hydrateExisting(existing, input);
      if (hydrated) return hydrated;
    }

    try {
      const created = resource(
        await this.client.create(
          {
            name: providerName(input),
            snapshot: this.config.snapshotId,
            target: this.config.target,
            labels: identityLabels(input),
            public: false,
            cpu: input.cpuMillicores / 1_000,
            memory: input.memoryMiB / 1_024,
            disk: input.storageMiB / 1_024,
            // The engine owns idleness because provider preview traffic and
            // background agents do not reliably update provider activity.
            autoStopInterval: this.config.autoStopMinutes,
            autoArchiveInterval: this.config.autoArchiveMinutes,
            autoDeleteInterval: this.config.autoDeleteMinutes,
          },
          { timeoutSeconds: this.config.operationTimeoutSeconds },
        ),
      );
      assertProviderResourceIdentity(created, input);
      assertConfiguredResource(created, input, this.config);
      return created;
    } catch (error) {
      // Conflicts and retryable transport failures can mean the first request
      // committed remotely. Inspect immutable labels before a later retry can
      // create another resource.
      const status = transportStatus(error);
      const retryAfterMs = retryAfterMilliseconds(error);
      if (
        status === 409 ||
        (isRetryableTransportFailure(error) &&
          status !== 425 &&
          status !== 429 &&
          retryAfterMs === undefined)
      ) {
        const recovered = assertSingleProviderResource(
          await this.find(input),
          input,
        );
        if (recovered) {
          const hydrated = await this.hydrateExisting(recovered, input);
          if (hydrated) return hydrated;
        }
      }
      throw normalizeDaytonaError(error, "create");
    }
  }

  async inspect(resourceId: string): Promise<CloudProviderResource | null> {
    assertResourceId(resourceId);
    try {
      return resourceForId(await this.client.get(resourceId), resourceId);
    } catch (error) {
      if (transportStatus(error) === 404) return null;
      throw normalizeDaytonaError(error, "inspect");
    }
  }

  private async mutate(
    resourceId: string,
    operation: "start" | "stop" | "archive",
  ): Promise<CloudProviderResource> {
    assertResourceId(resourceId);
    try {
      if (operation !== "start") {
        await this.revokeSshAccess(resourceId);
      }
      const currentRaw = await this.client.get(resourceId);
      const current = resourceForId(currentRaw, resourceId);
      const rawState = String(currentRaw.state ?? "unknown");
      const observedState = current.state;
      if (operation === "start") {
        if (
          observedState === "running" ||
          ["starting", "resuming", "restoring"].includes(rawState)
        ) {
          return current;
        }
        return resourceForId(
          await this.client.start(
            resourceId,
            this.config.operationTimeoutSeconds,
          ),
          resourceId,
        );
      }
      if (operation === "stop") {
        if (
          observedState === "stopped" ||
          observedState === "archived" ||
          observedState === "stopping"
        ) {
          return current;
        }
        return resourceForId(
          await this.client.stop(
            resourceId,
            this.config.operationTimeoutSeconds,
          ),
          resourceId,
        );
      }
      if (
        observedState === "archived" ||
        observedState === "archiving" ||
        observedState === "stopping"
      ) {
        return current;
      }
      if (observedState !== "stopped") {
        // Archiving requires a stopped sandbox. Return the observed stop
        // transition; the durable reconciler will archive on its next pass.
        return resourceForId(
          await this.client.stop(
            resourceId,
            this.config.operationTimeoutSeconds,
          ),
          resourceId,
        );
      }
      return resourceForId(
        await this.client.archive(
          resourceId,
          this.config.operationTimeoutSeconds,
        ),
        resourceId,
      );
    } catch (error) {
      if (transportStatus(error) === 404) {
        throw new CloudProviderError(
          "provider_resource_missing",
          `Daytona resource disappeared during ${operation}`,
          false,
          { cause: error },
        );
      }
      throw normalizeDaytonaError(error, operation);
    }
  }

  start(resourceId: string): Promise<CloudProviderResource> {
    return this.mutate(resourceId, "start");
  }

  stop(resourceId: string): Promise<CloudProviderResource> {
    return this.mutate(resourceId, "stop");
  }

  archive(resourceId: string): Promise<CloudProviderResource> {
    return this.mutate(resourceId, "archive");
  }

  async delete(resourceId: string): Promise<void> {
    assertResourceId(resourceId);
    const pending = (cause?: unknown) =>
      new CloudProviderError(
        "provider_delete_unverified",
        "Daytona still reports the resource while deletion converges",
        true,
        cause === undefined ? undefined : { cause },
      );
    const before = await this.inspect(resourceId);
    if (!before) return;
    try {
      await this.revokeSshAccess(resourceId);
    } catch (error) {
      const observed = await this.inspect(resourceId).catch(() => before);
      if (!observed) return;
      if (observed.state === "deleting" || transportStatus(error) === 409) {
        throw pending(error);
      }
      throw normalizeDaytonaError(error, "delete access revocation");
    }
    if (before.state === "deleting") throw pending();
    try {
      await this.client.delete(resourceId, this.config.operationTimeoutSeconds);
    } catch (error) {
      if (transportStatus(error) === 404) return;
      const observed = await this.inspect(resourceId).catch(() => before);
      if (!observed) return;
      if (observed.state === "deleting" || transportStatus(error) === 409) {
        throw pending(error);
      }
      throw normalizeDaytonaError(error, "delete");
    }
    if (await this.inspect(resourceId)) throw pending();
  }

  async createSshAccess(
    resourceId: string,
    expiresInMinutes: number,
  ): Promise<CloudProviderSshAccess> {
    assertResourceId(resourceId);
    if (
      !Number.isSafeInteger(expiresInMinutes) ||
      expiresInMinutes < 1 ||
      expiresInMinutes > 60
    ) {
      throw new CloudProviderError(
        "provider_access_ttl_invalid",
        "SSH access expiry must be between 1 and 60 minutes",
        false,
      );
    }
    try {
      const issuedAt = Date.now();
      const result = await this.client.createSshAccess(
        resourceId,
        expiresInMinutes,
      );
      try {
        const credential = assertAccessToken(result.token, "SSH credential");
        const expiresAt = normalizedExpiry(result.expiresAt);
        const commandMatch =
          typeof result.sshCommand === "string"
            ? /^ssh ([A-Za-z0-9._~-]{16,4096})@([A-Za-z0-9.-]{1,253})$/.exec(
                result.sshCommand,
              )
            : null;
        const host = commandMatch?.[2]?.toLowerCase() ?? "";
        const allowedHosts = this.config.allowedSshHosts ?? DEFAULT_SSH_HOSTS;
        if (
          result.sandboxId !== resourceId ||
          !PROVIDER_ACCESS_ID_PATTERN.test(result.id) ||
          commandMatch?.[1] !== credential ||
          !HOST_PATTERN.test(host) ||
          !exactAllowedHost(host, allowedHosts) ||
          !expiresAt ||
          expiresAt.getTime() <= issuedAt ||
          expiresAt.getTime() > issuedAt + expiresInMinutes * 60_000 + 120_000
        ) {
          throw invalidAccessResponse(
            "Daytona returned an invalid SSH access contract",
          );
        }
        return {
          providerAccessId: result.id,
          credential,
          host,
          command: `ssh ${credential}@${host}`,
          expiresAt,
        };
      } catch (validationError) {
        if (
          validationError instanceof CloudProviderError &&
          validationError.code === "provider_access_response_invalid"
        ) {
          try {
            await this.revokeSshAccess(resourceId);
          } catch (cleanupError) {
            throw new CloudProviderError(
              "provider_access_cleanup_unverified",
              "Daytona SSH access response was invalid and provider-wide cleanup was not proven",
              true,
              {
                cause: new AggregateError([validationError, cleanupError]),
              },
            );
          }
        }
        throw validationError;
      }
    } catch (error) {
      throw normalizeDaytonaError(error, "create SSH access");
    }
  }

  async revokeSshAccess(resourceId: string): Promise<void> {
    assertResourceId(resourceId);
    try {
      const result = await this.client.revokeSshAccess(resourceId, undefined);
      if (result.id !== resourceId) {
        throw invalidAccessResponse(
          "Daytona acknowledged SSH revocation for another sandbox",
        );
      }
    } catch (error) {
      // Revocation is idempotent once the whole sandbox no longer exists.
      if (transportStatus(error) === 404) return;
      throw normalizeDaytonaError(error, "revoke SSH access");
    }
  }

  async getPreviewEndpoint(
    resourceId: string,
    port: number,
  ): Promise<CloudProviderPreviewEndpoint> {
    assertResourceId(resourceId);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new CloudProviderError(
        "provider_preview_port_invalid",
        "Preview port must be between 1 and 65535",
        false,
      );
    }
    try {
      const result = await this.client.getPreviewUrl(resourceId, port);
      const headerValue = assertAccessToken(result.token, "preview credential");
      let url: URL;
      try {
        url = new URL(result.url);
      } catch {
        throw invalidAccessResponse("Daytona returned an invalid preview URL");
      }
      const suffixes =
        this.config.allowedPreviewHostSuffixes ?? DEFAULT_PREVIEW_HOST_SUFFIXES;
      const expectedHosts = suffixes.map((suffix) =>
        `${port}-${resourceId}.${suffix}`.toLowerCase(),
      );
      if (
        result.sandboxId !== resourceId ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        !HOST_PATTERN.test(url.hostname) ||
        !expectedHosts.includes(url.hostname.toLowerCase())
      ) {
        throw invalidAccessResponse(
          "Daytona returned an invalid private preview endpoint",
        );
      }
      return {
        url: url.toString(),
        headerName: "x-daytona-preview-token",
        headerValue,
      };
    } catch (error) {
      throw normalizeDaytonaError(error, "get preview endpoint");
    }
  }

  async *listManaged(): AsyncIterable<CloudProviderResource> {
    try {
      for await (const sandbox of this.client.list({
        labels: { [MANAGED_LABEL]: "true" },
        limit: 100,
      })) {
        yield resource(sandbox);
      }
    } catch (error) {
      throw normalizeDaytonaError(error, "list managed resources");
    }
  }
}
