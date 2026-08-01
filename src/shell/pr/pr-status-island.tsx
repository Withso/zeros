// ──────────────────────────────────────────────────────────
// PrStatusIsland — shared Changes/Review PR row: status + one-tap actions
// ──────────────────────────────────────────────────────────
//
// A status bar rendered above the retained Changes/Review bodies whenever the
// active workspace has a PR (else that row holds the Create PR button; see
// Column3 → PrStatusRow). It shows a single
// derived state — "View PR ↗ Draft PR open", "Ready to merge", "Merged", … —
// with the button that resolves it.
//
// Data: exact net change counts + gitStatus (local conflicts / ahead-behind) +
// ghPrGet (GitHub mergeable state) + ghPrChecks (CI). Local changes re-fetch on
// the shared useGitRefreshKey signal; external github.com changes refresh on
// app resume and a bounded active-only poll. Once the effective PR state is
// TERMINAL (merged/closed) every recurring lane goes quiet — only the
// activation fetch re-checks, so a reopened PR still recovers (see
// shouldPollPrStatus in pr-status-refresh.ts).
//
// Two rules keep the status row from lying (2026-07-16):
//   • ATOMIC applies — the three sources resolve at very different speeds
//     (local git in ms, gh over the network), so results are applied as ONE
//     settled batch. Applying them as they land renders mixed-generation
//     states — e.g. fresh "ahead 2" over a stale pr → a wrong "Ahead by 2"
//     flash that resolves to "Ready to merge" a second later.
//   • LAST-KNOWN cache — leaving the Changes/Review pair or switching workspace
//     unmounts the row, so without it returning remounted the island empty and flashed
//     the "PR open" placeholder before the refetch landed. The cache re-renders
//     the last-known status instantly and updates in place. The last RENDERED
//     state is additionally persisted per workspace#pr (pr-island-last-state,
//     2026-07-21) so an app relaunch / dev reload resumes from it too — the
//     refetch still runs, in the background, and repaints only on an actual
//     status change. "Loading..." (plain text, no spinner — 2026-07-19 spec)
//     appears only for a PR with no derivation history on this machine.
//
// Actions (2026-07-19 split):
//   • prompt  — Resolve / Commit & Push / Update branch send a brief to the
//     active chat as an AUTO-SENT message (short label + icon bubble; the
//     agent receives the full text).
//   • direct  — Push / Pull / Ready-for-review / Merge / Continue / Archive
//     act in the engine: the button dims with an inline spinner where its icon
//     was, and the derived state flips optimistically the moment the op lands
//     (the refresh-key refetch then confirms) — no intermediate loading state.
//   • nav     — Show checks focuses the Review tab's Checks sub-tab; the
//     View PR chip focuses the Review tab.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive as ArchiveIcon,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  GitMergeConflict,
  GitPullRequestArrow,
  GitPullRequestClosed,
  ListChecks,
  Play,
} from "lucide-react";

import { cn } from "../../zeros/ui/cn";
import { CommitPushIcon } from "../../zeros/agent/auto-action";
import { Tooltip } from "@/zeros/ui/primitives";
import { toast } from "../../zeros/ui/primitives/elements";
import {
  ghPrChecks,
  ghPrGet,
  ghPrMarkReady,
  ghPrMerge,
  ghPrSync,
  gitErrorDescription,
  gitPull,
  gitPush,
  workspaceContinueOnNewBranch,
  type PR,
  type ChangeCounts,
  type PrChecksResult,
  type StatusResult,
  type Workspace,
} from "../../native/git";
import {
  changeCountsForGeneration,
  statusForGeneration,
} from "../column3-tabs/changes-tab";
import { notifyWorkspacesChanged } from "../../zeros/store/use-projects";
import { useArchiveWorkspace } from "../../zeros/store/archive-actions";
import { useGitRefreshKey } from "../use-git-refresh-key";
import { useShowReviewTab } from "./use-open-review-tab";
import {
  claimPrIslandAction,
  derivePrIslandState,
  isActionGatedWhileAgentWorking,
  releasePrIslandAction,
  type PrIslandAction,
  type PrIslandActionKind,
  type PrIslandState,
  type PrIslandTone,
} from "./pr-status";
import { buildActionPrompt, promptActionBubble } from "./pr-action-prompts";
import {
  clearPrIslandStability,
  stabilizePrIslandState,
} from "./pr-status-stability";
import {
  getPrIslandLastState,
  rememberPrIslandLastState,
} from "./pr-island-last-state";
import { publishPrIslandKind } from "./pr-island-state-store";
import { useGitRemote } from "../../zeros/settings/use-git-remote";
import { useSendToActiveChat } from "./use-send-to-active-chat";
import {
  AGENT_WORKING_REASON,
  useWorkspaceAgentWorking,
} from "./use-agent-working";
import { ZerosSpinner } from "@/loaders";
import {
  classifyPrStatusEffectTrigger,
  effectivePrPollState,
  isTerminalPrState,
  PR_STATUS_FULL_POLL_MS,
  shouldPollPrStatus,
  shouldReconcileWorkspacePrState,
  shouldRefreshPrStatusOnResume,
} from "./pr-status-refresh";
import { optimisticPushGeneration } from "./pr-status-optimistic";
import { registerPrWorkspaceCacheForget } from "./pr-cache-forget";

