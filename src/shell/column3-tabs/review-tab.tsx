// ──────────────────────────────────────────────────────────
// ReviewView — the PR review surface (the Review tab's body)
// ──────────────────────────────────────────────────────────
//
// Header (state · branches · merge CTA) + Changes / Description / Commits /
// Checks / Reviews sub-tabs. All provider data flows through ONE live
// snapshot store (review-data.ts — stale-while-revalidate, event-bus +
// adaptive polling) behind the ReviewProvider seam (review-provider.ts), so
// agent pushes, terminal `gh` writes, and github.com-side activity all land
// here without a manual refresh. The Changes sub-tab reuses the local
// base...HEAD diff (the branch is checked out); everything else reads the
// provider. "Add to chat" (comments + failing checks) drops composed text
// into the active chat's composer.
//
// Mounted ONLY for a workspace with a PR (ReviewRow1Tab guards + renders the
// empty state), so there is no "create a PR" empty state here; PR creation
// lives in the shared PR status row (PrStatusRow) that tops both the Changes
// and Review tabs.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, ChevronDown, ExternalLink } from "lucide-react";

import { gitDiff, type PR } from "../../native/git";
import { useWorkspaceStore, useWorkspaceDispatch } from "@/zeros/store/store";
import { notifyWorkspacesChanged } from "@/zeros/store/use-projects";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Tooltip,
} from "@/zeros/ui/primitives";
import { toast } from "@/zeros/ui/primitives/elements";
import { cn } from "@/zeros/ui/cn";
import { renderMarkdown } from "@/zeros/agent/markdown";
import { ZerosSpinner } from "@/loaders";

import { parseUnifiedDiffFiles, type ChangedFile } from "./changes-parse";
import { useScrollMemoryRef } from "../scroll-memory";
import { AGENT_WORKING_REASON } from "../pr/use-agent-working";
import {
  type ReviewMergeMethod,
  type ReviewProvider,
} from "../pr/review-provider";
import { humanGitError, useReviewLiveData } from "./review-data";
import { summarizeChecks } from "./review-model";
import {
  Centered,
  ErrorCallout,
  OutcomeGlyph,
  PrStateBadge,
  ReviewEmptyState,
} from "./review-bits";
import { ReviewChangesSection } from "./review-changes";
import { ReviewCommitsSection } from "./review-commits";
import { ReviewChecksSection } from "./review-checks";
import { ReviewTimelineSection } from "./review-timeline";
import type { ReviewSubtab } from "../column3-tab-manager";

let appendCounter = 0;

// Local PR diffs are small per-workspace snapshots. The provider-backed PR
// model already uses stale-while-revalidate; matching that behavior here keeps
// the Changes count/list complete through workspace switches and deck eviction.
const reviewFilesCache = new Map<string, ChangedFile[]>();
const MAX_REVIEW_FILE_SNAPSHOTS = 32;

/** Refresh generation + completion time of each cached diff, so a remount on
 *  an unchanged generation can skip re-pulling a base diff it just parsed.
 *  The explicit Retry path deletes the entry to force a pull. */
const reviewFilesMeta = new Map<string, { refreshKey: number; at: number }>();
const REVIEW_FILES_FRESH_MS = 60_000;

function reviewFilesKey(workspaceId: string, baseBranch: string): string {
  return JSON.stringify([workspaceId, baseBranch]);
}

function cacheReviewFiles(
  key: string,
  files: ChangedFile[],
  refreshKey: number,
): void {
  reviewFilesCache.delete(key);
  reviewFilesCache.set(key, files);
  reviewFilesMeta.set(key, { refreshKey, at: Date.now() });
  while (reviewFilesCache.size > MAX_REVIEW_FILE_SNAPSHOTS) {
    const oldest = reviewFilesCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    reviewFilesCache.delete(oldest);
    reviewFilesMeta.delete(oldest);
  }
}

// ── merge-method memory ──────────────────────────────────────

function mergeMethodKey(provider: ReviewProvider): string {
  return `zeros.review.merge-method.${provider.cacheKey}`;
}

function loadMergeMethod(provider: ReviewProvider): ReviewMergeMethod {
  const fallback = provider.capabilities.mergeMethods[0]?.id ?? "";
  try {
    const value = window.localStorage.getItem(mergeMethodKey(provider));
    if (
      value &&
      provider.capabilities.mergeMethods.some(
        (method) => method.id === value,
      )
    ) {
      return value;
    }
  } catch {
    /* storage unavailable — default below */
  }
  return fallback;
}

