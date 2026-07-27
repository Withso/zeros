// ──────────────────────────────────────────────────────────
// TurnFooter — the footer below a settled turn's answer
// ──────────────────────────────────────────────────────────
//
// v13 (2026-06-24). Every completed turn ends with: how long the agent ran, a
// copy-output button, a "…" menu (Reset to this point), and a row of file-change
// pills for the files THIS turn's agent authored (edit/write/delete tool calls —
// concurrency-safe attribution, not a whole-tree diff). A "+N more" pill reveals
// 10 at a time. Clicking a pill opens that file in the row-1 viewer scoped to
// this turn's diff. While the turn is still streaming we show just a ticking
// timer (the working group already hosts the shimmer).
//
// Files + authoritative duration come from the engine's recorded turn row
// (native/turns.turnGet); duration falls back to the message timestamps when a
// turn predates recording or the chat isn't a git repo.
// ──────────────────────────────────────────────────────────

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Copy,
  Check,
  CircleDollarSign,
  LogIn,
  MoreHorizontal,
  Play,
  RotateCcw,
} from "lucide-react";

import { cn } from "@/zeros/ui/cn";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  ZerosSpinner,
} from "@/zeros/ui/primitives";
import { toast } from "@/zeros/ui/primitives/elements";
import { useOpenFileInRow1 } from "@/shell/use-open-file-in-row1";
import {
  turnGet,
  turnReset,
  turnUndoReset,
  type TurnInfo,
  type TurnUsageInfo,
} from "@/native/turns";
import { FileTypeIcon } from "./composer-editor/file-type-icon";
import { formatElapsed } from "@/loaders";
import { partitionTurn } from "./turn-partition";
import { useSessionsStore } from "./sessions-store";
import { useAgentSessions } from "./sessions-hooks";
import { formatTokens } from "./context-gauge";
import { displayNameForModelValue } from "./model-catalog";
import type { AgentMessage } from "./use-agent-session";

const PILL_PAGE = 10;

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

// §3.6 R5 — named endings. Text-only pills, no severity dot (user spec
// 2026-07-13): every terminal state reads in one glance from the label alone.
// budget_exhausted is deliberately ABSENT — its "Turn stopped · BUDGET" tool
// call sits right above the footer and already names the ending.
const STOP_REASON_LABELS: Record<string, string> = {
  max_tokens: "TOKEN LIMIT — ANSWER TRUNCATED",
  blocking_limit: "BLOCKED BY USAGE LIMIT",
  prompt_too_long: "PROMPT TOO LONG",
};

/** §3.6 R5/R3 — the recoverable endings that get a one-click Continue on
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
): string | null {
  if (isInterruptedTurn(turn, fallbackStopReason)) return "STOPPED BY USER";
  // §3.6 R5 — a named stop reason beats the generic failure labels: these
  // turns SETTLED (with a named cause), they didn't fail.
  const named =
    STOP_REASON_LABELS[turn?.stopReason ?? ""] ??
    STOP_REASON_LABELS[fallbackStopReason ?? ""];
  if (named) return named;
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

/** Disk-authoritative file pills. A missing row or an authoritative empty row
 *  both render no files; raw tool previews are intentionally not an input. */
