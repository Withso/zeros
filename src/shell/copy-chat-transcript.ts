// ──────────────────────────────────────────────────────────
// copy-chat-transcript — the chat tab's "Copy … transcript" actions
// ──────────────────────────────────────────────────────────
//
// Reads the chat's COMPLETE persisted transcript from the engine (not the
// renderer's windowed slot — see loadFullTranscript), formats it as Markdown,
// and puts it on the clipboard.
//
// Toast-reports every DISTINCT outcome so a failed pick is never a dead end:
// the engine read failing, an empty chat, and a rejected clipboard write are
// three different messages, not one ambiguous "couldn't copy". A truncated
// (very large) transcript still copies, but says so.
//
// copyToClipboardWithFallback rather than navigator.clipboard directly: this
// path awaits an engine round-trip before writing, and the context menu has
// already dropped focus to <body> by then — the async Clipboard API rejects
// with "Document is not focused" in exactly that shape, where the
// execCommand fallback does not.
// ──────────────────────────────────────────────────────────

import { loadFullTranscript } from "../zeros/agent/agent-history-client";
import {
  formatTranscript,
  type TranscriptMeta,
  type TranscriptMode,
} from "../zeros/agent/transcript-format";
import { toast } from "../zeros/ui/primitives/elements";
import { copyToClipboardWithFallback } from "../zeros/utils/clipboard";

/** Dedupes a repeated pick while the engine read is in flight — a long
 *  transcript takes several round trips and the menu item is re-clickable.
 *  Keyed by chat + mode, NOT global: a slow walk on one tab must not silently
 *  swallow a copy the user asks for on another. */
const inFlight = new Set<string>();

const LABEL: Record<TranscriptMode, string> = {
  full: "Full transcript",
  concise: "Concise transcript",
};

/** Human size for the success toast, matching the app-logs copy convention. */
function sizeLabel(chars: number): string {
  const kb = chars / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export async function copyChatTranscript(
  chatId: string,
  mode: TranscriptMode,
  meta: TranscriptMeta,
): Promise<void> {
  const key = `${chatId}:${mode}`;
  if (inFlight.has(key)) {
    // A long chat takes several round trips. Without this the second pick is
    // the one outcome with no feedback, and reads as a broken menu item.
    toast.info("Still copying that transcript…");
    return;
  }
  inFlight.add(key);
  try {
    let loaded;
    try {
      loaded = await loadFullTranscript(chatId);
    } catch (err) {
      // Don't surface err.message: past the not-connected case these are
      // transport/op strings ("workspace op 'messages.windowOlder' failed"),
      // which tell the user nothing actionable.
      console.error("[Zeros] transcript read failed:", err);
      toast.error("Couldn't read the chat transcript — try again in a moment.");
      return;
    }
    const { messages, complete } = loaded;
    if (messages.length === 0) {
      toast.info("This chat has no messages yet.");
      return;
    }

    const { text, count, truncated } = formatTranscript(messages, mode, meta);
    const unit = mode === "concise" ? "turn" : "message";
    if (count === 0) {
      // Everything in the chat was filtered out — e.g. a concise copy of a
      // chat whose only turns never produced an answer.
      toast.info(
        mode === "concise"
          ? "No answers to copy yet — try the full transcript."
          : "Nothing to copy in this chat.",
      );
      return;
    }

    const copied = await copyToClipboardWithFallback(text);
    if (!copied) {
      toast.error("Couldn't write to the clipboard — focus the app and retry.");
      return;
    }

    const detail = `${count} ${unit}${count === 1 ? "" : "s"} · ${sizeLabel(text.length)}`;
    // `truncated` = the document hit its size cap; `!complete` = the page walk
    // stopped before the start of history. Either way the user holds a partial
    // record and must not be told otherwise.
    if (truncated || !complete) {
      toast.warning(`${LABEL[mode]} copied — most recent ${detail}.`);
    } else {
      toast.success(`${LABEL[mode]} copied — ${detail}.`);
    }
  } catch (err) {
    // The menu item fires this as `void copyChatTranscript(...)`, so anything
    // escaping here would surface as an unhandled rejection and the user
    // would see nothing at all. Formatting and the clipboard helper are the
    // realistic throwers.
    console.error("[Zeros] copy transcript failed:", err);
    toast.error("Couldn't copy the transcript.");
  } finally {
    inFlight.delete(key);
  }
}
