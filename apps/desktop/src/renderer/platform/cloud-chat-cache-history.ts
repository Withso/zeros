import { NativeCloudCacheError, type NativeCloudChatCacheClient } from "./cloud-chat-cache-client";
import { CloudCacheTargetSchema, type CloudCacheKnown, type CloudCacheRendererDecline, type CloudCacheTarget } from "../../../shared/cloud-chat-cache";

/** Declines are batched to main.log's launch line: one report per burst, counts by closed class only. */
export const DECLINE_REPORT_MS = 5_000;
const declines = new Map<NativeCloudChatCacheClient, { counts: Map<CloudCacheRendererDecline, number>; timer?: ReturnType<typeof setTimeout> }>();
function decline(native: NativeCloudChatCacheClient, reason: CloudCacheRendererDecline): null {
  let entry = declines.get(native);
  if (!entry) { entry = { counts: new Map() }; declines.set(native, entry); }
  entry.counts.set(reason, (entry.counts.get(reason) ?? 0) + 1);
  entry.timer ??= setTimeout(() => {
    const batch = entry!; declines.delete(native);
    void native.report(Object.fromEntries(batch.counts));
  }, DECLINE_REPORT_MS);
  return null;
}

export async function readNativeCloudHistory(
  native: NativeCloudChatCacheClient,
  target: Omit<CloudCacheTarget, "chatId">,
  op: string,
  params: Record<string, unknown>,
  known?: CloudCacheKnown,
): Promise<Record<string, unknown> | null> {
  if (!["messages.window", "messages.windowOlder"].includes(op)) return null;
  if (!native.owner) return decline(native, "no_owner");
  if (params.before !== undefined) return decline(native, "index_page");
  // Only the three key fields: the runtime client's request target is parsed from a scoped id ({id}) or a folder
  // ({relativePath}), and the strict schema refused those, so build 968 sent every transcript read past main.
  const parsed = CloudCacheTargetSchema.safeParse({ organizationId: target.organizationId, workspaceId: target.workspaceId, chatId: params.chatId });
  const limit = params.limit;
  if (!parsed.success) return decline(native, "target");
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) return decline(native, "limit");
  if (op === "messages.windowOlder" && typeof params.beforeMsgId !== "string") return decline(native, "older_cursor");
  const epoch = native.epoch;
  try {
    const refreshed = op === "messages.window"
      ? await native.refresh(parsed.data, limit, known)
      : { range: await native.refreshBefore(parsed.data, params.beforeMsgId as string, limit) };
    if (epoch !== native.epoch) throw new NativeCloudCacheError("owner_changed");
    if (!refreshed.range) return decline(native, "older_uncached");
    const range = refreshed.range;
    // An unchanged chat makes no read at all; the prompt queue has its own reader (cloudPrompts) for live state.
    if (op === "messages.window" && !("cached" in refreshed && refreshed.cached)) void native.refreshPending(parsed.data).catch(() => {});
    return { messages: range.rows.map(({ index: _index, ...row }) => row),
      ...(range.historyState ? { historyState: range.historyState } : {}),
      ...(range.turnOpening ? { turnOpening: range.turnOpening } : {}),
      // Team sharing: senders stored with the cached rows answer attribution without a messages.senders read.
      ...(range.senders ? { senders: range.senders } : {}),
    };
  } catch (error) {
    if (epoch !== native.epoch) throw new NativeCloudCacheError("owner_changed");
    if (error instanceof NativeCloudCacheError && ["access_lost", "owner_changed"].includes(error.reason)) throw error;
    return decline(native, error instanceof NativeCloudCacheError && error.reason === "unsupported" ? "fallback_unsupported" : "fallback_unavailable");
  }
}
