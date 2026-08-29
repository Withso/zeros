import {
  Configuration,
  SandboxApi,
  type CreateSandbox,
  type Sandbox,
  type SandboxListItem,
} from "@daytona/api-client";

import {
  assertSingleProviderResource,
  CloudProviderError,
  type CloudProviderCreateInput,
  type CloudProviderIdentity,
  type CloudProviderObservedState,
  type CloudProviderResource,
  type CloudWorkspaceProvider,
} from "./provider.js";

const MANAGED_LABEL = "zeros_managed";
const WORKSPACE_LABEL = "zeros_workspace";
const GENERATION_LABEL = "zeros_generation";
const API_CLIENT_VERSION = "0.190.1";

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
  autoArchiveMinutes: number;
};

/** Test seam for transport failures without depending on Axios internals. */
export class DaytonaTransportError extends Error {
  readonly statusCode: number | undefined;
  readonly transportCode: string | undefined;

  constructor(
    message: string,
    options: { statusCode?: number; transportCode?: string } = {},
  ) {
    super(message);
    this.name = "DaytonaTransportError";
    this.statusCode = options.statusCode;
    this.transportCode = options.transportCode;
  }
}

type ErrorShape = {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown };
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

function sameNumber(actual: unknown, expected: number): boolean {
  return typeof actual === "number" && Math.abs(actual - expected) < 1e-9;
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
    metadata.autoStopMinutes !== 0 ||
    metadata.autoArchiveMinutes !== config.autoArchiveMinutes ||
    metadata.autoDeleteMinutes !== -1
  ) {
    throw new CloudProviderError(
      "provider_resource_configuration_mismatch",
      "Daytona resource does not match the pinned Zeros generation",
      false,
    );
  }
}

function normalizeError(error: unknown, operation: string): CloudProviderError {
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
      },
    );
  }
  return new CloudProviderError("provider_request_failed", message, false, {
    cause: error,
  });
}

export class DaytonaWorkspaceProvider implements CloudWorkspaceProvider {
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
        resources.push(resource(sandbox));
        if (resources.length > 1) break;
      }
      return resources;
    } catch (error) {
      throw normalizeError(error, "find");
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
            autoStopInterval: 0,
            autoArchiveInterval: this.config.autoArchiveMinutes,
            autoDeleteInterval: -1,
          },
          { timeoutSeconds: this.config.operationTimeoutSeconds },
        ),
      );
      assertConfiguredResource(created, input, this.config);
      return created;
    } catch (error) {
      // Conflicts and retryable transport failures can mean the first request
      // committed remotely. Inspect immutable labels before a later retry can
      // create another resource.
      if (
        transportStatus(error) === 409 ||
        isRetryableTransportFailure(error)
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
      throw normalizeError(error, "create");
    }
  }

  async inspect(resourceId: string): Promise<CloudProviderResource | null> {
    try {
      return resource(await this.client.get(resourceId));
    } catch (error) {
      if (transportStatus(error) === 404) return null;
      throw normalizeError(error, "inspect");
    }
  }

  private async mutate(
    resourceId: string,
    operation: "start" | "stop" | "archive",
  ): Promise<CloudProviderResource> {
    try {
      const current = await this.client.get(resourceId);
      if (operation === "start") {
        return resource(
          await this.client.start(
            resourceId,
            this.config.operationTimeoutSeconds,
          ),
        );
      }
      if (operation === "stop") {
        return resource(
          await this.client.stop(
            resourceId,
            this.config.operationTimeoutSeconds,
          ),
        );
      }
      if (mapDaytonaState(String(current.state)) !== "stopped") {
        // Archiving requires a stopped sandbox. Return the observed stop
        // transition; the durable reconciler will archive on its next pass.
        return resource(
          await this.client.stop(
            resourceId,
            this.config.operationTimeoutSeconds,
          ),
        );
      }
      return resource(
        await this.client.archive(
          resourceId,
          this.config.operationTimeoutSeconds,
        ),
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
      throw normalizeError(error, operation);
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
    try {
      await this.client.delete(resourceId, this.config.operationTimeoutSeconds);
      if (await this.inspect(resourceId)) {
        throw new CloudProviderError(
          "provider_delete_unverified",
          "Daytona still reports the resource after delete",
          true,
        );
      }
    } catch (error) {
      if (transportStatus(error) === 404) return;
      throw normalizeError(error, "delete");
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
      throw normalizeError(error, "list managed resources");
    }
  }
}
