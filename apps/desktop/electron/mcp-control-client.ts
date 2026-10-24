import { z } from "zod";
import { RuntimeMcpServerSchema } from "@zeros/protocol/cloud-v2-relay";

export const MCP_CONTROL_MAX_BYTES = 1024 * 1024;

/** Synchronous safeStorage commit on the private control pipe. Older engines
 * omit requestId; explicit saves receive only a durable success/failure bit. */
export function persistMcpVaultControl(raw: unknown, deps: {
  current(): boolean;
  persist(snapshot: Record<string, unknown>): void;
  write(line: string): boolean;
}): boolean {
  if (!raw || typeof raw !== "object" || !("type" in raw) || raw.type !== "mcp.vault") return false;
  if (!deps.current()) return true;
  const requestId = "requestId" in raw ? z.string().uuid().safeParse(raw.requestId) : undefined;
  if (requestId && !requestId.success) return true;
  let ok = false;
  try {
    if (!("data" in raw) || !raw.data || typeof raw.data !== "object" || Array.isArray(raw.data) ||
      Buffer.byteLength(JSON.stringify(raw)) + 1 > MCP_CONTROL_MAX_BYTES) throw new Error("Invalid MCP vault");
    deps.persist(raw.data as Record<string, unknown>);
    ok = true;
  } catch { /* Never expose storage paths, snapshot values or provider errors. */ }
  if (requestId?.success && deps.current()) {
    try { deps.write(`${JSON.stringify({ type: "host.mcpVaultPersisted", requestId: requestId.data, ok })}\n`); }
    catch { /* The engine may exit after the final live-child check. */ }
  }
  return true;
}

const FAILURE = "MCP request could not complete.";
const account = z.string().min(1).max(256).refine(value => [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
const common = { type: z.literal("mcp.request"), requestId: z.string().uuid(), organizationId: z.string().uuid(),
  repository: z.string().max(255).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(value => !value.split("/").some(part => part === "." || part === "..")),
  runtimeId: z.string().uuid() };
const RequestSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("resolve"), accountId: account.optional() }).strict(),
  z.object({ ...common, action: z.literal("authorization"), accountId: account, serverId: z.string().uuid(), force: z.boolean().optional() }).strict(),
]);
const AuthorizationSchema = z.object({ headers: z.record(z.string().min(1).max(128).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  z.string().max(16384).refine(value => !/[\r\n\0]/.test(value))).refine(value => Object.keys(value).length <= 128),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });
type ControlRequest = z.infer<typeof RequestSchema>;
type Session = { accessToken: string; sub: string; accountId?: string; sessionId?: string; provider?: string };
interface Dependencies {
  session(): Promise<Session | null>;
  baseUrl(): string;
  fetch: typeof fetch;
  current(): boolean;
  /** Writes only to this child's private stdin, never an event or log sink. */
  write(line: string): boolean;
  onSessionChanged(listener: () => void): () => void;
  /** Existing native GitHub user/App intersection; no provider token enters
   * this client's response, the renderer, or an engine environment. */
  admitRepository?(input: { organizationId: string; repository: string }): Promise<void>;
}
const identity = (session: Session) => JSON.stringify([session.provider, session.sub, session.accountId, session.sessionId]);
const accountId = (session: Session) => account.parse(session.accountId ?? session.sub);

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(new Error(FAILURE)); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error(FAILURE));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One exact sidecar generation. Resolved values cross only the private pipe;
 * the renderer, logs, environment and provider credential stores are absent. */