interface PrStatusIslandProps {
  workspace: Workspace;
  active: boolean;
  /** Direct host-only lifecycle actions are absent in browser/relay sessions. */
  localDesktop: boolean;
}

// tone → row surface + bottom hairline (2026-07-19 design: every open-PR
// state shares the brown identity; green/violet/red mark the terminal states).
// The surface + action treatments resolve per theme via the --pr-status-*
// semantic tokens (styles/semantic-tokens.css). neutral/warning/danger are one
// visual bucket — defined once so the shared treatment can't drift per key.
const OPEN_CARD = "bg-[var(--pr-status-surface)] border-brown-primary/10";
const OPEN_CHIP =
  "border-[var(--pr-status-chip-border-active)] text-brown-primary hover:text-brown-fg";
const CARD_TONE: Record<PrIslandTone, string> = {
  neutral: OPEN_CARD,
  warning: OPEN_CARD,
  danger: OPEN_CARD,
  success: "bg-green-bg border-green-primary/10",
  merged: "bg-violet-bg border-violet-primary/10",
  closed: "bg-red-bg border-red-primary/10",
};
const LABEL_TONE: Record<PrIslandTone, string> = {
  neutral: "text-fg1",
  warning: "text-fg1",
  danger: "text-fg1",
  success: "text-green-primary",
  merged: "text-violet-fg",
  closed: "text-red-fg",
};
// "View PR ↗" chip — a quiet per-tone outline (muted ramp shades via the
// --pr-status-chip-border-* semantics), constant across every state.
const CHIP_BASE =
  "inline-flex shrink-0 items-center gap-0.5 rounded-sm border px-1.5 py-0.5 text-[13px] tabular-nums transition-colors duration-120 ease-out";
const CHIP_TONE: Record<PrIslandTone, string> = {
  neutral: OPEN_CHIP,
  warning: OPEN_CHIP,
  danger: OPEN_CHIP,
  success:
    "border-[var(--pr-status-chip-border-success)] text-green-primary hover:text-green-fg",
  merged:
    "border-[var(--pr-status-chip-border-merged)] text-violet-fg hover:text-violet-primary",
  closed:
    "border-[var(--pr-status-chip-border-closed)] text-red-fg hover:text-red-primary",
};

const ACTION_ICON: Partial<
  Record<
    PrIslandActionKind,
    React.ComponentType<{ className?: string; strokeWidth?: number | string }>
  >
> = {
  resolve: GitMergeConflict,
  "commit-and-push": CommitPushIcon,
  push: ArrowUp,
  pull: ArrowDown,
  "update-from-base": ArrowDown,
  "ready-for-review": GitPullRequestArrow,
  merge: GitPullRequestArrow,
  archive: ArchiveIcon,
  continue: Play,
  "show-checks": ListChecks,
};

// `enabled:` hovers (not `disabled:pointer-events-none`): a disabled button
// must still receive pointer events so its Tooltip can explain WHY it's
// disabled (e.g. the agent-working gate); the `disabled` attribute alone
// already blocks clicks. `disabled:opacity-50` doubles as the in-flight dim.
const BTN_BASE =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium transition-colors duration-120 ease-out disabled:opacity-50";

/** Per-variant button chrome, tone-aware (the 2026-07-19 design):
 *  open-PR secondary buttons are the FILLED theme-adaptive action button
 *  (white in Shade, mauve in Light — --pr-status-action-*), Merge is the
 *  green fill, Continue the violet fill, Archive the white primary. */
