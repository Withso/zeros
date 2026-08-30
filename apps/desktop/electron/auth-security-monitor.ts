const SNAPSHOT_TIMEOUT_MS = 10_000;
const SECURITY_SILENCE_MS = 60_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 64 * 1024;
const MAX_STREAM_LIFETIME_MS = 15 * 60_000;
const MIN_STREAM_LIFETIME_MS = 1_000;

const SECURITY_EVENT_KINDS = new Set([
  "account.revoked",
  "account.authorization_changed",
  "session.revoked",
  "organization.access_revoked",
  "organization.authorization_changed",
  "organization.data_changed",
]);

export type DesktopSecurityEventKind =
  | "account.revoked"
  | "account.authorization_changed"
  | "session.revoked"
  | "organization.access_revoked"
  | "organization.authorization_changed"
  | "organization.data_changed";

export type DesktopSecurityFrame = {
  event: string;
  id: string | null;
  data: string;
};

export type DesktopSecuritySession = {
  provider: "auth0" | "workos";
  accessToken: string;
  accountId?: string;
  sessionId?: string;
};

type SecuritySnapshot = {
  account: { id: string; status: "active"; revision: number };
  session: { id: string; status: "active" };
  organizations: Array<{
    id: string;
    role: "owner" | "admin" | "member";
    authorizationRevision: number;
    membershipRevision: number;
    dataRevision: number;
  }>;
  cursor: number;
};

type SecurityEvent = {
  sequence: number;
  kind: DesktopSecurityEventKind;
  organizationId: string | null;
  accountRevision: number | null;
  authorizationRevision: number | null;
  dataRevision: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

type MonitorLogger = Pick<Console, "warn" | "error">;

export type WorkOSDesktopSecurityMonitorOptions = {
  baseUrl: string;
  getSession(): Promise<DesktopSecuritySession | null>;
  clearSession(expected: { accountId: string; sessionId: string }): boolean;
  emit(name: string, payload: unknown): void;
  fetch?: typeof fetch;
  now?: () => number;
  logger?: MonitorLogger;
  /** Test seam: snapshot behavior can be exercised without a live stream. */
  connectStreams?: boolean;
};

function timeout(delayMs: number, callback: () => void): NodeJS.Timeout {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return timer;
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function boundedJson(response: Response): Promise<unknown | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel("response too large").catch(() => undefined);
        return null;
      }
      chunks.push(part.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function parseSnapshot(value: unknown): SecuritySnapshot | null {
  const root = record(value);
  const account = record(root?.account);
  const session = record(root?.session);
  const organizations = root?.organizations;
  if (
    !root ||
    !account ||
    !session ||
    typeof account.id !== "string" ||
    account.status !== "active" ||
    !safeInteger(account.revision, 1) ||
    typeof session.id !== "string" ||
    session.status !== "active" ||
    !Array.isArray(organizations) ||
    organizations.length > 10_000 ||
    !safeInteger(root.cursor)
  ) {
    return null;
  }
  const parsedOrganizations: SecuritySnapshot["organizations"] = [];
  for (const item of organizations) {
    const organization = record(item);
    if (
      !organization ||
      typeof organization.id !== "string" ||
      !["owner", "admin", "member"].includes(String(organization.role)) ||
      !safeInteger(organization.authorizationRevision, 1) ||
      !safeInteger(organization.membershipRevision, 1) ||
      !safeInteger(organization.dataRevision, 1)
    ) {
      return null;
    }
    parsedOrganizations.push({
      id: organization.id,
      role: organization.role as "owner" | "admin" | "member",
      authorizationRevision: organization.authorizationRevision,
      membershipRevision: organization.membershipRevision,
      dataRevision: organization.dataRevision,
    });
  }
  return {
    account: {
      id: account.id,
      status: "active",
      revision: account.revision,
    },
    session: { id: session.id, status: "active" },
    organizations: parsedOrganizations,
    cursor: root.cursor,
  };
}

function snapshotSignature(snapshot: SecuritySnapshot): string {
  return JSON.stringify([
    snapshot.account.id,
    snapshot.account.revision,
    snapshot.session.id,
    [...snapshot.organizations]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((organization) => [
        organization.id,
        organization.role,
        organization.authorizationRevision,
        organization.membershipRevision,
        organization.dataRevision,
      ]),
  ]);
}

function parseSecurityEvent(value: string): SecurityEvent | null {
  if (!value || value.length > MAX_SSE_EVENT_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const event = record(parsed);
  if (
    !event ||
    !safeInteger(event.sequence, 1) ||
    typeof event.kind !== "string" ||
    !SECURITY_EVENT_KINDS.has(event.kind) ||
    (event.organizationId !== null &&
      typeof event.organizationId !== "string") ||
    (event.payload !== undefined && !record(event.payload)) ||
    typeof event.createdAt !== "string"
  ) {
    return null;
  }
  const nullableRevision = (value: unknown): number | null | undefined =>
    value === null ? null : safeInteger(value, 1) ? value : undefined;
  const accountRevision = nullableRevision(event.accountRevision);
  const authorizationRevision = nullableRevision(event.authorizationRevision);
  const dataRevision = nullableRevision(event.dataRevision);
  if (
    accountRevision === undefined ||
    authorizationRevision === undefined ||
    dataRevision === undefined
  ) {
    return null;
  }
  return {
    sequence: event.sequence,
    kind: event.kind as DesktopSecurityEventKind,
    organizationId: event.organizationId as string | null,
    accountRevision,
    authorizationRevision,
    dataRevision,
    payload: (record(event.payload) ?? {}) as Record<string, unknown>,
    createdAt: event.createdAt,
  };
}

export function desktopSecurityEventAction(
  kind: string,
): "sign_out" | "refresh" | "none" {
  if (kind === "account.revoked" || kind === "session.revoked") {
    return "sign_out";
  }
  return SECURITY_EVENT_KINDS.has(kind) ? "refresh" : "none";
}

/** Minimal bounded SSE parser. It accepts arbitrary chunk boundaries and
 * refuses an event that grows beyond the control-plane contract. */
export async function consumeSecurityEventStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: DesktopSecurityFrame) => void | Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let event = "message";
  let id: string | null = null;
  let data: string[] = [];
  let eventBytes = 0;

  const dispatch = async () => {
    if (data.length > 0) {
      await onFrame({ event, id, data: data.join("\n") });
    }
    event = "message";
    id = null;
    data = [];
    eventBytes = 0;
  };

  const line = async (raw: string) => {
    const value = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (value === "") {
      await dispatch();
      return;
    }
    if (value.startsWith(":")) return;
    eventBytes += Buffer.byteLength(value, "utf8") + 1;
    if (eventBytes > MAX_SSE_EVENT_BYTES) {
      throw new Error("security SSE event exceeded its bound");
    }
    const separator = value.indexOf(":");
    const field = separator < 0 ? value : value.slice(0, separator);
    let fieldValue = separator < 0 ? "" : value.slice(separator + 1);
    if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
    if (field === "event" && /^[a-z0-9._-]{1,128}$/.test(fieldValue)) {
      event = fieldValue;
    } else if (field === "id" && /^\d{1,16}$/.test(fieldValue)) {
      id = fieldValue;
    } else if (field === "data") {
      data.push(fieldValue);
    }
  };

  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffered += decoder.decode(part.value, { stream: true });
      if (Buffer.byteLength(buffered, "utf8") > MAX_SSE_EVENT_BYTES) {
        throw new Error("security SSE line exceeded its bound");
      }
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const current = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        await line(current);
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered) await line(buffered);
    await dispatch();
  } finally {
    reader.releaseLock();
  }
}