export class McpControlClient {
  private generation = 0;
  private disposed = false;
  private readonly pending = new Map<string, AbortController>();
  private readonly admissions = new Map<string, { expiresAt: number; promise: Promise<void> }>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: Dependencies) {
    this.unsubscribe = deps.onSessionChanged(() => {
      this.generation++;
      this.admissions.clear();
      for (const controller of this.pending.values()) controller.abort();
      this.write({ type: "host.mcp.accountChanged" });
    });
  }

  async receive(raw: unknown): Promise<boolean> {
    if (!raw || typeof raw !== "object" || !("type" in raw) || raw.type !== "mcp.request") return false;
    if (this.disposed || !this.deps.current()) return true;
    const requestId = "requestId" in raw && z.string().uuid().safeParse(raw.requestId).success ? String(raw.requestId) : undefined;
    if (!requestId || this.pending.has(requestId)) return true;
    let request: ControlRequest;
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > 16 * 1024) throw new Error(FAILURE);
      request = RequestSchema.parse(raw);
      if (this.pending.size >= 8) throw new Error(FAILURE);
    } catch { this.write({ type: "host.mcp.response", requestId, error: FAILURE }); return true; }
    const generation = this.generation, controller = new AbortController();
    this.pending.set(requestId, controller);
    const deadline = setTimeout(() => controller.abort(), 27_000); deadline.unref?.();
    try {
      const data = await this.request(request, generation, controller.signal);
      if (generation !== this.generation || !this.deps.current() || this.disposed) return true;
      controller.signal.throwIfAborted();
      const response = { type: "host.mcp.response", requestId, data };
      if (Buffer.byteLength(JSON.stringify(response)) + 1 > MCP_CONTROL_MAX_BYTES) throw new Error(FAILURE);
      if (!this.write(response)) throw new Error(FAILURE);
    } catch {
      if (generation === this.generation) this.write({ type: "host.mcp.response", requestId, error: FAILURE });
    } finally { clearTimeout(deadline); if (this.pending.get(requestId) === controller) this.pending.delete(requestId); }
    return true;
  }

  private async request(request: ControlRequest, generation: number, signal: AbortSignal) {
    const session = await bounded(this.deps.session(), signal);
    if (!session || !session.accessToken || (request.accountId !== undefined && request.accountId !== accountId(session))) throw new Error(FAILURE);
    const origin = this.deps.baseUrl(), url = new URL(origin);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error(FAILURE);
    const assertCurrent = async () => {
      const current = await bounded(this.deps.session(), signal);
      if (!current || identity(current) !== identity(session) || this.generation !== generation || this.disposed || !this.deps.current() || this.deps.baseUrl() !== origin)
        throw new Error(FAILURE);
    };
    await assertCurrent();
    const admissionKey = JSON.stringify([request.organizationId, request.repository.toLowerCase(), request.runtimeId]);
    if (this.deps.admitRepository) {
      let admission = this.admissions.get(admissionKey);
      if (!admission || admission.expiresAt <= Date.now()) {
        if (this.admissions.size >= 128) this.admissions.delete(this.admissions.keys().next().value!);
        const promise = this.deps.admitRepository({ organizationId: request.organizationId, repository: request.repository }).catch(error => {
          if (this.admissions.get(admissionKey)?.promise === promise) this.admissions.delete(admissionKey);
          throw error;
        });
        admission = { expiresAt: Date.now() + 120_000, promise };
        this.admissions.set(admissionKey, admission);
      }
      await bounded(admission.promise, signal);
      await assertCurrent();
    }
    const base = `${url.origin}/v1/organizations/${request.organizationId}/extensions`;
    const endpoint = request.action === "resolve" ? `${base}/mcp/resolve` : `${base}/${request.serverId}/mcp/authorization`;
    const response = await bounded(this.deps.fetch(endpoint, {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ repository: request.repository, runtime: { kind: "local", id: request.runtimeId, admitted: true },
        ...(request.action === "authorization" && request.force !== undefined ? { force: request.force } : {}) }),
    }), signal);
    if (!response.ok || !response.body) {
      if (response.status === 404) this.admissions.delete(admissionKey);
      void response.body?.cancel().catch(() => {}); throw new Error(FAILURE);
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await bounded(reader.read(), signal); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MCP_CONTROL_MAX_BYTES) throw new Error(FAILURE);
        chunks.push(chunk.value);
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    await assertCurrent();
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = request.action === "resolve" ? z.object({ servers: z.array(RuntimeMcpServerSchema).max(128) }).parse(body) : AuthorizationSchema.parse(body);
    return { accountId: accountId(session), ...result };
  }

  private write(message: object): boolean {
    if (this.disposed || !this.deps.current()) return false;
    try { return this.deps.write(`${JSON.stringify(message)}\n`); } catch { return false; }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.unsubscribe();
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
    this.admissions.clear();
  }
}