function actionButtonClass(action: PrIslandAction, tone: PrIslandTone): string {
  if (action.variant === "primary") {
    if (action.kind === "merge") {
      return "bg-green-primary text-[var(--pr-status-merge-fg)] enabled:hover:opacity-90";
    }
    // Archive. On the Light closed row the dark inverted fill reads harsh on
    // the salmon surface — flip to a white bordered button (catalog E3).
    return cn(
      "bg-primary-button-bg text-primary-button-fg enabled:hover:bg-primary-button-hover",
      tone === "closed" &&
        "[[data-theme=light]_&]:border [[data-theme=light]_&]:border-border3 [[data-theme=light]_&]:bg-bg1 [[data-theme=light]_&]:text-fg1 [[data-theme=light]_&]:enabled:hover:bg-bg1-hover",
    );
  }
  if (action.variant === "dashed") {
    // Merged-row Continue — filled violet, theme-adaptive label.
    return "bg-[var(--pr-status-continue-bg)] text-[var(--pr-status-continue-fg)] enabled:hover:opacity-90";
  }
  // Secondary. On the brown open-PR rows this is the filled theme-adaptive
  // action button; elsewhere it stays a quiet outline.
  if (tone === "neutral" || tone === "warning" || tone === "danger") {
    return "bg-[var(--pr-status-action-bg)] text-[var(--pr-status-action-fg)] enabled:hover:bg-[var(--pr-status-action-hover)]";
  }
  return "border border-border3 bg-transparent text-fg1 enabled:hover:bg-bg2";
}

/** EMPTY_PR (number 0) means "no live GitHub data yet" — treat as absent so the
 *  state machine falls back to the persisted prState instead of a bogus draft. */
function livePr(pr: PR | null): PR | null {
  return pr && pr.number > 0 ? pr : null;
}

/** One settled fetch round's worth of island inputs, applied atomically. */
interface IslandData {
  status: StatusResult | null;
  counts: ChangeCounts | null;
  pr: PR | null;
  checks: PrChecksResult | null;
  /** Refresh generation + completion time of the round that produced this
   *  batch — lets a remount skip refetching data that is still fresh. */
  refreshKey: number;
  at: number;
}

/** Last settled data per `workspaceId#prNumber` — survives the island's
 *  unmount/remount cycle (inactive row-1 tabs unmount) so a tab switch
 *  re-renders the last-known status instantly instead of a loading flash.
 *  Bounded by the number of live workspaces with PRs. */
const lastKnownData = new Map<string, IslandData>();
const MAX_PR_ISLAND_SNAPSHOTS = 64;

function rememberIslandData(key: string, data: IslandData): void {
  lastKnownData.delete(key);
  lastKnownData.set(key, data);
  while (lastKnownData.size > MAX_PR_ISLAND_SNAPSHOTS) {
    const oldest = lastKnownData.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    lastKnownData.delete(oldest);
  }
}

// Deletion purge (pr-cache-forget): a permanently deleted workspace can never
// render this island again — drop its settled batches. Archive intentionally
// keeps them: restore reuses the id, and the retained batch is what repaints
// the restored island instantly. The `#` in the prefix guards against one
// workspace id being a prefix of another.
registerPrWorkspaceCacheForget((workspaceId) => {
  const prefix = `${workspaceId}#`;
  for (const key of lastKnownData.keys()) {
    if (key.startsWith(prefix)) lastKnownData.delete(key);
  }
});

/** How long a settled batch satisfies a remount on the SAME refresh
 *  generation. Navigation (workspace hops, Changes↔Review) inside this window
 *  renders the cached batch with zero GitHub calls; an actual git/DB change
 *  bumps the refresh key and always refetches. Matches the Review store's
 *  full-poll cadence. */
const ISLAND_FRESH_MS = PR_STATUS_FULL_POLL_MS;

