import { CloudCacheRequestSchema, type CloudCacheReply } from "../../shared/cloud-chat-cache";
import { CloudCacheAccessLost, CloudCacheChanged, CloudCacheUnsupported, type CloudChatCacheService } from "./service";

interface Admission { window: number; current(): boolean }
/** Where a failure arose (an error may carry its own `stage`): closed classes only, never paths, ids or values. */
const stageOf = (error: unknown, fallback: string): string => {
  const stage = (error as { stage?: unknown } | null)?.stage;
  return typeof stage === "string" && /^[a-z_]{1,32}$/.test(stage) ? stage : fallback;
};

export function createCloudChatCacheCommand<Event>(deps: {
  service(): Promise<CloudChatCacheService>;
  admit(event: Event): Admission;
  /** One main.log line per state: "ready" once, and each failure class at counts 1, 2, 4, 8... (bounded, visible). */
  log?(line: string): void;
}): (args: unknown, event: Event) => Promise<CloudCacheReply> {
  const log = deps.log ?? (line => console.info(`[cloud-chat-cache] ${line}`));
  let ready = false;
  const failures = new Map<string, number>();
  const failed = (op: string, reply: Extract<CloudCacheReply, { ok: false }>, stage: string): CloudCacheReply => {
    const key = `op=${op} reason=${reply.reason} stage=${stage}`, count = (failures.get(key) ?? 0) + 1;
    failures.set(key, count);
    if ((count & (count - 1)) === 0) log(`failure ${key} count=${count}`);
    return reply;
  };
  return async (args, event) => {
    let admission: Admission | undefined, stage = "admission";
    const op = typeof (args as { op?: unknown } | null)?.op === "string" && /^[a-z-]{1,16}$/.test((args as { op: string }).op)
      ? (args as { op: string }).op : "invalid";
    try {
      admission = deps.admit(event);
      stage = "request";
      const parsed = CloudCacheRequestSchema.safeParse(args);
      if (!parsed.success) return failed(op, { ok: false, reason: "unavailable" }, "request");
      if (!admission.current()) throw new CloudCacheChanged();
      stage = "service";
      const service = await deps.service();
      stage = "operation";
      if (!admission.current()) throw new CloudCacheChanged();
      const input = parsed.data, window = admission.window;
      let result: unknown;
      switch (input.op) {
        case "bind": result = { lease: service.bind(window, input.owner, input.client) }; break;
        case "read": {
          const pending = service.readPending(window, input.lease, input.target);
          result = { range: service.read(window, input.lease, input.target, input.limit), pending }; break;
        }
        case "read-before": result = service.readBefore(window, input.lease, input.target, input.revision, input.before, input.limit); break;
        case "refresh": result = await service.refresh(window, input.lease, input.target, input.limit, input.known); break;
        case "refresh-before": result = await service.refreshBefore(window, input.lease, input.target, input.before, input.limit); break;
        case "refresh-pending": result = await service.refreshPending(window, input.lease, input.target); break;
        case "protect": service.protect(window, input.lease, input.target); result = null; break;
        case "forget": for (const target of input.targets) service.forget(window, input.lease, target); result = null; break;
        case "list": result = service.list(window, input.lease, input.after); break;
        case "release": service.unbind(window, input.lease); result = null; break;
      }
      if (!admission.current()) throw new CloudCacheChanged();
      if (!ready) { ready = true; log("ready"); }
      return { ok: true, result };
    } catch (error) {
      const at = stageOf(error, stage);
      if (admission && !admission.current() || error instanceof CloudCacheChanged) return failed(op, { ok: false, reason: "owner_changed" }, at);
      if (error instanceof CloudCacheUnsupported) return failed(op, { ok: false, reason: "unsupported" }, at);
      // Access loss is an authoritative answer, not a cache failure.
      if (error instanceof CloudCacheAccessLost) return { ok: false, reason: "access_lost", scope: error.scope };
      return failed(op, { ok: false, reason: "unavailable" }, at);
    }
  };
}
