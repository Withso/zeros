import { CloudCacheRequestSchema, type CloudCacheReply } from "../../shared/cloud-chat-cache";
import { CloudCacheAccessLost, CloudCacheChanged, CloudCacheUnsupported, type CloudChatCacheService } from "./service";

interface Admission { window: number; current(): boolean }
/** The launch summary is logged this long after process start (the census window is the launch minute). */
export const SUMMARY_MS = 60_000;
/** Where a failure arose (an error may carry its own `stage`): closed classes only, never paths, ids or values. */
const stageOf = (error: unknown, fallback: string): string => {
  const stage = (error as { stage?: unknown } | null)?.stage;
  return typeof stage === "string" && /^[a-z_]{1,32}$/.test(stage) ? stage : fallback;
};

export function createCloudChatCacheCommand<Event>(deps: {
  service(): Promise<CloudChatCacheService>;
  admit(event: Event): Admission;
  /** One main.log line per state: "opened" (or "open failed") once, "ready" once, each failure class at counts
   * 1, 2, 4, 8..., and one "launch" summary SUMMARY_MS after creation. Closed classes and counts only. */
  log?(line: string): void;
  schedule?(run: () => void, milliseconds: number): void;
}): (args: unknown, event: Event) => Promise<CloudCacheReply> {
  const log = deps.log ?? (line => console.info(`[cloud-chat-cache] ${line}`));
  const schedule = deps.schedule ?? ((run, milliseconds) => { setTimeout(run, milliseconds).unref?.(); });
  let ready = false, opened = false;
  let latest: CloudChatCacheService | undefined;
  const failures = new Map<string, number>(), renderer = new Map<string, number>();
  const failed = (op: string, reply: Extract<CloudCacheReply, { ok: false }>, stage: string): CloudCacheReply => {
    const key = `op=${op} reason=${reply.reason} stage=${stage}`, count = (failures.get(key) ?? 0) + 1;
    failures.set(key, count);
    if ((count & (count - 1)) === 0) log(`failure ${key} count=${count}`);
    return reply;
  };
  const list = (counts: ReadonlyMap<string, number>) => [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, count]) => `${name}=${count}`).join(",") || "none";
  const summary = () => {
    const outcomes = latest?.outcomes() ?? new Map();
    const declined = new Map([...failures].map(([key, count]) => [key.replace(/^op=/, "").replace(/ reason=/, "/").replace(/ stage=/, "/"), count]));
    log(`launch outcomes=${list(outcomes)} declined=${list(declined)} renderer=${list(renderer)}`);
  };
  // From process start (the command is created at startup): a launch whose renderer never asks main still logs a line.
  schedule(summary, SUMMARY_MS);
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
      latest = service;
      if (!opened) {
        opened = true;
        try { const rows = service.stats(); log(`opened chats=${rows.chats} messages=${rows.messages}`); }
        catch (error) { log(`open failed stage=${stageOf(error, "store_open")}`); }
      }
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
        case "report":
          for (const [name, count] of Object.entries(input.declines)) renderer.set(name, Math.min(1_000_000_000, (renderer.get(name) ?? 0) + count!));
          result = null; break;
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
