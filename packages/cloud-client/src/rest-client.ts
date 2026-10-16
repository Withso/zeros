/**
 * Typed REST client for the Zeros cloud control-plane surface (S3 Part 1).
 *
 * The operation ids and paths come from the generated contract module — there
 * is no hand-written path string in the caller. Authentication is the control
 * plane's session bearer; runtime/* routes additionally carry the replica's
 * device proof headers (zeros-device-id / zeros-device-session / zeros-device-proof).
 */
import { REST_OPERATIONS, type RestOperationId } from "./generated/rest";

/** The replica device proof headers (same scheme as the desktop engine client). */
export type DeviceProofHeaders = {
  deviceId: string;
  keyVersion: number | string;
  timestampMs: number | string;
  nonce: string;
  signature: string;
};

export type CloudRestResponse<T = unknown> = {
  status: number;
  body: T;
  /** true when the control plane replayed an earlier answer for the key. */
  replayed: boolean;
};

export type CloudRestErrorInput = {
  status: number;
  code: string;
  message?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  operationId?: string;
};

/** Parsed S3 Error envelope. `retryable` and `retryAfterMs` drive the outbox. */
export class CloudRestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly operationId?: string;

  constructor(input: CloudRestErrorInput) {
    super(input.message ?? `cloud request failed: ${input.status} ${input.code}`);
    this.name = "CloudRestError";
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    if (input.retryAfterMs !== undefined) this.retryAfterMs = input.retryAfterMs;
    if (input.operationId !== undefined) this.operationId = input.operationId;
  }
}

export type RetryDecision =
  | { kind: "retry"; afterMs?: number }
  | { kind: "terminal"; code: string };

/**
 * S3 retry policy: network failures, 429, 502-504 and a body retryable:true
 * may retry with the SAME Idempotency-Key; any other 4xx is terminal and is
 * reported once. Unknown 5xx stays terminal — the user decides, not the loop.
 */
export function classifyFailure(input: {
  networkError?: boolean;
  status?: number;
  body?: unknown;
}): RetryDecision {
  if (input.networkError) return { kind: "retry" };
  const status = input.status ?? 0;
  if (status === 429 || status === 502 || status === 503 || status === 504) return { kind: "retry" };
  const body = input.body as { error?: { code?: unknown; retryable?: unknown } } | undefined;
  const code = typeof body?.error?.code === "string" ? body.error.code : "request_failed";
  if (body?.error?.retryable === true) return { kind: "retry" };
  return { kind: "terminal", code };
}

export const RETRY_BASE_MS = 250;
export const RETRY_CAP_MS = 30_000;

/** Full jitter: uniform(0, min(cap, base * 2^attempt)). */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const bound = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.floor(random() * bound);
}

export type InvokeOptions = {
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  idempotencyKey?: string;
  /** Attach the replica's device proof headers (runtime/* routes). */
  deviceProof?: boolean;
  signal?: AbortSignal;
};

export interface CloudRestClientOptions {
  baseUrl: string;
  getAccessToken: () => string | Promise<string>;
  getDeviceProof?: () => DeviceProofHeaders | Promise<DeviceProofHeaders>;
  fetchImpl?: typeof fetch;
}

export class CloudRestClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: () => string | Promise<string>;
  private readonly getDeviceProof?: () => DeviceProofHeaders | Promise<DeviceProofHeaders>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CloudRestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.getAccessToken = options.getAccessToken;
    if (options.getDeviceProof) this.getDeviceProof = options.getDeviceProof;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** POST …/cloud-workspaces — Idempotency-Key required. */
  create(organization: string, body: unknown, options: { idempotencyKey: string; signal?: AbortSignal }) {
    return this.invoke("createCloudWorkspace", {
      pathParams: { organization },
      body,
      idempotencyKey: options.idempotencyKey,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /** PATCH …/cloud-workspaces/{workspace} — Idempotency-Key required. */
  rename(organization: string, workspace: string, name: string, options: { idempotencyKey: string; signal?: AbortSignal }) {
    return this.invoke("renameCloudWorkspace", {
      pathParams: { organization, workspace },
      body: { name },
      idempotencyKey: options.idempotencyKey,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /** POST …/cloud-workspaces/{workspace}/{wake|stop|archive} or DELETE — Idempotency-Key required. */
  lifecycle(
    organization: string,
    workspace: string,
    operation: "wake" | "stop" | "archive" | "delete",
    options: { idempotencyKey: string; signal?: AbortSignal },
  ) {
    if (operation === "delete")
      return this.invoke("deleteCloudWorkspace", {
        pathParams: { organization, workspace },
        idempotencyKey: options.idempotencyKey,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    return this.invoke("runCloudWorkspaceLifecycle", {
      pathParams: { organization, workspace, operation },
      idempotencyKey: options.idempotencyKey,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  async invoke<T = unknown>(operationId: RestOperationId, options: InvokeOptions = {}): Promise<CloudRestResponse<T>> {
    const operation = (REST_OPERATIONS as readonly { id: string; method: string; path: string }[])
      .find((candidate) => candidate.id === (operationId as string));
    if (!operation) throw new Error(`unknown operation: ${String(operationId)}`);
    let path = operation.path;
    for (const [key, value] of Object.entries(options.pathParams ?? {})) {
      path = path.split(`{${key}}`).join(encodeURIComponent(value));
    }
    if (/\{[^}]+\}/.test(path))
      throw new Error(`missing path parameter for ${operationId}: ${path}`);
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.getAccessToken()}`,
      "zeros-contract-version": "v1",
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
    if (options.deviceProof) {
      if (!this.getDeviceProof) throw new Error(`operation ${operationId} requires a device proof`);
      const proof = await this.getDeviceProof();
      headers["x-zeros-device-id"] = proof.deviceId;
      headers["x-zeros-device-key-version"] = String(proof.keyVersion);
      headers["x-zeros-device-timestamp"] = String(proof.timestampMs);
      headers["x-zeros-device-nonce"] = proof.nonce;
      headers["x-zeros-device-signature"] = proof.signature;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: operation.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (cause) {
      throw new CloudRestError({
        status: 0,
        code: "network_error",
        message: cause instanceof Error ? cause.message : "network request failed",
        retryable: true,
        operationId,
      });
    }
    const body = await readJson(response);
    if (!response.ok) {
      const envelope = body as { error?: { code?: unknown; message?: unknown; retryable?: unknown; retryAfterMs?: unknown } } | undefined;
      throw new CloudRestError({
        status: response.status,
        code: typeof envelope?.error?.code === "string" ? envelope.error.code : "request_failed",
        message: typeof envelope?.error?.message === "string" ? envelope.error.message : undefined,
        retryable: envelope?.error?.retryable === true,
        retryAfterMs:
          typeof envelope?.error?.retryAfterMs === "number" ? envelope.error.retryAfterMs : undefined,
        operationId,
      });
    }
    return {
      status: response.status,
      body: body as T,
      replayed: response.headers.get("idempotency-replayed") === "true",
    };
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
