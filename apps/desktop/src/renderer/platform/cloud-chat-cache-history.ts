import { NativeCloudCacheError, type NativeCloudChatCacheClient } from "./cloud-chat-cache-client";
import { CloudCacheTargetSchema, type CloudCacheTarget } from "../../../shared/cloud-chat-cache";

export async function readNativeCloudHistory(
  native: NativeCloudChatCacheClient,
  target: Omit<CloudCacheTarget, "chatId">,
  op: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (!native.owner || !["messages.window", "messages.windowOlder"].includes(op) || params.before !== undefined) return null;
  const parsed = CloudCacheTargetSchema.safeParse({ ...target, chatId: params.chatId });
  const limit = params.limit;
  if (!parsed.success || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500 ||
      op === "messages.windowOlder" && typeof params.beforeMsgId !== "string") return null;
  const epoch = native.epoch;
  try {
    const range = op === "messages.window"
      ? (await native.refresh(parsed.data, limit)).range
      : await native.refreshBefore(parsed.data, params.beforeMsgId as string, limit);
    if (epoch !== native.epoch) throw new NativeCloudCacheError("owner_changed");
    if (!range) return null;
    if (op === "messages.window") void native.refreshPending(parsed.data).catch(() => {});
    return { messages: range.rows.map(({ index: _index, ...row }) => row),
      ...(range.historyState ? { historyState: range.historyState } : {}),
      ...(range.turnOpening ? { turnOpening: range.turnOpening } : {}),
    };
  } catch (error) {
    if (epoch !== native.epoch) throw new NativeCloudCacheError("owner_changed");
    if (error instanceof NativeCloudCacheError && ["access_lost", "owner_changed"].includes(error.reason)) throw error;
    return null;
  }
}
