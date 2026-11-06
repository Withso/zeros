// Which chat made each of a pull request's commits, for the Commits rows and
// the Activity stream. The Local engine and the cloud worker record the
// commits a turn's own tools made (TurnInfo.commits); this reads them by SHA
// through the workspace runtime and joins each to the chat it names.

import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { PrCommitSummary } from "../../../platform/git";
import { turnCommitLinks, type TurnCommitLink } from "../../../platform/turns";
import { KeyedAsyncCache } from "@/renderer/shared/lib/keyed-async-cache";
import type { ChatThread } from "@/renderer/state/store";
import { registerPrWorkspaceCacheForget } from "../../pr/pr-cache-forget";

/** The chat a commit links to, as its row and Activity entry name it. */
export interface ReviewCommitChat {
  chatId: string;
  title: string;
  agentId: string | null;
}

const links = new KeyedAsyncCache<TurnCommitLink[]>(32);
/** Last confirmed links per workspace: a new commit list keeps the links it
 *  shares with the previous one while its own read is in flight. */
const lastConfirmed = new Map<string, TurnCommitLink[]>();
const EMPTY: TurnCommitLink[] = [];
const FRESH_MS = 30_000;

export function reviewCommitChatsKey(workspaceId: string, shas: readonly string[]): string {
  return JSON.stringify([workspaceId, ...shas]);
}

/** Forget a workspace's links (it was removed, or its owner changed). */
export function forgetReviewCommitChats(workspaceId: string): void {
  lastConfirmed.delete(workspaceId);
  for (const key of links.keys()) {
    if ((JSON.parse(key) as string[])[0] === workspaceId) links.forget(key);
  }
}
registerPrWorkspaceCacheForget(forgetReviewCommitChats);

/** sha → the chat behind it. Commits no recorded turn made have no entry. */
export function useReviewCommitChats(
  workspaceId: string,
  commits: readonly PrCommitSummary[] | null,
  chats: readonly ChatThread[],
  active: boolean,
): ReadonlyMap<string, ReviewCommitChat> {
  const shas = useMemo(() => (commits ?? []).map((c) => c.sha), [commits]);
  const key = reviewCommitChatsKey(workspaceId, shas);
  const snapshot = useSyncExternalStore(
    (listener) => links.subscribe(key, listener),
    () => links.getSnapshot(key),
    () => links.getSnapshot(key),
  );

  useEffect(() => {
    if (!active || shas.length === 0) return;
    links
      .load(key, () => turnCommitLinks(workspaceId, shas), { maxAgeMs: FRESH_MS })
      .then((confirmed) => {
        lastConfirmed.set(workspaceId, confirmed);
      })
      .catch(() => {
        // A runtime that can't answer leaves the rows without chat links.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shas is derived from key
  }, [active, key, workspaceId]);

  const resolved = snapshot.data ?? lastConfirmed.get(workspaceId) ?? EMPTY;
  return useMemo(() => commitChatsFor(resolved, shas, chats), [resolved, shas, chats]);
}

/** Join links to the chats the store knows; a deleted chat leaves no link. */
export function commitChatsFor(
  confirmed: readonly TurnCommitLink[],
  shas: readonly string[],
  chats: readonly ChatThread[],
): ReadonlyMap<string, ReviewCommitChat> {
  const wanted = new Set(shas);
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const out = new Map<string, ReviewCommitChat>();
  for (const link of confirmed) {
    const chat = byId.get(link.chatId);
    if (!wanted.has(link.sha) || !chat || chat.kind === "terminal") continue;
    out.set(link.sha, { chatId: chat.id, title: chat.title || "Untitled chat", agentId: chat.agentId });
  }
  return out;
}