export function PrStatusIsland({
  workspace,
  active,
  localDesktop,
}: PrStatusIslandProps) {
  const prNumber = workspace.prNumber;
  const sendToChat = useSendToActiveChat();
  // The repo's configured push/PR remote — action prompts must name the same
  // remote the engine's own git ops use.
  const remote = useGitRemote(workspace.repoRoot);
  const refreshKey = useGitRefreshKey(workspace.path, workspace.id);
  // Focus row 1's pinned Review tab — shared by the View-PR chip and the
  // Show-checks action (which lands directly on its Checks sub-tab).
  const showPr = useShowReviewTab();

  const dataKey = `${workspace.id}#${prNumber ?? "none"}`;
  // Live state carries its key so a prNumber change can never render another
  // PR's stale batch; until this key's fetch lands we fall back to the module
  // cache (instant on remount) and only then to the loading row.
  const [live, setLive] = useState<{ key: string; data: IslandData } | null>(
    null,
  );
  // Timestamp, not a boolean: after the forced round settles, later local
  // refresh generations can use the normal freshness check again.
  const [forceRefreshAt, setForceRefreshAt] = useState(0);
  const lastRequestAtRef = useRef(0);
  // The dataKey active on the previous effect run. Hidden retained surfaces
  // clear it, so every false→true reveal is an activation even though their
  // semantic dataKey and component instance remain unchanged.
  const activationKeyRef = useRef<string | null>(null);
  const data =
    live && live.key === dataKey
      ? live.data
      : (lastKnownData.get(dataKey) ?? null);
  // Stability is scoped to the exact GitHub head/base generation. A push from
  // another client must never inherit the preceding head's ready state.
  const stabilityKey = data?.pr
    ? `${dataKey}@${data.pr.baseBranch}:${data.pr.headSha ?? "unknown"}`
    : `${dataKey}@unconfirmed`;
  // Which action is running (direct engine ops). The running button swaps its
  // icon for a spinner and every button disables (the disabled dim doubles as
  // the "in flight" affordance).
  const [acting, setActing] = useState<PrIslandActionKind | null>(null);
  const actionClaimRef = useRef<PrIslandActionKind | null>(null);
  const claimAction = useCallback((kind: PrIslandActionKind): boolean => {
    if (!claimPrIslandAction(actionClaimRef, kind)) return false;
    setActing(kind);
    return true;
  }, []);
  const finishAction = useCallback((kind: PrIslandActionKind): void => {
    releasePrIslandAction(actionClaimRef, kind);
    setActing((current) => (current === kind ? null : current));
  }, []);
  const archiveWorkspace = useArchiveWorkspace();
  // Park git-mutating actions while an agent turn is in flight (see
  // isActionGatedWhileAgentWorking for the policy).
  const agentWorking = useWorkspaceAgentWorking(workspace);

  // Fetch local + GitHub state whenever the workspace, PR, refresh signal, or
  // active external-refresh boundary changes. Local reads are coalesced with
  // the Changes surfaces for the same generation. The four results are applied
  // as ONE settled batch (see header) — a failed
  // source keeps its last-known value rather than blanking the row.
  //
  // A remount on an unchanged refresh generation (workspace hop, Changes↔
  // Review switch) whose batch is still fresh renders the cache and fetches
  // nothing — pure navigation must not burn GitHub calls. A TERMINAL
  // (merged/closed) batch is additionally fresh across refresh generations
  // and suppresses refresh-key refetches entirely; see the two guards below.
  useEffect(() => {
    const effectTrigger = classifyPrStatusEffectTrigger(
      activationKeyRef.current,
      active && prNumber != null,
      dataKey,
    );
    activationKeyRef.current = effectTrigger.activeDataKey;
    if (!effectTrigger.trigger || prNumber == null) return;
    const prev = lastKnownData.get(dataKey);
    const prevEffectiveState = prev
      ? effectivePrPollState(livePr(prev.pr), workspace.prState)
      : null;
    // Freshness: a terminal (merged/closed) batch stays valid across refresh
    // generations — the suppression below deliberately lets its refreshKey
    // drift behind local git activity, and requiring an exact match here would
    // turn every tab re-activation into a refetch the batch doesn't need.
    if (
      prev &&
      (prev.refreshKey === refreshKey ||
        isTerminalPrState(prevEffectiveState)) &&
      Date.now() - prev.at < ISLAND_FRESH_MS &&
      forceRefreshAt <= prev.at
    ) {
      return;
    }
    // Terminal PRs don't change from local git activity, so a refresh-key
    // bump (agent turn-end, engine git write) skips the whole round — this is
    // what let a merged PR be re-fetched every few seconds forever. The
    // activation fetch and an explicit force (forceRefreshAt advanced past
    // this batch) still go through, so a PR reopened on GitHub recovers on
    // the next tab activation / forced boundary. The gate is re-derived from
    // the CURRENT batch + persisted row on every run — a re-evaluable
    // suppression, never a latch.
    if (
      prev &&
      forceRefreshAt <= prev.at &&
      !shouldPollPrStatus(prevEffectiveState, effectTrigger.trigger)
    ) {
      return;
    }
    lastRequestAtRef.current = Date.now();
    let cancelled = false;
    void Promise.allSettled([
      statusForGeneration(workspace.id, refreshKey),
      changeCountsForGeneration(workspace.id, refreshKey),
      ghPrGet({ workspaceId: workspace.id, prNumber }),
      ghPrChecks({ workspaceId: workspace.id, prNumber }),
    ]).then(([s, n, p, c]) => {
      if (cancelled) return;
      const prev = lastKnownData.get(dataKey);
      const next: IslandData = {
        status: s.status === "fulfilled" ? s.value : (prev?.status ?? null),
        counts: n.status === "fulfilled" ? n.value : (prev?.counts ?? null),
        pr: p.status === "fulfilled" ? p.value : (prev?.pr ?? null),
        checks: c.status === "fulfilled" ? c.value : (prev?.checks ?? null),
        refreshKey,
        at: Date.now(),
      };
      rememberIslandData(dataKey, next);
      setLive({ key: dataKey, data: next });
      if (
        p.status === "fulfilled" &&
        shouldReconcileWorkspacePrState(workspace.prState, p.value.state)
      ) {
        // ghPrGet supplies detailed mergeability for this row; ghPrSync is the
        // durable/cross-device reconciliation path for an external draft,
        // ready, closed, or merged transition. It broadcasts only as a write
        // op, and the native façade coalesces concurrent Review/island probes.
        void ghPrSync(workspace.id)
          .then((synced) => {
            if (synced) notifyWorkspacesChanged(workspace.repoSlug);
          })
          .catch(() => {});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    workspace.id,
    workspace.prState,
    workspace.repoSlug,
    prNumber,
    dataKey,
    refreshKey,
    forceRefreshAt,
  ]);

  // External GitHub changes do not touch this machine's file watcher. Catch
  // them when the user returns to Zeros and with a slow poll while this exact
  // row is visible. Hidden retained tabs stay completely inert. Terminal
  // (merged/closed) PRs mute BOTH lanes: GitHub can't change them behind our
  // back except by an explicit reopen, so re-probing every minute + every
  // focus forever only burns the API budget. The gate reads the CURRENT batch
  // on each event (never latched); a reopen recovers via the activation fetch,
  // whose settled batch then lifts this gate too.
  useEffect(() => {
    if (!active || prNumber == null) return;
    const requestExternalRefresh = (trigger: "interval" | "resume") => {
      if (document.visibilityState !== "visible") return;
      const batch = lastKnownData.get(dataKey);
      if (
        !shouldPollPrStatus(
          effectivePrPollState(livePr(batch?.pr ?? null), workspace.prState),
          trigger,
        )
      ) {
        return;
      }
      const now = Date.now();
      const latestActivity = Math.max(batch?.at ?? 0, lastRequestAtRef.current);
      if (!shouldRefreshPrStatusOnResume(latestActivity, now)) return;
      // Claim this boundary synchronously so visibilitychange + focus coalesce.
      lastRequestAtRef.current = now;
      setForceRefreshAt(now);
    };
    const timer = window.setInterval(
      () => requestExternalRefresh("interval"),
      PR_STATUS_FULL_POLL_MS,
    );
    const onResume = () => requestExternalRefresh("resume");
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, [active, dataKey, prNumber, workspace.prState]);

  /** Patch the current settled batch in place (optimistic transition after a
   *  direct action lands) — the derived state flips INSTANTLY; the refresh-key
   *  refetch the engine write triggers then confirms it. */
  const applyOptimistic = useCallback(
    (mutate: (d: IslandData) => IslandData) => {
      const prev = lastKnownData.get(dataKey);
      if (!prev) return;
      const next = mutate(prev);
      rememberIslandData(dataKey, next);
      setLive({ key: dataKey, data: next });
    },
    [dataKey],
  );

  const actionErrorToast = useCallback((title: string, err: unknown) => {
    toast.error(title, { description: gitErrorDescription(err) });
  }, []);

  /** Direct engine actions (2026-07-19): push / pull / ready / merge /
   *  continue. No agent message — spinner on the button, optimistic flip. */
  const runDirect = useCallback(
    async (action: PrIslandAction) => {
      if (!claimAction(action.kind)) return;
      // The action is about to invalidate the current state on purpose — the
      // stability mask must not resurrect it over a following transient.
      clearPrIslandStability(stabilityKey);
      try {
        switch (action.behavior) {
          case "push": {
            const pushed = await gitPush({ workspaceId: workspace.id });
            applyOptimistic((d) => ({
              ...d,
              ...optimisticPushGeneration(d, pushed),
            }));
            break;
          }
          case "pull": {
            // Behind and diverged states pull with rebase + autostash, keeping
            // a racing local commit/edit safe rather than failing.
            const res = await gitPull({
              workspaceId: workspace.id,
              strategy: "rebase",
              autoStash: true,
            });
            // A conflicted rebase RESOLVES (with the conflict list) rather
            // than throwing — treating it as success would paint "up to date"
            // over a mid-rebase tree. Skip the optimistic patch; the op's
            // refresh generation re-derives the Merge-conflicts state, whose
            // Resolve button hands the cleanup to the agent.
            if (res.conflicts.length > 0) {
              toast.error("Pull hit merge conflicts", {
                description:
                  "Use Resolve to have the agent finish the merge and push.",
              });
              break;
            }
            applyOptimistic((d) => ({
              ...d,
              status: d.status ? { ...d.status, behind: 0 } : d.status,
              at: Date.now(),
            }));
            break;
          }
          case "ready": {
            if (prNumber == null) break;
            const pr = await ghPrMarkReady({
              workspaceId: workspace.id,
              prNumber,
            });
            // GitHub recomputes mergeable_state asynchronously — right after
            // the mutation it can still echo "draft", which would re-derive
            // the Draft state and make the click look ignored. Coerce that
            // lagging echo to "unknown" ("Checking mergeability…") until the
            // confirming refetch settles.
            const patched =
              pr.state !== "draft" && pr.mergeableState === "draft"
                ? { ...pr, mergeableState: "unknown" }
                : pr;
            applyOptimistic((d) => ({ ...d, pr: patched, at: Date.now() }));
            notifyWorkspacesChanged(workspace.repoSlug);
            break;
          }
          case "merge": {
            if (prNumber == null) break;
            const merged = await ghPrMerge({
              workspaceId: workspace.id,
              prNumber,
              method: "squash",
            });
            applyOptimistic((d) => ({
              ...d,
              pr: d.pr
                ? {
                    ...d.pr,
                    state: "merged",
                    mergedAt: Date.now(),
                    mergeCommitSha: merged.sha,
                  }
                : d.pr,
              at: Date.now(),
            }));
            notifyWorkspacesChanged(workspace.repoSlug);
            toast.success(`PR #${prNumber} merged`);
            break;
          }
          case "continue": {
            if (!localDesktop) break;
            // Same worktree + chats, fresh branch: the engine creates and
            // checks it out from the target generation, then clears the PR
            // fields. GitHub's merge SHA is the exact offline fallback.
            const res = await workspaceContinueOnNewBranch({
              workspaceId: workspace.id,
              baseBranch: data?.pr?.baseBranch ?? workspace.baseBranch,
              mergedSha: data?.pr?.mergeCommitSha ?? undefined,
            });
            notifyWorkspacesChanged(workspace.repoSlug);
            toast.success(`Continuing on ${res.branch}`);
            break;
          }
        }
      } catch (err) {
        const title =
          action.behavior === "merge"
            ? "Couldn't merge PR"
            : action.behavior === "push"
              ? "Couldn't push"
              : action.behavior === "pull"
                ? "Couldn't pull"
                : action.behavior === "ready"
                  ? "Couldn't mark ready for review"
                  : "Couldn't continue on a new branch";
        actionErrorToast(title, err);
      } finally {
        finishAction(action.kind);
      }
    },
    [
      claimAction,
      finishAction,
      data?.pr?.baseBranch,
      data?.pr?.mergeCommitSha,
      stabilityKey,
      localDesktop,
      workspace.id,
      workspace.baseBranch,
      workspace.repoSlug,
      prNumber,
      applyOptimistic,
      actionErrorToast,
    ],
  );

  const handleArchive = useCallback(async () => {
    if (!claimAction("archive")) return;
    try {
      // Shared: stops any running agent turn, repoints the view (archiving the
      // workspace you're viewing would otherwise strand the open chat on a
      // deleted folder), and offers Undo.
      await archiveWorkspace(workspace);
    } finally {
      finishAction("archive");
    }
  }, [claimAction, finishAction, workspace, archiveWorkspace]);

  const runAction = useCallback(
    (action: PrIslandAction) => {
      switch (action.behavior) {
        case "archive":
          void handleArchive();
          return;
        case "show-checks":
          // The action names its complete destination; publish tab + sub-tab
          // together so no intermediate Review/previous-subtab frame exists.
          showPr("checks");
          return;
        case "prompt": {
          if (!claimAction(action.kind)) return;
          const text = buildActionPrompt(action.kind, {
            baseBranch: workspace.baseBranch,
            remote,
          });
          if (!text) {
            finishAction(action.kind);
            return;
          }
          // Auto-sent treatment: the bubble shows the short label + the
          // action's icon (brown "sent by Zeros" bubble, copy-only); the
          // agent receives the full brief.
          const bubble = promptActionBubble(action.kind);
          const sent = sendToChat({
            text,
            displayText: bubble?.label,
            autoAction: bubble?.autoAction,
            onSettled: () => finishAction(action.kind),
          });
          if (!sent) finishAction(action.kind);
          return;
        }
        default:
          void runDirect(action);
      }
    },
    [
      handleArchive,
      showPr,
      claimAction,
      finishAction,
      workspace.baseBranch,
      remote,
      sendToChat,
      runDirect,
    ],
  );

  // No settled data for this PR yet → derive nothing. A guessed intermediate
  // state ("PR open" → "Ready to merge" a beat later) reads as status churn;
  // the render instead falls back to the DURABLE last-known state below, and
  // to "Loading..." only when this PR has no derivation history at all.
  const { status, counts, pr, checks } = data ?? {
    status: null,
    counts: null,
    pr: null,
    checks: null,
  };
  const derived = data
    ? derivePrIslandState(
        {
          prState: workspace.prState,
          status: {
            // This MUST be the HEAD-vs-worktree net comparison. Porcelain bucket
            // addition double-counts paths and falsely reports a staged-add then
            // disk-delete (`AD`) as pending work even though its net diff is empty.
            uncommitted: counts?.uncommitted ?? 0,
            conflicts: status
              ? status.conflicted.length > 0 || status.conflictState != null
              : false,
            ahead: status?.ahead ?? null,
            behind: status?.behind ?? null,
          },
          pr: livePr(pr)
            ? {
                state: (pr as PR).state,
                mergeableState: (pr as PR).mergeableState,
                isMergeable: (pr as PR).isMergeable,
                mergedAt: (pr as PR).mergedAt,
                behindBy: (pr as PR).behindBy ?? null,
              }
            : null,
          checks: checks
            ? {
                pending: checks.pending,
                failed: checks.failed,
                total: checks.total,
              }
            : null,
        },
        { allowContinue: localDesktop },
      )
    : null;
  // Status stability (2026-07-19, hardened 2026-07-21): a raw "checking"
  // derivation (GitHub recomputing mergeability after a push/merge/base-move
  // or after its cache expired while the app was backgrounded) is masked —
  // indefinitely, actions intact — by the generation's last definitive state,
  // so a resume re-check never flaps the row through "Checking mergeability…"
  // and back. See pr-status-stability.ts.
  //
  // No settled batch yet (app relaunch / dev reload / first visit this
  // session): render the DURABLE last-known state while the fetch runs in the
  // background — the row repaints only if the settled result actually differs.
  // "Loading..." is reserved for a PR with no persisted state at all.
  const island = derived
    ? stabilizePrIslandState(stabilityKey, derived)
    : getPrIslandLastState(dataKey);

  // Persist each freshly DERIVED render (never the fallback echoing itself,
  // never an unmasked "checking") so the next relaunch resumes from it. The
  // JSON dep collapses referentially-new-but-identical derivations into one
  // localStorage write.
  const persistJson =
    derived && island && island.kind !== "checking"
      ? JSON.stringify({ stabilityKey, state: island })
      : null;
  useEffect(() => {
    if (!persistJson) return;
    const { stabilityKey: sk, state } = JSON.parse(persistJson) as {
      stabilityKey: string;
      state: PrIslandState;
    };
    rememberPrIslandLastState(dataKey, sk, state);
  }, [dataKey, persistJson]);

  // While the RAW derivation is stuck on "checking", re-probe quickly with a
  // bounded backoff (5s → 10s → 20s) instead of waiting for the 60s poll —
  // GitHub's mergeability recompute settles in seconds, and each settle
  // re-arms this effect via the batch timestamp. The retry budget is per
  // head/base generation (stabilityKey) and is NOT refunded by an intermediate
  // definitive read: when GitHub flaps between "checking" and a definitive
  // mergeable_state, a refunded counter restarted the 5s burst on every flap —
  // sustaining a ~5s probe loop with no user action. Once the budget is spent
  // the 60s poll owns any further re-checks; a new push (new stabilityKey)
  // starts a fresh budget.
  const rawKind = derived?.kind ?? null;
  const dataAt = data?.at ?? 0;
  const checkingRetryRef = useRef<{ key: string; tries: number }>({
    key: "",
    tries: 0,
  });
  useEffect(() => {
    if (!active) return;
    if (checkingRetryRef.current.key !== stabilityKey) {
      checkingRetryRef.current = { key: stabilityKey, tries: 0 };
    }
    if (rawKind !== "checking") return;
    if (checkingRetryRef.current.tries >= 3) return;
    const delay = 5_000 * 2 ** checkingRetryRef.current.tries;
    const timer = window.setTimeout(() => {
      checkingRetryRef.current.tries += 1;
      lastRequestAtRef.current = Date.now();
      setForceRefreshAt(Date.now());
    }, delay);
    return () => window.clearTimeout(timer);
  }, [active, stabilityKey, rawKind, dataAt]);

  // Publish the RENDERED kind for the top bar's workspace tabs (they paint a
  // per-status PR glyph) — the stabilized state, so the tab can't flap either.
  // Retained after unmount so a background tab keeps its last-known icon; a
  // null derivation (loading / prNumber changed / Continue cleared the PR)
  // CLEARS the entry so a stale kind can't outrank the workspace row's
  // fresher persisted state in the tab fallback.
  const islandKind = island?.kind ?? null;
  useEffect(() => {
    if (prNumber != null) {
      publishPrIslandKind(workspace.id, prNumber, islandKind);
    }
  }, [workspace.id, prNumber, islandKind]);

  if (prNumber == null) return null;

  const tone: PrIslandTone = island?.tone ?? "neutral";

  return (
    <div
      data-pr-island=""
      className={cn(
        // Flush row (2026-07-11, was a rounded mb-2 card): 1px hairlines above
        // AND below the tinted row (2026-07-19: border-y at 10%) frame it
        // against the tab bar and the Changes surface.
        "flex h-10 shrink-0 items-center gap-2.5 border-y px-2",
        CARD_TONE[tone],
      )}
      aria-busy={!island || undefined}
    >
      {/* View PR ↗ — focuses the Review tab (the in-app review surface); the
          tab's own header keeps the "Open on GitHub" external link. */}
      <Tooltip label={`Show pull request #${prNumber}`}>
        <button
          type="button"
          onClick={() => showPr()}
          className={cn(CHIP_BASE, CHIP_TONE[tone])}
        >
          View PR
          <ArrowUpRight className="size-3" />
        </button>
      </Tooltip>
      {island ? (
        <span
          className={cn(
            // ml-1 sets the status label off from the View-PR chip (the row's
            // gap-2.5 alone read too tight); the label's right side is absorbed
            // by the flex-1 spacer, so only the chip↔label gap grows.
            "ml-1 inline-flex min-w-0 items-center gap-1.5 text-sm font-medium",
            LABEL_TONE[tone],
          )}
        >
          {island.kind === "closed" && (
            <GitPullRequestClosed className="text-red-fg size-3.5 shrink-0" />
          )}
          <span className="min-w-0 truncate">{island.label}</span>
        </span>
      ) : (
        // No batch AND no durable last-known state — this machine has never
        // derived a status for this PR. Honest, quiet, no spinner.
        <span className="text-fg2 ml-1 min-w-0 truncate text-sm font-medium">
          Loading...
        </span>
      )}
      <div className="flex-1" />
      {(island?.actions ?? []).map((action) => {
        const Icon = ACTION_ICON[action.kind];
        const gated = agentWorking && isActionGatedWhileAgentWorking(action);
        return (
          <Tooltip
            key={action.kind}
            label={gated ? AGENT_WORKING_REASON : action.label}
          >
            {/* span keeps the tooltip live over a disabled button (disabled
                elements receive no pointer events, so the wrapper triggers). */}
            <span className="inline-flex shrink-0">
              <button
                type="button"
                disabled={acting != null || gated}
                onClick={() => runAction(action)}
                className={cn(BTN_BASE, actionButtonClass(action, tone))}
              >
                {acting === action.kind ? (
                  <ZerosSpinner size={14} tone="inherit" />
                ) : (
                  Icon && <Icon className="size-3.5" />
                )}
                <span>{action.label}</span>
              </button>
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