function saveMergeMethod(
  provider: ReviewProvider,
  method: ReviewMergeMethod,
): void {
  try {
    window.localStorage.setItem(mergeMethodKey(provider), method);
  } catch {
    /* best-effort */
  }
}

// ── main view ────────────────────────────────────────────────

export function ReviewView({
  provider,
  workspaceId,
  baseBranch,
  branch,
  prNumber,
  prUrl,
  repoSlug,
  refreshKey,
  active,
  agentWorking,
  sub,
  onSubChange,
}: {
  provider: ReviewProvider;
  workspaceId: string;
  baseBranch: string;
  /** The workspace's head branch (labels + fix-check prompts). */
  branch: string;
  prNumber: number;
  prUrl: string | null;
  /** Workspace-list refresh scope after merge / ready writes. */
  repoSlug: string | null;
  refreshKey: number;
  /** Is the Review tab the visible row-1 tab? Gates live polling. */
  active: boolean;
  /** An agent turn is reshaping this workspace (see useWorkspaceAgentWorking).
   *  Parks the header's Merge / Mark-as-ready writes until the turn lands. */
  agentWorking: boolean;
  /** Owning worktree Review tab's durable inner destination. */
  sub: ReviewSubtab;
  /** Commit an explicit inner destination to the owning tab. */
  onSubChange: (sub: ReviewSubtab) => void;
}) {
  const filesKey = reviewFilesKey(workspaceId, baseBranch);
  const { snap, refresh, postComment, merge, markReady } = useReviewLiveData({
    provider,
    workspaceId,
    prNumber,
    refreshKey,
    active,
  });
  const [busy, setBusy] = useState(false);

  // One scroller hosts every sub-tab's body (the switch below swaps children
  // in place), and ReviewView itself remounts per workspace (key=workspace.id
  // upstream). Keyed memory per workspace+sub-tab restores the reader's place
  // both across sub-tab hops and across workspace round-trips.
  const bodyScrollRef = useScrollMemoryRef(
    JSON.stringify(["review", workspaceId, prNumber, sub]),
  );

  const dispatch = useWorkspaceDispatch();
  const activeChatId = useWorkspaceStore((s) => s.activeChatId);
  const addToChat = useCallback(
    (text: string) => {
      appendCounter += 1;
      dispatch({
        type: "ENQUEUE_COMPOSER_APPEND",
        append: {
          id: `pr-review-${prNumber}-${appendCounter}`,
          text,
          chatId: activeChatId ?? null,
          source: "manual",
        },
      });
    },
    [dispatch, prNumber, activeChatId],
  );

  // ── local PR diff (Changes) — parent-owned so the sub-nav count and the
  //    section always agree; re-pulled on the shared refresh bus.
  // Seed the local diff from the last confirmed model for this workspace.
  const [filesSnapshot, setFilesSnapshot] = useState<{
    key: string;
    files: ChangedFile[];
    loading: boolean;
    error: string | null;
  }>(() => ({
    key: filesKey,
    files: reviewFilesCache.get(filesKey) ?? [],
    loading: !reviewFilesCache.has(filesKey),
    error: null,
  }));
  const cachedFiles = reviewFilesCache.get(filesKey);
  const files =
    filesSnapshot.key === filesKey ? filesSnapshot.files : (cachedFiles ?? []);
  const filesLoading =
    filesSnapshot.key === filesKey
      ? filesSnapshot.loading
      : cachedFiles === undefined;
  const filesError =
    filesSnapshot.key === filesKey ? filesSnapshot.error : null;
  const [filesReloadNonce, setFilesReloadNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const retainedFiles = reviewFilesCache.get(filesKey);
    setFilesSnapshot({
      key: filesKey,
      files: retainedFiles ?? [],
      loading: retainedFiles === undefined,
      error: null,
    });
    // A remount on an unchanged refresh generation (workspace hop, tab
    // switch) with a fresh cached diff renders it as-is — re-pulling the
    // (potentially large) base diff is only warranted when the generation
    // moved, the cache aged out, or Retry invalidated it.
    const meta = reviewFilesMeta.get(filesKey);
    if (
      retainedFiles !== undefined &&
      meta &&
      meta.refreshKey === refreshKey &&
      Date.now() - meta.at < REVIEW_FILES_FRESH_MS
    ) {
      return;
    }
    void gitDiff({ workspaceId, mode: "base", rawPatch: true })
      .then((d) => {
        if (cancelled) return;
        const nextFiles = parseUnifiedDiffFiles(d.patch ?? "");
        cacheReviewFiles(filesKey, nextFiles, refreshKey);
        setFilesSnapshot({
          key: filesKey,
          files: nextFiles,
          loading: false,
          error: null,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setFilesSnapshot((current) =>
          current.key === filesKey
            ? { ...current, loading: false, error: humanGitError(e) }
            : current,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, baseBranch, filesKey, refreshKey, filesReloadNonce]);

  const pr = snap.pr;
  const checksSummary = summarizeChecks(snap.checks);
  const conversationCount = snap.timeline?.length ?? null;

  const runMerge = useCallback(
    async (method: ReviewMergeMethod) => {
      setBusy(true);
      try {
        await merge(method);
        notifyWorkspacesChanged(repoSlug ?? undefined);
        toast.success(`PR #${prNumber} merged`);
      } catch (e) {
        toast.error(`Couldn’t merge PR #${prNumber}`, {
          description: humanGitError(e),
        });
      } finally {
        setBusy(false);
      }
    },
    [merge, prNumber, repoSlug],
  );

  const runMarkReady = useCallback(async () => {
    setBusy(true);
    try {
      await markReady();
      notifyWorkspacesChanged(repoSlug ?? undefined);
    } catch (e) {
      toast.error(`Couldn’t mark PR #${prNumber} as ready`, {
        description: humanGitError(e),
      });
    } finally {
      setBusy(false);
    }
  }, [markReady, prNumber, repoSlug]);

  // ── top-level gates ──
  if (snap.authed === false) {
    return (
      <ReviewEmptyState
        title={`Connect ${provider.hostLabel}`}
        subtitle={`Sign in under Settings → General → ${provider.hostLabel} to open and review pull requests.`}
      />
    );
  }
  if (!pr) {
    if (snap.error) {
      return (
        <div className="p-3">
          <ErrorCallout text={snap.error} onRetry={() => void refresh()} />
        </div>
      );
    }
    return (
      <ReviewPendingShell
        branch={branch}
        baseBranch={baseBranch}
        prNumber={prNumber}
        prUrl={prUrl}
        hostLabel={provider.hostLabel}
        sub={sub}
        onSubChange={onSubChange}
      />
    );
  }

  const subTabs: {
    id: ReviewSubtab;
    label: string;
    count?: number | null;
  }[] = [
    {
      id: "changes",
      label: "Changes",
      count: filesLoading ? null : files.length,
    },
    { id: "description", label: "Description" },
    { id: "commits", label: "Commits", count: snap.commits?.length ?? null },
    { id: "checks", label: "Checks" },
    { id: "reviews", label: "Reviews", count: conversationCount },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── PR header ── */}
      <div className="border-border1 shrink-0 border-b px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <PrStateBadge state={pr.state} />
          <span className="text-2xxs text-fg2 flex min-w-0 items-center gap-1 font-mono">
            <span className="truncate">{pr.headBranch}</span>
            <ArrowRight className="text-muted-fg size-3 shrink-0" />
            <span className="shrink-0">{pr.baseBranch}</span>
          </span>
          <div className="flex-1" />
          {(prUrl || pr.url) && (
            <Tooltip label={`Open on ${provider.hostLabel}`}>
              <a
                href={prUrl ?? pr.url}
                target="_blank"
                rel="noreferrer"
                className="text-fg2 hover:bg-bg2-hover hover:text-fg1 flex size-7 items-center justify-center rounded-sm transition-colors duration-120 ease-out"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </Tooltip>
          )}
          <MergeControls
            provider={provider}
            pr={pr}
            busy={busy}
            agentWorking={agentWorking}
            onMarkReady={() => void runMarkReady()}
            onMerge={(m) => void runMerge(m)}
          />
        </div>
        <div className="mt-1.5 flex min-w-0 items-baseline gap-1.5">
          <Tooltip label={pr.title}>
            <h2 className="text-fg1 m-0 min-w-0 truncate text-sm font-medium">
              {pr.title}
            </h2>
          </Tooltip>
          <span className="text-muted-fg shrink-0 text-xs tabular-nums">
            #{pr.number}
          </span>
        </div>
      </div>

      {/* ── sub-nav ── */}
      <div
        role="tablist"
        className="border-border1 flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {subTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={sub === t.id}
            onClick={() => onSubChange(t.id)}
            className={cn(
              "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors duration-120 ease-out",
              sub === t.id
                ? "bg-bg2-hover text-fg1"
                : "text-fg2 hover:bg-bg2-hover/50 hover:text-fg1",
            )}
          >
            {t.id === "checks" && checksSummary.tone !== "none" && (
              <OutcomeGlyph
                outcome={
                  checksSummary.tone === "failure"
                    ? "failed"
                    : checksSummary.tone === "pending"
                      ? "pending"
                      : "passed"
                }
              />
            )}
            {t.label}
            {t.id === "checks"
              ? checksSummary.fraction && (
                  <span className="text-muted-fg tabular-nums">
                    {checksSummary.fraction}
                  </span>
                )
              : t.count != null &&
                t.count > 0 && (
                  <span className="text-muted-fg tabular-nums">{t.count}</span>
                )}
          </button>
        ))}
      </div>

      {/* ── body ── */}
      <div ref={bodyScrollRef} className="min-h-0 flex-1 overflow-auto">
        {sub === "changes" && (
          <ReviewChangesSection
            files={files}
            loading={filesLoading}
            error={filesError}
            baseBranch={baseBranch}
            onRetry={() => {
              reviewFilesMeta.delete(filesKey);
              setFilesReloadNonce((n) => n + 1);
            }}
          />
        )}
        {sub === "description" && <DescriptionSection pr={pr} />}
        {sub === "commits" && (
          <ReviewCommitsSection
            commits={snap.commits}
            loading={snap.refreshing}
            error={snap.resourceErrors.commits}
            onRetry={() => void refresh()}
          />
        )}
        {sub === "checks" && (
          <ReviewChecksSection
            data={snap.checks}
            loading={snap.refreshing}
            error={snap.resourceErrors.checks}
            prNumber={pr.number}
            branch={branch || pr.headBranch}
            onAddToChat={addToChat}
            onRetry={() => void refresh()}
          />
        )}
        {sub === "reviews" && (
          <ReviewTimelineSection
            pr={pr}
            prNumber={pr.number}
            commits={snap.commits}
            timeline={snap.timeline}
            loading={snap.refreshing}
            error={snap.resourceErrors.timeline}
            scrollKey={JSON.stringify([
              "review-timeline",
              workspaceId,
              pr.number,
            ])}
            onAddToChat={addToChat}
            onPostComment={postComment}
            onRetry={() => void refresh()}
          />
        )}
      </div>
    </div>
  );
}

