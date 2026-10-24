import { TurnUsageCard } from "./turn-usage-card";
import type { CloudV2PromptState } from "@zeros/protocol/cloud-v2-prompts";
import type { CloudTurnEnding } from "./cloud-turn-presentation";
// ──────────────────────────────────────────────────────────
// TurnFooter — the footer below a settled turn's answer
// ──────────────────────────────────────────────────────────
//
// Every completed turn keeps its duration, copy and actions toolbar above a
// bounded card of recorded file changes. Four rows show initially; expanding
// reveals the rest in a ten-row scroll surface. Review opens the exact turn
// in Changes, and each row retains its historical file diff navigation.
//
// Local reads the engine's recorded turn row; cloud uses its mirrored summary.
// Duration falls back to message timestamps when a turn predates recording or
// the chat isn't a git repo.
// ──────────────────────────────────────────────────────────

import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Check,
  GitFork,
  MoreHorizontal,
  Play,
  RotateCcw,
} from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import {
  Button,
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
} from "@/renderer/shared/ui/primitives";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { openTurnChanges, warmTurnChanges } from "@/renderer/shell/workbench/open-turn-changes";
import { useOpenFileInWorkbench } from "@/renderer/shell/workbench/use-open-file";
import {
  turnGet,
  turnReset,
  turnUndoReset,
  type TurnInfo,
} from "@/renderer/platform/turns";
import {
  invalidateTurnRows,
  turnRowCache,
  turnRowKey,
} from "@/renderer/state/read-caches";
import { useCachedRead } from "@/renderer/state/use-cached-read";
import { FileTypeIcon } from "./composer-editor/file-type-icon";
import { partitionTurn } from "./turn-partition";
import { TurnFailureCard } from "./turn-failure-card";
import { turnFailureForCard, turnFailureRecovered, type TurnFailure } from "./turn-failure";
import { useSessionsStore } from "./sessions-store";
import { useAgentSessions } from "./sessions-hooks";
import type { AgentFailure } from "../../platform/bridge/failure";
import type { AgentMessage } from "./use-agent-session";
import {
  DiffHoverCard,
  DiffHoverPreview,
} from "./renderers/diff-hover-preview";
import {
  prefetchWorkspaceFileDiff,
  useWorkspaceFileDiffSnapshot,
  type WorkspaceFileDiffQuery,
} from "@/renderer/shell/workspace-file-data-cache";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { turnCheckpointsAvailable } from "./chat-feature-availability";
import { cloudWorkspaceKey, parseCloudScopedId } from "@/renderer/platform/bridge/cloud-workspace-key";
import type { TurnSummary } from "@zeros/protocol/turns";

const COLLAPSED_FILE_COUNT = 4;

/** Turn completion, reset/undo and late usage invalidate the exact key.
 *  This freshness window exists to
 *  catch out-of-band edits (another device, retention nulling an old snapshot
 *  oid) without making the common case pay for them. */
const TURN_ROW_MAX_AGE_MS = 30_000;

export function isInterruptedTurn(
  turn: Pick<TurnInfo, "status" | "stopReason"> | null,
  fallbackStopReason?: string | null,
): boolean {
  return (
    fallbackStopReason === "cancelled" ||
    turn?.status === "cancelled" ||
    turn?.stopReason === "cancelled"
  );
}

// Named endings use text-only pills with no severity dot, so every terminal
// state reads in one glance from the label alone.
// budget_exhausted is deliberately ABSENT — its "Turn stopped · BUDGET" tool
// call sits right above the footer and already names the ending.
const STOP_REASON_LABELS: Record<string, string> = {
  max_tokens: "TOKEN LIMIT — ANSWER TRUNCATED",
  blocking_limit: "BLOCKED BY USAGE LIMIT",
  prompt_too_long: "PROMPT TOO LONG",
};

/** The one compact in-transcript label for a classified prompt failure. Raw
 * containment/provider diagnostics never belong in this surface. */