function accessTokenExpiration(accessToken: string): number | null {
  try {
    const encoded = accessToken.split(".")[1];
    if (!encoded) return null;
    const payload = JSON.parse(
      Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf8",
      ),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1_000
      : null;
  } catch {
    return null;
  }
}

function exactEventStream(response: Response): boolean {
  return (
    (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase() === "text/event-stream"
  );
}

export class WorkOSDesktopSecurityMonitor {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly logger: MonitorLogger;
  private readonly baseUrl: string;
  private readonly connectStreams: boolean;
  private stopped = false;
  private lastContactAt = 0;
  private cursor = 0;
  private lastSnapshotSignature: string | null = null;
  private revalidation: Promise<
    "active" | "signed_out" | "transient" | "idle"
  > | null = null;
  private streamAbort: AbortController | null = null;
  private streamGeneration = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;

  constructor(private readonly options: WorkOSDesktopSecurityMonitorOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.connectStreams = options.connectStreams !== false;
    const url = new URL(options.baseUrl);
    const loopback =
      url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !loopback) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Desktop security monitor requires an HTTPS or loopback origin");
    }
    this.baseUrl = url.origin;
  }

  start(): void {
    this.stopped = false;
    void this.revalidate("launch", true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.disconnectStream();
    await this.revalidation;
  }

  private disconnectStream(): void {
    this.streamGeneration += 1;
    this.streamAbort?.abort();
    this.streamAbort = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private terminate(
    binding: { accountId: string; sessionId: string },
    reason: string,
  ): "signed_out" {
    this.disconnectStream();
    if (this.options.clearSession(binding)) {
      this.options.emit("auth-security-revoked", { reason });
    }
    return "signed_out";
  }

  revalidate(
    _reason: string,
    force = false,
  ): Promise<"active" | "signed_out" | "transient" | "idle"> {
    if (this.stopped) return Promise.resolve("idle");
    if (
      !force &&
      this.lastContactAt > 0 &&
      this.now() - this.lastContactAt < SECURITY_SILENCE_MS
    ) {
      return Promise.resolve("active");
    }
    if (this.revalidation) return this.revalidation;
    const task = this.revalidateNow().finally(() => {
      if (this.revalidation === task) this.revalidation = null;
    });
    this.revalidation = task;
    return task;
  }

  private async revalidateNow(): Promise<
    "active" | "signed_out" | "transient" | "idle"
  > {
    let session: DesktopSecuritySession | null;
    try {
      session = await this.options.getSession();
    } catch {
      return "transient";
    }
    if (
      session?.provider !== "workos" ||
      !session.accountId ||
      !session.sessionId
    ) {
      this.disconnectStream();
      return "idle";
    }
    const binding = {
      accountId: session.accountId,
      sessionId: session.sessionId,
    };
    const controller = new AbortController();
    const timer = timeout(SNAPSHOT_TIMEOUT_MS, () => controller.abort());
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/auth/snapshot`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return "transient";
    }
    try {
      if (response.status === 401 || response.status === 403) {
        const body = record(await boundedJson(response));
        const error = record(body?.error);
        const reason =
          typeof error?.code === "string"
            ? error.code
            : "authorization_rejected";
        return this.terminate(binding, reason);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return "transient";
      }
      const snapshot = parseSnapshot(await boundedJson(response));
      if (!snapshot) return "transient";
      if (
        snapshot.account.id !== binding.accountId ||
        snapshot.session.id !== binding.sessionId
      ) {
        return this.terminate(binding, "identity_mismatch");
      }
      this.lastContactAt = this.now();
      this.reconnectAttempt = 0;
      const signature = snapshotSignature(snapshot);
      if (
        this.lastSnapshotSignature !== null &&
        this.lastSnapshotSignature !== signature
      ) {
        this.options.emit("auth-security-event", {
          kind: "snapshot.changed",
          organizationId: null,
        });
      }
      this.lastSnapshotSignature = signature;
      this.cursor = snapshot.cursor;
      if (this.connectStreams) this.connectStream(session, binding, this.cursor);
      return "active";
    } catch {
      return "transient";
    } finally {
      clearTimeout(timer);
    }
  }

  private connectStream(
    session: DesktopSecuritySession,
    binding: { accountId: string; sessionId: string },
    after: number,
  ): void {
    this.disconnectStream();
    if (this.stopped) return;
    const generation = this.streamGeneration;
    const controller = new AbortController();
    this.streamAbort = controller;
    const expiresAt = accessTokenExpiration(session.accessToken);
    const lifetime = Math.max(
      MIN_STREAM_LIFETIME_MS,
      Math.min(
        MAX_STREAM_LIFETIME_MS,
        (expiresAt ?? this.now() + MAX_STREAM_LIFETIME_MS) - this.now() - 30_000,
      ),
    );
    const lifetimeTimer = timeout(lifetime, () => controller.abort());

    void this.consumeConnection(
      session,
      binding,
      after,
      generation,
      controller,
    )
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.logger.warn(
            `[auth-security] stream ended: ${
              error instanceof Error ? error.name : "unknown"
            }`,
          );
        }
      })
      .finally(() => {
        clearTimeout(lifetimeTimer);
        if (
          this.stopped ||
          generation !== this.streamGeneration ||
          this.streamAbort !== controller
        ) {
          return;
        }
        this.streamAbort = null;
        this.scheduleReconnect();
      });
  }

  private async consumeConnection(
    session: DesktopSecuritySession,
    binding: { accountId: string; sessionId: string },
    after: number,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/auth/events?after=${encodeURIComponent(String(after))}`,
      {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${session.accessToken}`,
          "last-event-id": String(after),
        },
        signal: controller.signal,
      },
    );
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      this.terminate(binding, "authorization_rejected");
      return;
    }
    if (!response.ok || !response.body || !exactEventStream(response)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("security stream unavailable");
    }
    await consumeSecurityEventStream(response.body, async (frame) => {
      if (
        this.stopped ||
        generation !== this.streamGeneration ||
        controller.signal.aborted
      ) {
        return;
      }
      if (frame.event === "ready" || frame.event === "heartbeat") {
        this.lastContactAt = this.now();
        this.reconnectAttempt = 0;
        return;
      }
      const event = parseSecurityEvent(frame.data);
      if (!event || event.kind !== frame.event) return;
      this.lastContactAt = this.now();
      this.reconnectAttempt = 0;
      this.cursor = Math.max(this.cursor, event.sequence);
      const action = desktopSecurityEventAction(event.kind);
      if (action === "sign_out") {
        this.terminate(binding, event.kind);
        return;
      }
      if (action === "refresh") {
        this.options.emit("auth-security-event", event);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(60_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 6);
    this.reconnectTimer = timeout(delay, () => {
      this.reconnectTimer = null;
      void this.revalidate("reconnect", true).then((outcome) => {
        if (outcome === "transient") this.scheduleReconnect();
      });
    });
  }
}
