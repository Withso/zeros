import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { CloudV2PromptCounterSchema } from "@zeros/protocol/cloud-v2-prompts";
import {
  CloudCacheDeltaSchema, CloudCacheKeySchema, CloudCachePendingSchema, CloudCachePendingRowSchema, CloudCacheRangeSchema,
  type CloudCacheDelta, type CloudCacheKey, type CloudCachePending, type CloudCacheRange,
} from "../../shared/cloud-chat-cache";
import { CloudCacheAccessLost, CloudCacheUnsupported, type CloudCacheRequestContext, type CloudChatCacheSource } from "./service";

const MAX_BYTES = 64 * 1024 ** 2;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const workspaceReply = z.object({ workspace: z.object({ id: z.string().uuid(), organizationId: z.string().uuid() }) });
const pendingReply = z.object({
  epoch: CloudV2PromptCounterSchema, items: z.array(CloudCachePendingRowSchema).max(100),
  nextAfter: CloudV2PromptCounterSchema.nullable(), queueRevision: counter.optional(),
});
/** `stage` is a closed class for main.log (commands.ts): never a path, id or value. */
const unavailable = (stage = "source") => Object.assign(new Error("Cloud cache transport unavailable."), { stage });
const staged = (error: unknown, fallback: string) => typeof (error as { stage?: unknown } | null)?.stage === "string" ? error : unavailable(fallback);
const aborted = (signal: AbortSignal) => unavailable((signal.reason as { name?: string } | undefined)?.name === "TimeoutError" ? "source_timeout" : "source_aborted");
class QueueChanged extends Error {}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw unavailable("source_schema");
  return result.data;
}
function check(context: CloudCacheRequestContext): void {
  context.current();
  if (context.signal.aborted) throw aborted(context.signal);
}
async function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw aborted(signal);
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => { abort = () => reject(aborted(signal)); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([promise, stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}

export class ControlPlaneCloudChatCacheSource implements CloudChatCacheSource {
  private readonly base: string;
  constructor(private readonly deps: {
    baseUrl: string;
    session(): Promise<{ accountId: string; sessionId: string; accessToken: string } | null>;
    fetch: typeof fetch;
    wait?(milliseconds: number, signal: AbortSignal): Promise<void>;
  }) {
    const base = new URL(deps.baseUrl);
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw unavailable();
    this.base = base.toString().replace(/\/+$/, "");
  }

  private async request(key: CloudCacheKey, suffix: string, context: CloudCacheRequestContext, body?: unknown, receipts = false): Promise<unknown> {
    parse(CloudCacheKeySchema, key); check(context);
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]);
    let session: Awaited<ReturnType<typeof this.deps.session>>;
    try { session = await until(this.deps.session(), signal); }
    catch (error) { check(context); throw staged(error, "source_session"); }
    check(context);
    if (!session || !session.accessToken) throw unavailable("source_session");
    if (key.owner !== JSON.stringify([this.base, session.accountId]) || session.sessionId !== context.session) throw unavailable("source_identity");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.accessToken}`, "X-Zeros-Team-Sharing": "1", Accept: "application/json",
      ...(receipts ? { "X-Zeros-Chat-Cache": "1" } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    };
    let response: Response;
    try {
      response = await until(this.deps.fetch(`${this.base}/v1/cloud-v2/workspaces/${encodeURIComponent(key.workspaceId)}${suffix}`, {
        method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, redirect: "error",
      }), signal);
    } catch (error) { check(context); throw signal.aborted ? aborted(signal) : staged(error, "source_network"); }
    try { check(context); }
    catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
    let value: unknown;
    try { value = await this.json(response, signal, response.ok ? MAX_BYTES : 8192); }
    catch (error) {
      check(context);
      if (response.status === 403 || response.status === 404) throw new CloudCacheAccessLost();
      throw staged(error, "source_body");
    }
    check(context);
    if (!response.ok) {
      const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(value);
      const code = error.success ? error.data.error.code : undefined;
      if (response.status === 403 || response.status === 404) throw new CloudCacheAccessLost(code === "chat_not_found" ? "chat" : "workspace");
      if (response.status === 400 && code === "invalid_request" && suffix === "/history") throw new CloudCacheUnsupported();
      if (response.status === 409 && code === "queue_changed" && receipts) throw new QueueChanged();
      throw unavailable(response.status >= 500 ? "source_http_5xx" : response.status === 401 ? "source_http_401" : "source_http_4xx");
    }
    return value;
  }

  private async json(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
    if (!response.body || Number(response.headers.get("content-length")) > maxBytes) {
      void response.body?.cancel().catch(() => {}); throw unavailable("source_body_size");
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await until(reader.read(), signal);
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > maxBytes) throw unavailable("source_body_size");
        chunks.push(chunk.value);
      }
      return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    } catch (error) { throw staged(error, "source_body"); }
    finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async workspace(key: CloudCacheKey, context: CloudCacheRequestContext): Promise<{ id: string; organizationId: string }> {
    return parse(workspaceReply, await this.request(key, "", context)).workspace;
  }
  async range(key: CloudCacheKey, fromIndex: number, toIndex: number, context: CloudCacheRequestContext): Promise<CloudCacheRange> {
    parse(counter, fromIndex); parse(counter, toIndex);
    if (toIndex < fromIndex || toIndex - fromIndex > 500) throw unavailable("source_request");
    return parse(z.object({ result: CloudCacheRangeSchema }), await this.request(key, "/history", context, {
      op: "messages.range", params: { chatId: key.chatId, fromIndex, toIndex },
    })).result;
  }
  async since(key: CloudCacheKey, revision: number, context: CloudCacheRequestContext): Promise<CloudCacheDelta> {
    parse(counter, revision);
    return parse(z.object({ result: CloudCacheDeltaSchema }), await this.request(key, "/history", context, {
      op: "messages.since", params: { chatId: key.chatId, revision },
    })).result;
  }

  async pending(key: CloudCacheKey, original: CloudCacheRequestContext): Promise<CloudCachePending | null> {
    const context = { ...original, signal: AbortSignal.any([original.signal, AbortSignal.timeout(30_000)]) };
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.pendingSnapshot(key, context); }
      catch (error) {
        check(context);
        if (!(error instanceof QueueChanged) || attempt === 2) throw error instanceof QueueChanged ? unavailable("source_pending") : error;
        if (this.deps.wait) await until(this.deps.wait(100 * (attempt + 1), context.signal), context.signal);
        else await delay(100 * (attempt + 1), undefined, { signal: context.signal }).catch(() => { throw unavailable("source_pending"); });
        check(context);
      }
    }
    throw unavailable("source_pending");
  }

  private async pendingSnapshot(key: CloudCacheKey, context: CloudCacheRequestContext): Promise<CloudCachePending | null> {
    let revision: number | undefined, epoch: string | undefined, after = "0", bytes = 0;
    const items: CloudCachePending["items"] = [];
    for (let pageIndex = 0; pageIndex <= 500; pageIndex++) {
      check(context);
      const query = new URLSearchParams({ chatId: key.chatId, after, limit: "100", includePayload: "true" });
      if (revision !== undefined) query.set("queueRevision", String(revision));
      const reply = parse(pendingReply, await this.request(key, `/prompts?${query}`, context, undefined, true));
      if (revision === undefined && reply.queueRevision === undefined) return null;
      if (revision === undefined) { revision = reply.queueRevision; epoch = reply.epoch; }
      if (reply.queueRevision !== revision || reply.epoch !== epoch) throw unavailable("source_pending");
      let sequence = BigInt(after);
      for (const item of reply.items) {
        if (item.receipt.workspaceId !== key.workspaceId || item.receipt.chatId !== key.chatId || BigInt(item.receipt.sequence) <= sequence ||
          item.payload && (item.payload.chatId !== key.chatId || item.payload.userMessageId !== item.receipt.userMessageId)) throw unavailable("source_pending");
        sequence = BigInt(item.receipt.sequence);
      }
      bytes += Buffer.byteLength(JSON.stringify(reply), "utf8");
      if (bytes > MAX_BYTES || items.length + reply.items.length > 50_000) throw unavailable("source_pending");
      items.push(...reply.items);
      if (reply.nextAfter === null) return parse(CloudCachePendingSchema, { queueRevision: revision, epoch, items });
      if (!reply.items.length || BigInt(reply.nextAfter) !== sequence || sequence <= BigInt(after)) throw unavailable("source_pending");
      after = reply.nextAfter;
    }
    throw unavailable("source_pending");
  }
}