export function turnFooterFailureLabel(
  failure: AgentFailure | null,
): string | null {
  if (!failure || failure.stage !== "prompt") return null;
  if (
    failure.kind === "protocol-error" &&
    /agent response failure/i.test(failure.message)
  ) {
    return "AGENT RESPONSE FAILURE";
  }
  switch (failure.kind) {
    case "design-protection-failed":
      return "AGENT STOPPED - DESIGN PROTECTION FAILED";
    case "auth-required":
      return "SIGN IN REQUIRED";
    case "verification-required":
      return "VERIFICATION REQUIRED";
    case "cloud-credentials-unavailable":
      return "CLOUD CREDENTIALS UNAVAILABLE";
    case "subprocess-exited":
      return "AGENT EXITED";
    case "session-expired":
      return "SESSION EXPIRED";
    case "timeout":
      return "AGENT RESPONSE TIMEOUT";
    case "transport-closed":
      return "CONNECTION LOST";
    case "rate-limited":
      return "RATE LIMITED";
    case "protocol-error":
      return "AGENT RESPONSE FAILURE";
    default:
      return null;
  }
}

/** Chat banner policy for a settled turn failure. The card, with its recovery
 *  actions, belongs to the latest turn while nothing newer has started. Once
 *  the agent works on a newer turn the card retires to the footer's one-line
 *  status, so history stays honest without stacking banners. */
export function settledTurnFailurePresentation(
  failure: TurnFailure | null,
  isLatestTurn: boolean,
): { card: TurnFailure | null; label: string | null } {
  if (!failure) return { card: null, label: null };
  if (isLatestTurn) return { card: failure, label: null };
  const label = turnFooterFailureLabel({
    kind: failure.kind as AgentFailure["kind"],
    stage: "prompt",
    message: failure.message,
  });
  return { card: null, label: label ?? "AGENT STOPPED" };
}

/** Recoverable endings that get a one-click Continue on
 *  their own row below the footer. Returns the resolved stop reason when it
 *  is continuable, else null. */
export function continuableStopReason(
  turn: Pick<TurnInfo, "stopReason"> | null,
  fallbackStopReason?: string | null,
): "max_tokens" | "budget_exhausted" | null {
  const reason = turn?.stopReason ?? fallbackStopReason;
  return reason === "max_tokens" || reason === "budget_exhausted"
    ? reason
    : null;
}

export function turnFooterStatusLabel(
  turn: Pick<TurnInfo, "status" | "stopReason"> | null,
  fallbackStopReason?: string | null,
  fallbackStatusLabel?: string | null,
  retrying?: boolean,
  recovered?: boolean,
): string | null {
  if (isInterruptedTurn(turn, fallbackStopReason)) return "STOPPED BY USER";
  // A named stop reason beats the generic failure labels: these
  // turns SETTLED (with a named cause), they didn't fail.
  const named =
    STOP_REASON_LABELS[turn?.stopReason ?? ""] ??
    STOP_REASON_LABELS[fallbackStopReason ?? ""];
  if (named) return named;
  if (recovered) return null;
  if (fallbackStatusLabel) return fallbackStatusLabel;
  // A turn whose recorded row settled "failed" with no live failure to show:
  // the crash was swallowed by a recovery path (most often the duplicate-turn
  // guard — the agent died mid-answer AFTER streaming content, so the resend
  // was skipped and the chat flipped back to ready). Without this pill the
  // truncated answer reads as a completed turn. `retrying` suppresses it
  // while an auto-rebuild is re-running this same turn (the row reads
  // "failed" until the retry re-begins it — a flash, not a settled state).
  if (!retrying && turn?.status === "failed") return "AGENT STOPPED";
  return null;
}

/** Disk-authoritative file changes. A missing row or an authoritative empty row
 *  both render no files; raw tool previews are intentionally not an input. */
export function turnFooterFiles(
  turn: Pick<TurnInfo, "files"> | null,
): TurnInfo["files"] {
  return turn?.files ?? [];
}

/** Metadata-only rows (most commonly a pure rename) do not promise a textual
 * hunk. Every persisted line-changing row can warm and show its exact patch. */
export function canPreviewTurnFileDiff(
  file: Pick<TurnInfo["files"][number], "additions" | "deletions">,
): boolean {
  return file.additions > 0 || file.deletions > 0;
}

