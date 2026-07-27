// ──────────────────────────────────────────────────────────
// useCopyLogsHotkey — ⇧⌘L copies recent app logs (INTERNAL)
// ──────────────────────────────────────────────────────────
//
// An INTERNAL feature (Settings → Internal → "Copy logs"): ⇧⌘L copies
// the scrubbed recent-log tail — the exact JSONL a feedback submission
// shares (`logs_recent`, ~500 KB cap, secret-scrubbed in main) — to the
// clipboard, for pasting into a debugging chat without the feedback
// round-trip.
//
// Leak rules (docs/internal-features-2026-07-22.md): the keydown
// listener only ATTACHES while `useInternalFeatureActive("copyLogs")`
// holds — allowlisted account AND flag on. For everyone else the chord
// is completely inert (no listener, no preventDefault, no trace), and
// this shortcut is deliberately ABSENT from the ⌘/ shortcuts catalog
// and the Help menu, so it is undiscoverable. Do not add it there.
//
// ⇧⌘L is free app-wide (⌘L alone belongs to the browser-tab element
// picker, a different chord). Like ⌘/ and ⌥⌘F this fires inside
// editable surfaces too — the chord types nothing, and logs are most
// often wanted mid-conversation with a composer focused. Matches on
// `e.code === "KeyL"` (physical key, layout-agnostic).

import { useEffect } from "react";

import { nativeInvoke } from "../native/runtime";
import { useInternalFeatureActive } from "../zeros/settings/internal-features";
import { toast } from "../zeros/ui/primitives/elements";
import { copyToClipboardWithFallback } from "../zeros/utils/clipboard";

/** Pure matcher for the "copy logs" chord (⇧⌘L / Ctrl+Shift+L), kept
 *  separate from the effect for regression tests. Option/Alt is rejected
 *  so it never collides with the ⌥⌘ chord family. */
export function matchesCopyLogsHotkey(
  event: Pick<
    KeyboardEvent,
    "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code"
  >,
): boolean {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey)
    return false;
  return event.code === "KeyL";
}

/** Dedupes overlapping copies while the IPC round-trip is in flight
 *  (auto-repeat is filtered separately via `event.repeat`). */
let copyInFlight = false;

/** True when a `logs_recent` rejection means the running desktop processes are
 *  OLDER than the renderer's code — the message reads "unknown command" (the
 *  stale main.cjs lacks the handler) or "command not permitted" (the stale
 *  preload allowlist). This is the everyday worktree-dev trap: the renderer
 *  hot-reloads but a named dev instance's main/preload do NOT, so a
 *  freshly-added IPC command 404s until `pnpm electron:dev` is restarted. In a
 *  packaged Beta/Prod build main+preload ship with the renderer, so this branch
 *  is effectively dev-only. Pure — exported for tests. */
export function isStaleProcessError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("unknown command") || msg.includes("command not permitted")
  );
}

/** Fetch the scrubbed recent-log tail from main and put it on the clipboard.
 *  Toast-reports every DISTINCT outcome so a failed press is never a dead end:
 *  the reader failing because the dev main is stale (→ restart), the reader
 *  failing otherwise, an empty store, and a clipboard write that was rejected
 *  are four different messages, not one ambiguous "couldn't copy". */
export async function copyRecentLogsToClipboard(): Promise<void> {
  if (copyInFlight) return;
  copyInFlight = true;
  try {
    let text: string;
    try {
      const res = await nativeInvoke<{ text?: string }>("logs_recent");
      text = typeof res?.text === "string" ? res.text : "";
    } catch (err) {
      toast.error(
        isStaleProcessError(err)
          ? "Copy logs: the app's main process is out of date — restart the dev instance."
          : "Couldn't read the app logs.",
      );
      return;
    }
    if (!text) {
      toast.info("No app logs to copy yet.");
      return;
    }
    // navigator.clipboard alone rejects with "Document is not focused" if focus
    // slipped during the IPC round-trip above; the helper's execCommand fallback
    // isn't subject to that, so this reliably lands rather than erroring.
    const copied = await copyToClipboardWithFallback(text);
    if (!copied) {
      toast.error("Couldn't write to the clipboard — focus the app and retry.");
      return;
    }
    const kb = Math.max(1, Math.round(text.length / 1024));
    toast.success(`App logs copied — ${kb} KB.`);
  } finally {
    copyInFlight = false;
  }
}

/** ⇧⌘L anywhere copies recent app logs — while the internal gate holds
 *  (see header). Mounted once in ShellRouter beside the other global
 *  chords. */
export function useCopyLogsHotkey(): void {
  const active = useInternalFeatureActive("copyLogs");
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if (!matchesCopyLogsHotkey(event)) return;
      // Holding the chord auto-repeats keydown every few ms — one copy
      // (and one toast) per physical press is enough.
      if (event.repeat) return;
      // A more specific surface already claimed this keystroke (e.g. a
      // focused element-picker chip handling its own L-chord) — stand
      // down rather than double-handle.
      if (event.defaultPrevented) return;
      event.preventDefault();
      void copyRecentLogsToClipboard();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active]);
}