export function turnFooterFiles(
  turn: Pick<TurnInfo, "files"> | null,
): TurnInfo["files"] {
  return turn?.files ?? [];
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// ── §3.6 R6 — per-turn usage helpers ─────────────────────

/** True when the recorded turn carries anything worth itemizing — the
 *  circle-dollar button renders only then (Cursor reports no usage, so the
 *  button simply never appears there, same rule as the context gauge). */
function hasTurnUsage(usage: TurnUsageInfo | null | undefined): boolean {
  if (!usage) return false;
  return (
    (usage.totalCostUsd ?? 0) > 0 ||
    (usage.inputTokens ?? 0) > 0 ||
    (usage.outputTokens ?? 0) > 0 ||
    (usage.perModel?.length ?? 0) > 0
  );
}

function formatUsd(v: number): string {
  return v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

/** One popover row's numbers: prompt-side total (incl. cache), output, cost. */
function usageLineParts(u: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}): string {
  const promptIn =
    (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  const parts = [
    `${formatTokens(promptIn)} in`,
    `${formatTokens(u.outputTokens ?? 0)} out`,
  ];
  if (typeof u.costUsd === "number" && u.costUsd > 0)
    parts.push(formatUsd(u.costUsd));
  return parts.join(" · ");
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

const ICON_BTN =
  "flex size-5 shrink-0 items-center justify-center rounded-sm text-fg2 transition-colors hover:bg-bg2-hover hover:text-fg1";
// Matches the tool-call FileTag recipe (renderers/file-tag.tsx) so a footer
// pill reads identically to the Edit/Read row pill: 20px tall, 4px radius,
// bg --bg1, border --border3, hover --bg2-hover (unified pill recipe,
// 2026-07-05 per user). The ±counts render INSIDE the pill.
const PILL =
  "flex h-5 min-w-0 items-center gap-1.5 rounded-sm border border-border3 bg-bg1 px-1.5 text-fg2 transition-colors hover:bg-bg2-hover hover:text-fg1";

interface TurnFooterProps {
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
  /** True while an auto-rebuild is re-running this chat's last turn — hides
   *  the "AGENT STOPPED" pill for a failed row that's about to be retried. */
  retrying?: boolean;
  /** §3.6 R5/R3 — Continue renders only on the chat's LAST settled turn (a
   *  mid-history Continue would fork the conversation). */
  isLastTurn?: boolean;
  /** §3.6 R5/R3 — one-click resume after a recoverable stop: sends "Continue"
   *  to the same session (full context kept). Provided by the chat shell. */
  onContinue?: (reason: "max_tokens" | "budget_exhausted") => void;
  /** Background CLI sign-in (Claude/Codex auth-required failures only). When
   *  provided alongside the SIGN IN REQUIRED status, the static pill becomes
   *  a clickable "Sign in" button that drives the CLI login headlessly and
   *  redirects to the browser. Null/undefined = keep the plain pill. */
  signInPhase?: "idle" | "starting" | "waiting" | "success" | "error" | null;
  onSignIn?: () => void;
}

export const TurnFooter = memo(function TurnFooter({
  chatId,
  turnId,
  events,
  startedAt,
  live,
  fallbackStopReason,
  fallbackStatusLabel,
  retrying,
  isLastTurn,
  onContinue,
  signInPhase,
  onSignIn,
}: TurnFooterProps) {
  const openInRow1 = useOpenFileInRow1();
  // Stable actions context — identity doesn't change on store mutations, so
  // reading it here doesn't defeat this component's memo. Used to cancel an
  // in-flight turn before a reset spans it.
  const sessions = useAgentSessions();
  const [turn, setTurn] = useState<TurnInfo | null>(null);
  const [visible, setVisible] = useState(PILL_PAGE);
  const [copied, setCopied] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Once settled, fetch the recorded turn (authored files + real duration).
  useEffect(() => {
    if (live || !turnId) return;
    let cancelled = false;
    void turnGet(chatId, turnId)
      .then((t) => {
        if (!cancelled) setTurn(t);
      })
      .catch(() => {
        // Bridge briefly absent / op failed — keep the placeholder footer.
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, turnId, live]);

  // The agent's concluding answer text (what the copy button copies).
  const outputText = useMemo(() => {
    const { finalOutput } = partitionTurn(events);
    return finalOutput
      .map((m) => (m.kind === "text" ? m.text : ""))
      .join("\n\n")
      .trim();
  }, [events]);

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

  // Undo a reset by its id: restores the files AND re-inserts the truncated
  // conversation (messages, tool calls, outputs). When the transcript comes
  // back, re-window the chat so it renders here immediately.
  const doUndo = useCallback(
    async (resetId: string) => {
      try {
        const res = await turnUndoReset({ resetId });
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
    if (resetting) return;
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
  }, [chatId, turnId, resetting, doUndo, sessions]);

  // While the turn is still streaming, render nothing: the working group's
  // ActivityShimmer already shows the live elapsed timer (grey, text-fg2) at the
  // tail. A second timer here was a duplicate — and a BLUE one (LiveDuration's
  // default text-blue-primary) sitting right under the grey shimmer one (user report).
  // The footer appears once the turn settles.
  if (live) return null;

  const durationMs =
    turn?.endedAt != null && turn?.startedAt != null
      ? Math.max(0, turn.endedAt - turn.startedAt)
      : Math.max(0, lastEventTime(events) - startedAt);
  // File pills are deliberately disk-authoritative. A rendered tool call is a
  // proposal, not proof that anything landed (permission may be denied, a tool
  // may fail, or an edit may be a no-op). Only the engine's persisted
  // pre/post-snapshot diff may produce a pill. If that record is unavailable we
  // prefer no pill over a convincing but false one.
  const files = turnFooterFiles(turn);
  const shown = files.slice(0, visible);
  const remaining = files.length - shown.length;
  // Whether this selected turn's own files have a retained checkpoint. Later
  // turns are evaluated independently by the reset service; this only controls
  // the selected-turn warning in the confirmation dialog.
  const hasSnapshot = turn?.preSnapshot != null;
  const statusLabel = turnFooterStatusLabel(
    turn,
    fallbackStopReason,
    fallbackStatusLabel,
    retrying,
  );
  // §3.6 R5/R3 — the below-footer Continue row (last turn only).
  const continueReason =
    isLastTurn && onContinue
      ? continuableStopReason(turn, fallbackStopReason)
      : null;
  // §3.6 R6 — the itemized bill behind the circle-dollar button.
  const usage = turn?.usage ?? null;
  const showUsage = hasTurnUsage(usage);
  // Per-model rows only when the agent itemized (Claude modelUsage). An
  // agent that bills as one lump (Codex) gets just the Total line.
  const usageRows = (usage?.perModel ?? []).map((m) => ({
    name: displayNameForModelValue(turn?.agentId ?? null, m.model),
    line: usageLineParts(m),
  }));
  const usageTotalLine = usage
    ? usageLineParts({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        costUsd: usage.totalCostUsd,
      })
    : "";

  return (
    <>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
        {statusLabel &&
          (statusLabel === "SIGN IN REQUIRED" && onSignIn && signInPhase ? (
            // Clickable variant of the status pill (same chrome + hover) —
            // one click drives the CLI login headlessly and opens the
            // browser (background-signin.ts). Busy while the browser
            // round-trip is in flight; "Signed in" flashes on success
            // before the session rebuild clears the failure.
            <div className="basis-full">
              <Button
                type="button"
                onClick={onSignIn}
                disabled={
                  signInPhase === "starting" ||
                  signInPhase === "waiting" ||
                  signInPhase === "success"
                }
                variant="secondary"
                size="sm"
              >
                {signInPhase === "starting" || signInPhase === "waiting" ? (
                  <>
                    <ZerosSpinner size={16} />
                    {signInPhase === "waiting"
                      ? "Waiting for browser sign-in…"
                      : "Signing in…"}
                  </>
                ) : signInPhase === "success" ? (
                  <>
                    <Check className="size-3" strokeWidth={2} aria-hidden="true" />
                    Signed in
                  </>
                ) : (
                  <>
                    <LogIn className="size-3" strokeWidth={2} aria-hidden="true" />
                    Sign in
                  </>
                )}
              </Button>
            </div>
          ) : (
            <div className="basis-full">
              <span className="border-border3 bg-bg1 text-fg1 inline-flex w-fit rounded-sm border px-2 py-0.5 text-xs tracking-wide">
                {statusLabel}
              </span>
            </div>
          ))}
        <Tooltip label="Agent run time">
          <span className="text-fg2 tabular-nums">
            {formatElapsed(durationMs)}
          </span>
        </Tooltip>
        {showUsage && (
          <Popover>
            <Tooltip label="Turn usage">
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Turn usage"
                  className={ICON_BTN}
                >
                  <CircleDollarSign className="size-3.5" strokeWidth={2} />
                </button>
              </PopoverTrigger>
            </Tooltip>
            {/* Opens ABOVE the icon (user spec 2026-07-13); Radix collision
              detection flips it below only when there's no room above. */}
            <PopoverContent side="top" align="start" className="w-72 p-3.5">
              <div className="flex items-baseline justify-between pb-2">
                <span className="text-fg1 text-xs font-semibold">
                  Turn usage
                </span>
                {typeof usage?.totalCostUsd === "number" &&
                  usage.totalCostUsd > 0 && (
                    <span className="text-fg2 font-mono text-2xxs">
                      {formatUsd(usage.totalCostUsd)}
                    </span>
                  )}
              </div>
              {usageRows.map((r) => (
                <div
                  key={r.name}
                  className="flex items-baseline justify-between gap-2.5 py-1"
                >
                  <span className="text-fg2 min-w-0 truncate text-[12.5px]">
                    {r.name}
                  </span>
                  <span className="text-fg2 font-mono text-2xxs whitespace-nowrap tabular-nums">
                    {r.line}
                  </span>
                </div>
              ))}
              <div
                className={cn(
                  "flex items-baseline justify-between gap-2.5 py-1",
                  usageRows.length > 0 && "border-border2 mt-1.5 border-t pt-2",
                )}
              >
                <span className="text-fg1 text-[12.5px]">Total</span>
                <span className="text-fg1 font-mono text-2xxs whitespace-nowrap tabular-nums">
                  {usageTotalLine}
                </span>
              </div>
              <div className="border-border2 mt-2 border-t pt-2">
                <button
                  type="button"
                  onClick={() => {
                    const lines = [
                      "| Model | Usage |",
                      "| --- | --- |",
                      ...usageRows.map((r) => `| ${r.name} | ${r.line} |`),
                      `| Total | ${usageTotalLine} |`,
                    ];
                    void navigator.clipboard
                      .writeText(lines.join("\n"))
                      .catch(() => {});
                  }}
                  className="hover:bg-bg3-hover text-fg2 w-full rounded-sm px-1.5 py-1 text-left text-xs font-medium"
                >
                  Copy breakdown
                </button>
              </div>
            </PopoverContent>
          </Popover>
        )}
        <Tooltip label={copied ? "Copied" : "Copy output"}>
          <button
            type="button"
            onClick={onCopy}
            disabled={!outputText}
            aria-label={copied ? "Copied" : "Copy output"}
            className={cn(ICON_BTN, !outputText && "cursor-default")}
          >
            {copied ? (
              <Check className="size-3.5" strokeWidth={2} />
            ) : (
              <Copy className="size-3.5" strokeWidth={2} />
            )}
          </button>
        </Tooltip>
        <DropdownMenu>
          <Tooltip label="Turn actions">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Turn actions"
                className={ICON_BTN}
              >
                <MoreHorizontal className="size-4" strokeWidth={2} />
              </button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-52">
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
          </DropdownMenuContent>
        </DropdownMenu>

        {shown.map((f) => (
          <Tooltip key={f.path} label={f.path}>
            <button
              type="button"
              onClick={() =>
                openInRow1(f.path, {
                  diff: true,
                  diffScope: "turn",
                  turnChatId: chatId,
                  turnId,
                })
              }
              className={PILL}
            >
              <FileTypeIcon name={f.path} size={13} className="shrink-0" />
              <span className="max-w-40 truncate">{baseName(f.path)}</span>
              {/* Both halves render whenever the file changed at all — "+5 −0",
                not a lone "+5" — mirroring the edit rows' badge exactly, so the
                footer pill and the tool rows above it read the same
                (2026-07-05, per user). 0/0 still shows nothing (renames). */}
              {(f.additions > 0 || f.deletions > 0) && (
                <span className="shrink-0 tabular-nums">
                  <span className="text-green-primary">+{f.additions}</span>
                  <span className="text-red-primary ml-1">−{f.deletions}</span>
                </span>
              )}
            </button>
          </Tooltip>
        ))}
        {remaining > 0 && (
          <button
            type="button"
            onClick={() => setVisible((v) => v + PILL_PAGE)}
            className={PILL}
          >
            +{remaining} more
          </button>
        )}
      </div>

      {/* §3.6 R5/R3 — turn-end action on its OWN row below the footer (user
        spec 2026-07-13), only for the recoverable stops on the last turn. */}
      {continueReason && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onContinue?.(continueReason)}
            className="border-border3 bg-transparent text-fg1 hover:bg-bg2-hover flex h-[22px] items-center gap-1.5 rounded-sm border px-2 text-xs font-medium transition-colors"
          >
            <Play className="size-3" strokeWidth={2} />
            Continue
          </button>
          <span className="text-fg3 text-2xxs leading-snug">
            {continueReason === "max_tokens"
              ? "Resumes in the same session — full context is kept, so the answer picks up where the token cap cut it off."
              : "Starts a fresh turn under a new budget cap — work already done is kept."}
          </span>
        </div>
      )}

      {confirmOpen && (
        <Dialog open onOpenChange={(o) => !o && setConfirmOpen(false)}>
          <DialogContent showCloseButton={false} className="max-w-md">
            <DialogHeader>
              <DialogTitle>Reset to this point?</DialogTitle>
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
            </DialogHeader>
            <DialogFooter className="mt-2 gap-2">
              <Button
                variant="secondary"
                size="sm"
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