/** A fork snapshot must describe a terminal turn, never a moving stream. */
export function canForkTurn(live: boolean, outputText: string): boolean {
  return !live && outputText.trim().length > 0;
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function lastEventTime(events: AgentMessage[]): number {
  let t = 0;
  for (const e of events) {
    const c = (e as { createdAt?: number }).createdAt ?? 0;
    const u = (e as { updatedAt?: number }).updatedAt ?? 0;
    t = Math.max(t, c, u);
  }
  return t;
}

/** Parent continuation output can outlive the engine's first settled send.
 * Ignore child and tool bookkeeping when extending that recorded duration. */
export function turnFooterDuration(
  turn: { startedAt: number; endedAt?: number | null } | null | undefined,
  events: AgentMessage[],
  startedAt: number,
): number {
  const parentOutput = events.filter(
    (e) => e.kind === "text" && e.role === "agent" && !e.parentToolId,
  );
  const end = Math.max(
    turn?.endedAt ?? 0,
    lastEventTime(turn?.endedAt != null ? parentOutput : events),
  );
  return Math.max(0, end - (turn?.startedAt ?? startedAt));
}
interface TurnFileRowProps {
  /** Persisted file delta for this exact turn. */
  file: TurnInfo["files"][number];
  /** Exact turn owner for the historical patch request. */
  chatId: string;
  /** Exact turn identity for the historical patch request. */
  turnId: string;
  /** Workspace cache owner; null is recovered with a chat-scoped stable key. */
  workspaceId: string | null;
  /** Opens this turn-scoped diff in the retained workbench viewer. */
  onOpen: (path: string) => void;
  previewEnabled?: boolean;
}

interface TurnFileDiffHoverPreviewProps {
  path: string;
  diffQuery: WorkspaceFileDiffQuery;
}

/** Radix mounts hover-card content only while it is open. Keeping the shared
 * cache hook in this content-owned child means unopened transcript history
 * creates neither empty cache entries nor immortal listeners. */
const TurnFileDiffHoverPreview = memo(function TurnFileDiffHoverPreview({
  path,
  diffQuery,
}: TurnFileDiffHoverPreviewProps) {
  const diffSnapshot = useWorkspaceFileDiffSnapshot(diffQuery);
  return (
    <DiffHoverPreview
      path={path}
      patch={diffSnapshot.data}
      loading={diffSnapshot.loading}
      error={diffSnapshot.error}
      showPath
      compact
    />
  );
});

/** One footer file row. Pointer/focus intent warms the immutable turn patch;
 * clicking remains an urgent navigation-only action. */
export const TurnFileRow = memo(function TurnFileRow({
  file,
  chatId,
  turnId,
  workspaceId,
  onOpen,
  previewEnabled = true,
}: TurnFileRowProps) {
  const previewable = canPreviewTurnFileDiff(file);
  const diffQuery = useMemo<WorkspaceFileDiffQuery>(
    () => ({
      // Historical turn reads do not actually require workspaceId at the
      // transport boundary. The fallback preserves an exact, non-empty cache
      // owner for older recorded rows that predate workspace attribution.
      workspaceId: workspaceId ?? `turn:${chatId}`,
      path: file.path,
      diffScope: "turn",
      turnChatId: chatId,
      turnId,
    }),
    [workspaceId, chatId, file.path, turnId],
  );
  const warmPreview = useCallback(() => {
    if (previewable && previewEnabled) prefetchWorkspaceFileDiff(diffQuery);
  }, [diffQuery, previewable, previewEnabled]);

  const row = (
    <Button
      type="button"
      onPointerEnter={warmPreview}
      onFocus={warmPreview}
      onClick={() => onOpen(file.path)}
      variant="ghost"
      aria-label={`${file.path}, +${file.additions} −${file.deletions}`}
      data-turn-file={file.path}
      className="text-fg2 hover:bg-bg1-hover hover:text-fg1 flex h-7 w-full min-w-0 justify-start gap-2 rounded-sm px-2 py-1 text-left font-normal"
    >
      <FileTypeIcon name={file.path} size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{baseName(file.path)}</span>
      {/* Both halves render whenever the file changed at all — "+5 −0",
          not a lone "+5" — mirroring the edit rows' badge exactly. */}
      {previewable && (
        <span className="shrink-0 tabular-nums">
          <span className="text-green-primary">+{file.additions}</span>
          <span className="text-red-primary ml-1">−{file.deletions}</span>
        </span>
      )}
    </Button>
  );

  if (!previewable || !previewEnabled) return <Tooltip label={file.path}>{row}</Tooltip>;

  return (
    <DiffHoverCard trigger={row}>
      <TurnFileDiffHoverPreview path={file.path} diffQuery={diffQuery} />
    </DiffHoverCard>
  );
});

export const TurnChangesCard = memo(function TurnChangesCard({
  files, chatId, turnId, workspaceId, onOpen, onReview, onReviewIntent,
  previewEnabled = true,
}: {
  files: TurnInfo["files"];
  chatId: string;
  turnId: string;
  workspaceId: string | null;
  onOpen: (path: string) => void;
  onReview: () => void;
  onReviewIntent?: () => void;
  previewEnabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const focusExpandedRef = useRef(false);
  useLayoutEffect(() => {
    if (!expanded || !focusExpandedRef.current) return;
    focusExpandedRef.current = false;
    listRef.current?.querySelectorAll<HTMLButtonElement>("[data-turn-file]")[COLLAPSED_FILE_COUNT]?.focus({ preventScroll: true });
  }, [expanded]);
  if (!files.length) return null;
  const shown = expanded ? files : files.slice(0, COLLAPSED_FILE_COUNT);
  return (
    <section data-turn-changes aria-label="Turn changes" className="border-border2 bg-bg1-highlight text-fg2 mt-2 min-w-0 rounded-lg border p-1.5 text-xs">
      <div className="flex min-w-0 items-center justify-between gap-2 pl-2">
        <span>{`${files.length} ${files.length === 1 ? "File" : "Files"} Changed`}</span>
        <Button type="button" variant="ghost" onClick={onReview} onPointerEnter={onReviewIntent} onFocus={onReviewIntent} className="text-fg2 hover:bg-bg1-hover font-normal">
          Review
        </Button>
      </div>
      {/* Ten standard 28px rows; only this list scrolls, keeping Review visible. */}
      <div id={listId} ref={listRef} className="max-h-[280px] overflow-y-auto overscroll-contain" data-turn-files>
        {shown.map((file) => (
          <TurnFileRow key={file.path} file={file} chatId={chatId} turnId={turnId} workspaceId={workspaceId} onOpen={onOpen} previewEnabled={previewEnabled} />
        ))}
      </div>
      {!expanded && files.length > COLLAPSED_FILE_COUNT && (
        <Button type="button" variant="ghost" aria-expanded={false} aria-controls={listId} onClick={(event) => {
          // The disclosure disappears; keep keyboard users at the first new row.
          focusExpandedRef.current = event.detail === 0;
          setExpanded(true);
        }} className="text-fg3 hover:bg-bg1-hover w-full justify-start gap-2 px-2 font-normal">
          <MoreHorizontal className="size-3.5" />
          {`Show ${files.length - COLLAPSED_FILE_COUNT} more`}
        </Button>
      )}
    </section>
  );
});

interface TurnFooterProps {
  folder?: string | null;
  recordedSummary?: TurnSummary;
  /** Archived/missing workspaces expose saved metadata and copy only. */
  readOnly?: boolean;
  surfaceActive?: boolean;
  chatId: string;
  /** Opening user-message id = the turn id. */
  turnId: string;
  /** The turn's events (for the copy text + duration fallback). */
  events: AgentMessage[];
  /** Turn start (the user prompt's createdAt). */
  startedAt: number;
  /** True while this turn is still streaming. */
  live: boolean;
  /** Immediate renderer-side fallback before the persisted turn row is fetched. */
  fallbackStopReason?: string | null;
  /** Active-turn terminal status before the persisted turn row is fetched. */
  fallbackStatusLabel?: string | null;
  failure?: AgentFailure | null;
  recoveryFailure?: { kind: string; message: string };
  durablePrompt?: boolean;
  receiptState?: CloudV2PromptState;
  presentation?: CloudTurnEnding;
  onRetry?: () => Promise<void>;
  onRetryNewChat?: () => Promise<void>;
  onRetryNewChatIntent?: () => void;
  /** True while an auto-rebuild is re-running this chat's last turn — hides
   *  the "AGENT STOPPED" pill for a failed row that's about to be retried. */
  retrying?: boolean;
  /** Continue renders only on the chat's last settled turn (a
   *  mid-history Continue would fork the conversation). */
  isLastTurn?: boolean;
  /** One-click resume after a recoverable stop: sends "Continue"
   *  to the same session (full context kept). Provided by the chat shell. */
  onContinue?: (reason: "max_tokens" | "budget_exhausted") => void;
  /** Zeros-native branch: opens a fresh conversation and stages this turn's
   * concise transcript. Provider sessions are never cloned by this action. */
  onFork?: () => void;
  /** Warm the exact historical transcript when the menu item gains intent. */
  onForkIntent?: () => void;
}

export const TurnFooter = memo(function TurnFooter({
  readOnly = false,
  surfaceActive = true,
  chatId,
  turnId,
  folder,
  recordedSummary,
  events,
  startedAt,
  live,
  fallbackStopReason,
  fallbackStatusLabel,
  failure,
  recoveryFailure,
  durablePrompt = false,
  receiptState,
  presentation,
  onRetry,
  onRetryNewChat,
  onRetryNewChatIntent,
  retrying,
  isLastTurn,
  onContinue,
  onFork,
  onForkIntent,
}: TurnFooterProps) {
  const openInWorkbench = useOpenFileInWorkbench();
  // Stable actions context — identity doesn't change on store mutations, so
  // reading it here doesn't defeat this component's memo. Used to cancel an
  // in-flight turn before a reset spans it.
  const sessions = useAgentSessions();
  const [copied, setCopied] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const forkSelectedRef = useRef(false);

  // The recorded turn (authoritative duration, status/stop reason, usage,
  // authored files) as keyed server state: a remount — every chat-tab switch,
  // workspace switch, and app reload rebuilds this transcript — paints the last
  // confirmed row synchronously and revalidates behind it. Read from a local
  // `useState(null)` + fetch-on-mount before, which meant a reopened chat's
  // stopped turn rendered as a plain settled turn (no STOPPED BY USER pill)
  // until the bridge answered.
  //
  // `enabled` keeps a LIVE turn from reading a row that is still being written;
  // the fetch runs as soon as it settles. A missing row (null) is a legitimate
  // value — turns predating recording, or non-git chats.
  const checkpoints = turnCheckpointsAvailable(chatId);
  const turnRead = useCachedRead(
    turnRowCache,
    turnId && checkpoints ? turnRowKey(chatId, turnId) : null,
    () => turnGet(chatId, turnId),
    { maxAgeMs: TURN_ROW_MAX_AGE_MS, enabled: !live && surfaceActive && checkpoints },
  );
  // Sleeping cloud history already contains this summary. Never mount a turn
  // read that would connect to or wake its worker just to paint the footer.
  const turn = useMemo(() => {
    const cloudOwner = parseCloudScopedId(chatId);
    return cloudOwner && recordedSummary ? {
      ...recordedSummary, chatId, turnId,
      folder: cloudWorkspaceKey(cloudOwner), workspaceId: cloudWorkspaceKey(cloudOwner),
      preSnapshot: null, postSnapshot: null,
    } : turnRead.data ? { ...turnRead.data, folder: folder ?? turnRead.data.folder } : null;
  }, [chatId, turnId, recordedSummary, turnRead.data, folder]);

  // The agent's concluding answer text (what the copy button copies).
  const outputText = useMemo(() => {
    const { finalOutput } = partitionTurn(events);
    return finalOutput
      .map((m) => (m.kind === "text" ? m.text : ""))
      .join("\n\n")
      .trim();
  }, [events]);
  const forkEnabled = canForkTurn(live, outputText);

  const onCopy = useCallback(async () => {
    if (!outputText) return;
    try {
      await navigator.clipboard.writeText(outputText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard may be blocked in some sandbox configs */
    }
  }, [outputText]);

  // A click publishes the complete turn-scoped viewer identity immediately;
  // pointer/focus warming is owned by TurnFileRow and never awaited here.
  const onOpenTurnFile = useCallback(
    (path: string) =>
      openInWorkbench(path, {
        diff: true,
        diffScope: "turn",
        turnChatId: chatId,
        turnId,
      }),
    [openInWorkbench, chatId, turnId],
  );

  // Undo a reset by its id: restores the files AND re-inserts the truncated
  // conversation (messages, tool calls, outputs). When the transcript comes
  // back, re-window the chat so it renders here immediately.
  const doUndo = useCallback(
    async (resetId: string) => {
      try {
        const res = await turnUndoReset({ resetId });
        // Rows come back (and the target's status changes) — every cached row
        // for this chat is now suspect.
        invalidateTurnRows();
        const n = res.restored.filter(
          (o) =>
            o.result === "restored" ||
            o.result === "deleted" ||
            o.result === "merged",
        ).length;
        // Divergence-guarded undo: a file edited after the reset that couldn't
        // be merged is left as-is, never overwritten — say so, minimally.
        const kept = res.restored.filter(
          (o) => o.result === "conflict" || o.result === "skipped",
        ).length;
        const keptNote =
          kept > 0
            ? ` ${kept} file${kept === 1 ? "" : "s"} left as-is (edited after the reset).`
            : "";
        if (res.transcriptRestored) {
          await sessions.hydrateChat(chatId);
          toast.success("Undid reset — files + conversation restored", {
            description: `${n} file${n === 1 ? "" : "s"} restored, ${res.messagesRestored} message${res.messagesRestored === 1 ? "" : "s"} brought back.${keptNote}`,
          });
        } else {
          toast.success(
            `Undid reset — ${n} file${n === 1 ? "" : "s"} restored`,
            {
              description: `Files were restored; the conversation wasn’t — this chat was continued past the reset.${keptNote}`,
            },
          );
        }
      } catch (err) {
        toast.error("Couldn’t undo the reset", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [chatId, sessions],
  );

  // Run the reset (only reached AFTER the confirm dialog). Reports the outcome
  // through the toast surface — restored / conflicted / skipped counts — with an
  // Undo action, so a snapshot-less reset that only rolls back the transcript is
  // never silent.
  const runReset = useCallback(async () => {
    setConfirmOpen(false);
    if (resetting || readOnly) return;
    setResetting(true);
    try {
      // If a LATER turn is still streaming, this reset truncates it too — abort
      // the in-flight turn FIRST so the agent stops emitting into a timeline
      // we're about to delete (otherwise its trailing chunks re-persist as
      // zombie rows). Mirrors the edit-&-resubmit guard; a no-op when idle.
      if (
        useSessionsStore.getState().sessions[chatId]?.status === "streaming"
      ) {
        try {
          await sessions.cancel(chatId);
        } catch {
          /* best-effort — proceed with the reset regardless */
        }
      }
      const res = await turnReset({ chatId, turnId });
      if (!res) {
        toast.error("Couldn’t reset — engine unavailable.");
        return;
      }
      // This turn's row and every later one just changed (truncated / restored
      // files), so no cached row survives the reset.
      invalidateTurnRows();
      // Reflect the rollback immediately on THIS device. turns.reset already
      // truncated the chat's messages in SQLite; this is the in-memory half
      // (the same primitive the edit-&-resubmit flow uses). Without it the
      // turn-owning renderer keeps showing the now-deleted turns, its footer
      // lingers, and a second reset would hit "unknown turn". The global toast
      // below survives this footer unmounting.
      useSessionsStore.getState().truncateMessagesFromInMemory(chatId, turnId);
      const restored = res.applied.length;
      const conflicts = res.conflicts.length;
      const skipped = res.skipped.length;
      // Undo is always offered — it restores the transcript even when there was
      // no file snapshot to revert (e.g. a non-git chat).
      const undo = res.resetId
        ? { label: "Undo", onClick: () => void doUndo(res.resetId) }
        : undefined;
      if (conflicts > 0 || skipped > 0) {
        const parts: string[] = [];
        if (restored) parts.push(`${restored} restored`);
        if (conflicts) parts.push(`${conflicts} conflicted`);
        if (skipped) parts.push(`${skipped} skipped`);
        toast.warning(`Reset — ${parts.join(" · ")}`, {
          description:
            conflicts > 0
              ? "Conflicted files were left as-is (a concurrent edit overlapped); the conversation was still rolled back."
              : "Those files had no snapshot to restore from — only the conversation was rolled back.",
          action: undo,
          duration: 8000,
        });
      } else {
        toast.success(
          restored > 0
            ? `Reset to this point — ${restored} file${restored === 1 ? "" : "s"} restored`
            : "Reset to this point",
          { action: undo },
        );
      }
    } catch (err) {
      toast.error("Couldn’t reset to this point", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setResetting(false);
    }
  }, [chatId, turnId, resetting, readOnly, doUndo, sessions]);

  // While the turn is still streaming, render nothing: the working group's
  // ActivityShimmer already shows the live elapsed timer (grey, text-fg2) at the
  // tail. A second timer here would duplicate it and use LiveDuration's default
  // blue directly under the grey shimmer.
  // The footer appears once the turn settles.
  if (live) return null;
  const durationStart = presentation?.startedAt ?? turn?.startedAt ?? startedAt;
  const durationMs = presentation ? Math.max(0, presentation.endedAt - durationStart) : turnFooterDuration(turn, events, startedAt);
  // File changes are deliberately disk-authoritative. A rendered tool call is a
  // proposal, not proof that anything landed (permission may be denied, a tool
  // may fail, or an edit may be a no-op). Only the engine's persisted
  // pre/post-snapshot diff may produce a row. Missing records show no card.
  const files = readOnly ? [] : turnFooterFiles(turn);
  // Whether this selected turn's own files have a retained checkpoint. Later
  // turns are evaluated independently by the reset service; this only controls
  // the selected-turn warning in the confirmation dialog.
  const hasSnapshot = turn?.preSnapshot != null;
  const cardFailure = turnFailureForCard({
    events,
    turnId,
    fallback: failure,
    recoveryFailure,
    live,
    retrying,
    status: presentation?.status ?? receiptState ?? turn?.status,
    stopReason: fallbackStopReason ?? turn?.stopReason,
  });
  // A failure card belongs to the latest turn; older turns keep one line.
  const settledFailure = settledTurnFailurePresentation(cardFailure, !!isLastTurn || durablePrompt);
  const statusLabel = turnFooterStatusLabel(
    presentation ? { status: presentation.status, stopReason: presentation.stopReason ?? null } : turn,
    fallbackStopReason,
    fallbackStatusLabel ?? settledFailure.label,
    retrying,
    turnFailureRecovered(events, turnId),
  );
  // The below-footer Continue row (last turn only).
  const continueReason =
    !readOnly && isLastTurn && onContinue
      ? continuableStopReason(turn, fallbackStopReason)
      : null;
  return (
    <>
      {settledFailure.card && (
        <TurnFailureCard
          failure={settledFailure.card}
          onRetry={!readOnly && (isLastTurn || durablePrompt) ? onRetry : undefined}
          onRetryNewChat={!readOnly && isLastTurn ? onRetryNewChat : undefined}
          onRetryNewChatIntent={onRetryNewChatIntent}
        />
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
        {statusLabel && !settledFailure.card && (
          <div className="basis-full">
            <span className="border-border3 bg-bg1 text-fg1 inline-flex w-fit rounded-sm border px-2 py-0.5 text-xs tracking-wide">
              {statusLabel}
            </span>
          </div>
        )}
        <TurnUsageCard agentId={turn?.agentId} usage={turn?.usage}
          startedAt={durationStart} endedAt={durationStart + durationMs}
          durationMs={durationMs} enabled={surfaceActive} />
        <Tooltip label={copied ? "Copied" : "Copy output"}>
          <IconButton
            type="button"
            onClick={onCopy}
            disabled={!outputText}
            label={copied ? "Copied" : "Copy output"}
            motion="colors"
            className={cn("flex shrink-0", !outputText && "cursor-default")}
          >
            {copied ? (
              <Check className="size-3.5" strokeWidth={2} />
            ) : (
              <Copy className="size-3.5" strokeWidth={2} />
            )}
          </IconButton>
        </Tooltip>
        {!readOnly && (onFork || checkpoints) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                type="button"
                label="Turn actions"
                motion="colors"
                className="flex shrink-0"
              >
                <MoreHorizontal className="size-4" strokeWidth={2} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-52"
              onCloseAutoFocus={(event) => {
                if (!forkSelectedRef.current) return;
                forkSelectedRef.current = false;
                // The trigger belongs to the source tab, which the fork action
                // just hid. Keep Radix from returning focus to that inert tree;
                // the freshly active chat owns the next composer focus pass.
                event.preventDefault();
              }}
            >
              {onFork && (
                <DropdownMenuItem
                  disabled={!forkEnabled}
                  onPointerEnter={onForkIntent}
                  onFocus={onForkIntent}
                  onSelect={() => {
                    forkSelectedRef.current = true;
                    onFork();
                  }}
                >
                  <GitFork className="size-3.5" />
                  Fork to new tab
                </DropdownMenuItem>
              )}
              {checkpoints && (
                <DropdownMenuItem
                  disabled={resetting}
                  onSelect={() => {
                    // Defer so the menu finishes closing (and returns focus) before
                    // the dialog mounts and traps focus — avoids the Radix
                    // menu→dialog race that would otherwise dismiss the dialog.
                    window.setTimeout(() => setConfirmOpen(true), 0);
                  }}
                >
                  <RotateCcw className="size-3.5" />
                  Reset to this point
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {files.length > 0 && turn && (
        <TurnChangesCard
          key={JSON.stringify([chatId, turnId])}
          files={files}
          chatId={chatId}
          turnId={turnId}
          workspaceId={turn.workspaceId}
          onOpen={onOpenTurnFile}
          onReview={() => openTurnChanges(turn)}
          onReviewIntent={() => warmTurnChanges(turn)}
          previewEnabled={surfaceActive && checkpoints}
        />
      )}

      {/* Turn-end action on its OWN row below the footer, only for the
        recoverable stops on the last turn. */}
      {continueReason && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onContinue?.(continueReason)}
            className="border-border3 text-fg1 hover:bg-bg2-hover flex h-[22px] items-center gap-1.5 rounded-sm border bg-transparent px-2 text-xs font-medium transition-colors"
          >
            <Play className="size-3" strokeWidth={2} />
            Continue
          </button>
          <span className="text-muted-fg text-2xxs leading-snug">
            {continueReason === "max_tokens"
              ? "Resumes in the same session — full context is kept, so the answer picks up where the token cap cut it off."
              : "Starts a fresh turn under a new budget cap — work already done is kept."}
          </span>
        </div>
      )}

      {!readOnly && confirmOpen && (
        <Dialog open onOpenChange={(o) => !o && setConfirmOpen(false)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Reset to this point?</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <DialogDescription>
                This rolls back this turn and every later turn in this chat —
                the conversation is truncated here, and recorded file changes
                from those turns are unwound from each turn’s own checkpoint.
              </DialogDescription>
              {files.length > 0 && !hasSnapshot && (
                <p className="text-yellow-primary text-xs">
                  This turn’s file checkpoint is no longer available, so its
                  file changes will be left untouched.
                </p>
              )}
              <p className="text-fg2 text-xs">
                Concurrent edits are preserved when possible; overlapping edits
                are left untouched. You can undo the reset afterward.
              </p>
            </DialogBody>
            <DialogFooter>
              <Button
                variant="secondary"
                size="sm"
                autoFocus
                onClick={() => setConfirmOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={runReset}
                disabled={resetting}
              >
                Reset
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
});
