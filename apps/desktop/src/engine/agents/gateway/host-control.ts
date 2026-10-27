import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RuntimeMcpServerSchema, type RuntimeMcpServer } from "@zeros/protocol/cloud-v2-relay";

export interface McpLocalAdmission {
  organizationId: string;
  repository: string;
  runtimeId: string;
}
const account = z.string().min(1).max(256);
const resolved = z.object({ accountId: account, servers: z.array(RuntimeMcpServerSchema).max(128) }).strict();
const authorized = z.object({ accountId: account,
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/), z.string().max(16384).refine(value => !/[\r\n\0]/.test(value)))
    .refine(headers => Object.keys(headers).length <= 128),
  expiresAt: z.number().finite().optional(),
}).strict();
const failed = () => new Error("MCP request could not complete.");

/** Private engine/main pipe only. No renderer courier, persisted account
 * bearer, idle polling, or late response surviving an account switch. */
export class McpHostControl {
  private readonly pending = new Map<string, {
    action: "resolve" | "authorization"; accountId?: string;
    resolve: (value: unknown) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>; cleanup: () => void;
  }>();
  private closed = false;
  private epoch = 0;
  private accountId?: string;
  constructor(private readonly send: (line: string) => void, private readonly timeoutMs = 30_000) {}
  get generation(): number { return this.epoch; }
  isCurrent(generation: number, accountId: string): boolean {
    return !this.closed && generation === this.epoch && accountId === this.accountId;
  }
  resolve(admission: McpLocalAdmission, signal?: AbortSignal): Promise<{ accountId: string; servers: RuntimeMcpServer[] }> {
    return this.request({ ...admission, action: "resolve" }, signal) as Promise<z.infer<typeof resolved>>;
  }
  authorize(admission: McpLocalAdmission, serverId: string, accountId: string, force = false, signal?: AbortSignal): Promise<z.infer<typeof authorized>> {
    if (!accountId || accountId !== this.accountId) return Promise.reject(failed());
    return this.request({ ...admission, action: "authorization", accountId, serverId, force }, signal) as Promise<z.infer<typeof authorized>>;
  }
  private request(input: McpLocalAdmission & { action: "resolve" | "authorization"; accountId?: string; serverId?: string; force?: boolean }, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || this.pending.size >= 8 || signal?.aborted) return Promise.reject(failed());
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => { this.finish(requestId)?.reject(failed()); };
      const timer = setTimeout(cancel, this.timeoutMs); timer.unref?.();
      const cleanup = () => signal?.removeEventListener("abort", cancel);
      this.pending.set(requestId, { action: input.action, accountId: input.accountId, resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.send(`${JSON.stringify({ type: "mcp.request", requestId, ...input })}\n`); }
      catch { cancel(); }
    });
  }
  private finish(requestId: string) {
    const entry = this.pending.get(requestId);
    if (entry) { this.pending.delete(requestId); clearTimeout(entry.timer); entry.cleanup(); }
    return entry;
  }
  accept(message: unknown): boolean {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "host.mcp.response") return false;
    const msg = message as Record<string, unknown>;
    if (typeof msg.requestId !== "string") return true;
    const entry = this.finish(msg.requestId);
    if (!entry) return true;
    const result = (entry.action === "resolve" ? resolved : authorized).safeParse(msg.data);
    if (msg.error !== undefined || !result.success || (entry.accountId && entry.accountId !== result.data.accountId) ||
        (this.accountId && this.accountId !== result.data.accountId)) { entry.reject(failed()); return true; }
    this.accountId = result.data.accountId;
    entry.resolve(result.data);
    return true;
  }
  reset(): void {
    this.epoch++;
    this.accountId = undefined;
    for (const id of this.pending.keys()) this.finish(id)?.reject(failed());
  }
  close(): void { this.closed = true; this.reset(); }
}