/** Paint only workspace-owned PR identity during the first provider read. The
 * shell is immediately navigable, but it deliberately invents no provider
 * state, title, counts, or mergeability while live GitHub data is pending. */
function ReviewPendingShell({
  branch,
  baseBranch,
  prNumber,
  prUrl,
  hostLabel,
  sub,
  onSubChange,
}: {
  branch: string;
  baseBranch: string;
  prNumber: number;
  prUrl: string | null;
  hostLabel: string;
  sub: ReviewSubtab;
  onSubChange: (sub: ReviewSubtab) => void;
}) {
  const tabs: { id: ReviewSubtab; label: string }[] = [
    { id: "changes", label: "Changes" },
    { id: "description", label: "Description" },
    { id: "commits", label: "Commits" },
    { id: "checks", label: "Checks" },
    { id: "reviews", label: "Reviews" },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy="true">
      <div className="border-border1 shrink-0 border-b px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-2xxs text-fg2 flex min-w-0 items-center gap-1 font-mono">
            <span className="truncate">{branch}</span>
            <ArrowRight className="text-muted-fg size-3 shrink-0" />
            <span className="shrink-0">{baseBranch}</span>
          </span>
          <div className="flex-1" />
          {prUrl && (
            <Tooltip label={`Open on ${hostLabel}`}>
              <a
                href={prUrl}
                target="_blank"
                rel="noreferrer"
                className="text-fg2 hover:bg-bg2-hover hover:text-fg1 flex size-7 items-center justify-center rounded-sm transition-colors duration-120 ease-out"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </Tooltip>
          )}
        </div>
        <div className="mt-1.5 flex min-w-0 items-baseline gap-1.5">
          <h2 className="text-fg1 m-0 min-w-0 truncate text-sm font-medium">
            Pull request
          </h2>
          <span className="text-muted-fg shrink-0 text-xs tabular-nums">
            #{prNumber}
          </span>
        </div>
      </div>
      <div
        role="tablist"
        className="border-border1 flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={sub === tab.id}
            onClick={() => onSubChange(tab.id)}
            className={cn(
              "flex h-6 shrink-0 items-center rounded-md px-2.5 text-xs font-medium transition-colors duration-120 ease-out",
              sub === tab.id
                ? "bg-bg2-hover text-fg1"
                : "text-fg2 hover:bg-bg2-hover/50 hover:text-fg1",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1" />
    </div>
  );
}

// ── description ──────────────────────────────────────────────

function DescriptionSection({ pr }: { pr: PR }) {
  const html = useMemo(() => renderMarkdown(pr.body), [pr.body]);
  if (!pr.body.trim())
    return (
      <Centered>No description yet. Edit it on the PR to add one.</Centered>
    );
  return (
    <div className="zeros-agent-md p-3 [&_.zeros-md-prose>:first-child]:mt-0">
      <div
        className="zeros-md-prose text-sm"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

// ── merge controls ───────────────────────────────────────────

/** The header CTA per PR state: draft → Mark as ready (primary); open → the
 *  split merge button (green fill, remembered method + a method picker);
 *  merged/closed → nothing (the state badge says it all). Both writes are
 *  parked while the agent has a turn in flight — merging could ship a
 *  half-pushed branch, and marking ready would invite review of one. */
function MergeControls({
  provider,
  pr,
  busy,
  agentWorking,
  onMarkReady,
  onMerge,
}: {
  provider: ReviewProvider;
  pr: PR;
  busy: boolean;
  agentWorking: boolean;
  onMarkReady: () => void;
  onMerge: (m: ReviewMergeMethod) => void;
}) {
  const mergeMethods = provider.capabilities.mergeMethods;
  const [method, setMethod] = useState<ReviewMergeMethod>(() =>
    loadMergeMethod(provider),
  );
  const selectedMethod =
    mergeMethods.find((candidate) => candidate.id === method) ??
    mergeMethods[0];
  if (pr.state === "merged" || pr.state === "closed") return null;
  if (pr.state === "draft") {
    const ready = (
      <Button
        size="sm"
        variant="default"
        disabled={busy || agentWorking}
        onClick={onMarkReady}
        className="gap-1.5"
      >
        {busy && <ZerosSpinner size={16} tone="inverted" />}
        Mark as ready
      </Button>
    );
    return agentWorking ? (
      <Tooltip label={AGENT_WORKING_REASON}>
        {/* span keeps the tooltip live over the disabled button */}
        <span className="inline-flex">{ready}</span>
      </Tooltip>
    ) : (
      ready
    );
  }
  const conflicted = pr.isMergeable === false || pr.mergeableState === "dirty";
  const pick = (m: ReviewMergeMethod) => {
    setMethod(m);
    saveMergeMethod(provider, m);
  };
  if (!selectedMethod) return null;
  const mergeButton = (
    // The one green CTA on the surface — same fill treatment as the PR
    // island's Merge action, so "merge" reads identically everywhere. The
    // 1px gap lets the header's bg1 show through as the segment divider
    // (no border token belongs on a colour fill).
    <span className="inline-flex gap-px overflow-hidden rounded-sm">
      <button
        type="button"
        disabled={busy || conflicted || agentWorking}
        onClick={() => onMerge(selectedMethod.id)}
        className="bg-green-primary text-bg1 flex h-6 items-center gap-1.5 px-2.5 text-xs font-medium transition-opacity duration-120 ease-out hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
      >
        {busy && <ZerosSpinner size={12} tone="inherit" />}
        {selectedMethod.label}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={busy || conflicted || agentWorking}
            aria-label="Choose merge method"
            className="bg-green-primary text-bg1 flex h-6 items-center px-1.5 transition-opacity duration-120 ease-out hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
          >
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup
            value={selectedMethod.id}
            onValueChange={pick}
          >
            {mergeMethods.map((candidate) => (
              <DropdownMenuRadioItem
                key={candidate.id}
                value={candidate.id}
              >
                {candidate.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
  // Conflicts are the durable blocker, so that message wins the tooltip.
  const blockedReason = conflicted
    ? "This branch has conflicts with the base branch — resolve them first."
    : agentWorking
      ? AGENT_WORKING_REASON
      : null;
  return blockedReason ? (
    <Tooltip label={blockedReason}>
      {/* span keeps the tooltip live over the disabled buttons */}
      <span className="inline-flex">{mergeButton}</span>
    </Tooltip>
  ) : (
    mergeButton
  );
}
