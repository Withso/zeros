// ──────────────────────────────────────────────────────────
// use-chat-transcript-summaries — the other chats in this folder
// ──────────────────────────────────────────────────────────
//
// Feeds the empty chat's transcript pill row. One engine round trip returns
// every chat in the folder with ≥1 user message, already ordered newest-
// created-first, with the message count and last-activity stamp the pills and
// the hover preview need.
//
// Keyed by (folder, excludeChatId) like every other bridge read here: a
// workspace switch must never render the previous folder's chats for a frame,
// because "attach this chat's history" pointing at the wrong worktree is a
// wrong answer, not a stale pixel.
// ──────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

import { listChatSummariesForFolder } from "./agent-history-client";
import { onActiveBridgeConnected } from "../../platform/bridge/active-bridge";
import { useBridge } from "../../platform/bridge/use-bridge";
import type { ChatSummaryWire } from "./agent-history-client";

/** Coalesce re-pulls. The engine already debounces its messages broadcast to
 *  250ms, but a streaming background chat still fires it four times a second
 *  and every one of those would otherwise be a round trip for a row that only
 *  needs its counts to look live. The FIRST pull is never delayed. */
const REPULL_DEBOUNCE_MS = 400;

const EMPTY: readonly ChatSummaryWire[] = [];

export interface TranscriptSummaries {
  /** Ordered newest-created first. Empty until the first read lands — the row
   *  renders nothing rather than a skeleton (see the row's own comment). */
  summaries: readonly ChatSummaryWire[];
  /** False until the first read for THIS folder settles EITHER WAY. Lets a
   *  caller distinguish "no other chats" from "haven't looked yet", both of
   *  which yield an empty list but only one of which should keep waiting.
   *
   *  "Either way" is load-bearing and was not true until 2026-07-30: this
   *  tracked only the success path, so a read that threw left it false forever
   *  — there is no retry except the next DB_CHANGED, and a down bridge doesn't
   *  send those. Harmless while the only consumer drew nothing either way; not
   *  harmless now that the provenance block WAITS on it (see
   *  provenanceBlockShape). A failed read has to degrade to "nothing to offer"
   *  so the empty state falls back to the workspace rows, rather than leaving
   *  a new chat tab permanently blank. */
  loaded: boolean;
}

/**
 * @param folder      Chat's cwd. Falsy → nothing to read.
 * @param excludeChatId  The current chat; attaching your own in-progress
 *                       transcript to your own prompt is a loop the agent
 *                       already has.
 * @param enabled     False for a retained-but-hidden pane. AGENTS.md: hidden
 *                    surfaces must be inert — without this, every background
 *                    chat tab re-pulls this list on every DB_CHANGED tick.
 */
export function useChatTranscriptSummaries(
  folder: string | null | undefined,
  excludeChatId: string | null | undefined,
  enabled = true,
): TranscriptSummaries {
  const [snapshot, setSnapshot] = useState<{
    key: string;
    value: readonly ChatSummaryWire[];
  } | null>(null);
  // The key whose read has FINISHED, success or failure. Separate from
  // `snapshot` because a failure must not overwrite usable data but must still
  // end the wait — see `loaded`.
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const bridge = useBridge();
  // `\u0000` as the escape, never a literal NUL: one raw NUL byte in the
  // source makes git classify this file as BINARY, which silently drops it
  // from every diff, review and content grep in the repo.
  const key = `${folder ?? ""}\u0000${excludeChatId ?? ""}`;

  useEffect(() => {
    if (!enabled || !folder) return;
    let cancelled = false;
    // Monotonic pull token. DB_CHANGED fires back-to-back while a background
    // chat streams and the responses can resolve out of order; only the
    // LATEST issued pull may commit, or the counts walk backwards.
    let pullGen = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pull = async () => {
      const gen = ++pullGen;
      try {
        const next = await listChatSummariesForFolder({
          folder,
          excludeChatId: excludeChatId ?? undefined,
        });
        if (cancelled || gen !== pullGen) return;
        setSnapshot({ key, value: next });
      } catch {
        // Bridge not ready, or a transient transport failure. Keep the last
        // confirmed snapshot — never reset usable data because a refresh
        // started (AGENTS.md).
      } finally {
        // Settled either way. A superseded or cancelled pull says nothing:
        // marking the key done from a stale response would end the wait on
        // behalf of a read that is still running.
        if (!cancelled && gen === pullGen) setSettledKey(key);
      }
    };

    void pull();

    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void pull();
      }, REPULL_DEBOUNCE_MS);
    };

    const off = bridge?.on("DB_CHANGED", (msg) => {
      const change = msg as { kinds?: unknown };
      const kinds = Array.isArray(change.kinds)
        ? (change.kinds as unknown[]).filter(
            (k): k is string => typeof k === "string",
          )
        : [];
      // "messages" moves a count and a last-active stamp; "chats" adds,
      // removes, renames or archives a row. Both change what this row draws.
      // Deliberately NOT filtered by the broadcast's chatIds: a chat that just
      // received its first user message is one this list did not previously
      // contain, so filtering on ids we already know would miss exactly the
      // arrival we most want to show.
      if (!kinds.includes("messages") && !kinds.includes("chats")) return;
      schedule();
    });

    // Retry on the CONNECTED edge — the same edge hydrateChat, use-projects
    // and use-settings already listen to.
    //
    // Without it this hook has exactly one attempt per effect run, and the
    // effect does not re-run on reconnect: `bridge` is a stable RuntimeClient
    // whose identity survives a socket drop, so none of the deps change. A
    // first pull that rejects — a cold open where the request times out at 10s
    // while the client is still inside its 20s reconnect grace, an engine
    // respawn, a dropped WORKSPACE_REQUEST — therefore left the row empty
    // until something else wrote to the DB, and an idle empty chat writes
    // nothing. `initial: true` is skipped: that fire is the synchronous
    // already-connected one at subscribe time, which the `void pull()` above
    // has just covered.
    const offConnected = onActiveBridgeConnected((_client, { initial }) => {
      if (!initial) void pull();
    });

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      off?.();
      offConnected();
    };
  }, [bridge, folder, excludeChatId, key, enabled]);

  const fresh = snapshot?.key === key;
  return {
    summaries: fresh ? snapshot.value : EMPTY,
    // `fresh ||` is not redundant: a success sets both, but the settled key is
    // set from a `finally` and the snapshot from the try, so reading only one
    // of them would make the flag depend on which state React committed first.
    loaded: fresh || settledKey === key,
  };
}
