// ──────────────────────────────────────────────────────────
// ReviewView — the PR review surface (the Review tab's body)
// ──────────────────────────────────────────────────────────
//
// The header reads in rows (review-overview.tsx), then Overview / Description
// / Activity / Checks / Commits. Overview holds Git status (the branch on this
// machine, from the shared PR status island), PR status (the pull request on
// the host, with the one Merge) and Findings, beside the rail. All provider
// data flows through ONE live snapshot store (review-data.ts — stale-while-
// revalidate, event-bus + adaptive polling) behind the ReviewProvider seam
// (review-provider.ts). The published diff, where Post to PR works, stays one
// step from Overview's rail until posting moves to the Changes tab
// (docs/design-implementation/plans.md §1.2).
//
// Mounted ONLY for a workspace with a PR (ReviewSurface guards + renders the
// empty state). "Add to chat" drops composed text into the active chat's
// composer.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Pencil } from "lucide-react";

import { gitDiff, type PR } from "../../../platform/git";
import { useGithubReview } from "@/renderer/features/code-review/use-github-review";
import {
  useWorkspaceStore,
  useWorkspaceDispatch,
} from "@/renderer/state/store";
import { notifyWorkspacesChanged } from "@/renderer/state/use-projects";
import { Button, ButtonShortcut, Textarea } from "@/renderer/shared/ui/primitives";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { renderMarkdown } from "@/renderer/features/agent/markdown";
import { useCodeReview } from "@/renderer/features/code-review/use-code-review";
import { LatestGenerationFlight } from "@/renderer/shared/lib/latest-generation-flight";

import { parseUnifiedDiffFiles, type ChangedFile } from "./changes-parse";
import { useScrollMemoryRef } from "../../scroll-memory";
import { usePrIslandKind } from "../../pr/pr-island-state-store";
import { registerPrWorkspaceCacheForget } from "../../pr/pr-cache-forget";
import {
  type ReviewMergeMethod,
  type ReviewProvider,
} from "../../pr/review-provider";
import {
  humanGitError,
  reviewReadFailure,
  useReviewLiveData,
} from "./review-data";
import { useReviewGithubFailure } from "../../pr/review-github-failure";
import { derivePrStatusView, reviewCommentViewer, reviewFindings, summarizeChecks } from "./review-model";
import { reviewRepositoryLabel } from "./review-repository-label";
import { ErrorCallout } from "./review-shared-components";
import {
  FindingsSection,
  PrStatusCard,
  ReviewHeader,
  ReviewKnownHeader,
  ReviewOverviewLayout,
  ReviewRail,
  ReviewSection,
  ReviewSubnav,
  SUBTAB_FRAME,
  type ReviewChangeCounts,
} from "./review-overview";
import { ReviewChangesSection } from "./review-changes";
import {
  WorkbenchEmptyState,
  WorkbenchTabToolbar,
  useWorkbenchStatusSource,
} from "../tab-status";
import { ReviewCommitsSection } from "./review-commits";
import { ReviewChecksSection } from "./review-checks";
import { useReviewCommitChats } from "./review-commit-chats";
import { ReviewTimelineSection } from "./review-timeline";
import type { ReviewSubtab } from "../tab-model";

let appendCounter = 0;

/** The sign-in probe answers a boolean, not an error. Give the gate one stable
 *  rejection so the banner names the connection like any refused read. */
const GITHUB_SIGNED_OUT = Object.assign(
  new Error("GitHub did not confirm a signed-in account."),
  { code: "NOT_AUTHENTICATED" },
);

// Published PR diffs are bounded per-workspace snapshots. The provider-backed PR
// model already uses stale-while-revalidate; matching that behavior here keeps
// the Changes count/list complete through workspace switches and deck eviction.
interface ReviewFilesSnapshot { files: ChangedFile[]; headSha?: string; baseSha?: string }
const EMPTY_REVIEW_FILES: ChangedFile[] = [];
const reviewFilesCache = new Map<string, ReviewFilesSnapshot>();
const MAX_REVIEW_FILE_SNAPSHOTS = 32;

/** Refresh generation + completion time of each cached diff, so a remount on
 *  an unchanged generation can skip re-pulling a base diff it just parsed.
 *  The explicit Retry path deletes the entry to force a pull. */
const reviewFilesMeta = new Map<string, { refreshKey: number; at: number }>();
const REVIEW_FILES_FRESH_MS = 60_000;
const reviewFileRequests = new LatestGenerationFlight<ReviewFilesSnapshot>();
type ReviewFilesRevision = readonly [
  refreshKey: number,
  prHeadSha: string | undefined,
  reviewHeadSha: string | undefined,
  reviewBaseSha: string | undefined,
];
interface ReviewFileRequestVersion {
  revision: ReviewFilesRevision;
  generation: number;
  validateResult: boolean;
  retry: boolean;
  consumers: number;
  promise?: Promise<ReviewFilesSnapshot>;
}
// Remote review polls can change the comparison without a Git refresh signal.
// Share one generation per observed revision, across consumers and remounts.
// Keep its promise through consumer publication, including the gap after the
// transport settles. Cancelled consumers cannot retire a version still in use.
const reviewFileRequestVersions = new Map<string, ReviewFileRequestVersion>();
let reviewFileRequestGeneration = 0;
const reviewFileRequestOwners = new Set<{
  workspaceId: string;
  key: string;
  cancelled: boolean;
}>();

registerPrWorkspaceCacheForget((workspaceId) => {
  for (const key of new Set([
    ...reviewFilesCache.keys(),
    ...reviewFilesMeta.keys(),
    ...reviewFileRequestVersions.keys(),
  ])) {
    const [, owner] = JSON.parse(key) as [string, string, number, string];
    if (owner !== workspaceId) continue;
    reviewFilesCache.delete(key);
    reviewFilesMeta.delete(key);
    reviewFileRequestVersions.delete(key);
    reviewFileRequests.forget(key);
  }
  for (const request of reviewFileRequestOwners) {
    if (request.workspaceId !== workspaceId) continue;
    request.cancelled = true;
    reviewFileRequests.forget(request.key);
    reviewFileRequestOwners.delete(request);
  }
});

function reviewFilesKey(providerKey: string, workspaceId: string, prNumber: number, baseBranch: string): string {
  return JSON.stringify([providerKey, workspaceId, prNumber, baseBranch]);
}

function cacheReviewFiles(
  key: string,
  snapshot: ReviewFilesSnapshot,
  refreshKey: number,
): void {
  reviewFilesCache.delete(key);
  reviewFilesCache.set(key, snapshot);
  reviewFilesMeta.set(key, { refreshKey, at: Date.now() });
  while (reviewFilesCache.size > MAX_REVIEW_FILE_SNAPSHOTS) {
    const oldest = reviewFilesCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    reviewFilesCache.delete(oldest);
    reviewFilesMeta.delete(oldest);
  }
}

// ── merge-method memory ──────────────────────────────────────

// ── main view ────────────────────────────────────────────────

export function ReviewView({
  provider,
  workspaceId,
  cwd,
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
  gitStatus,
}: {
  provider: ReviewProvider;
  workspaceId: string;
  cwd: string;
  baseBranch: string;
  /** The workspace's head branch (labels + fix-check prompts). */
  branch: string;
  prNumber: number;
  prUrl: string | null;
  /** Workspace-list refresh scope after merge / ready writes. */
  repoSlug: string | null;
  refreshKey: number;
  /** Is the Review tab the visible workbench tab? Gates live polling. */
  active: boolean;
  /** An agent turn is reshaping this workspace (see useWorkspaceAgentWorking).
   *  Parks the header's Merge / Mark-as-ready writes until the turn lands. */
  agentWorking: boolean;
  /** Owning worktree Review tab's durable inner destination. */
  sub: ReviewSubtab;
  /** Commit an explicit inner destination to the owning tab. */
  onSubChange: (sub: ReviewSubtab) => void;
  /** Overview's Git status card: the shared PR status island in its
   *  git-status presentation, owned by the surface that knows the workspace. */
  gitStatus?: React.ReactNode;
}) {
  const repositoryLabel = reviewRepositoryLabel(workspaceId, repoSlug);
  const filesKey = reviewFilesKey(provider.cacheKey, workspaceId, prNumber, baseBranch);
  const { snap, refresh, postComment, merge, markReady, updateBody, rerunFailedChecks } = useReviewLiveData({
    provider,
    workspaceId,
    prNumber,
    refreshKey,
    active,
  });
  const islandKind = usePrIslandKind(workspaceId, prNumber);
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
  const chats = useWorkspaceStore((s) => s.chats);
  // Which chat made each commit: read only while a surface that names it shows.
  const commitChats = useReviewCommitChats(
    workspaceId,
    snap.commits,
    chats,
    active && (sub === "commits" || sub === "activity"),
  );
  const openChat = useCallback(
    (chatId: string) => dispatch({ type: "SET_ACTIVE_CHAT", id: chatId }),
    [dispatch],
  );
  const viewChecks = useCallback(() => onSubChange("checks"), [onSubChange]);
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

  // ── published PR diff (Changes) — parent-owned so the sub-nav count and the
  //    section always agree; re-pulled on Git and remote comparison changes.
  // Seed the local diff from the last confirmed model for this workspace.
  const [filesSnapshot, setFilesSnapshot] = useState<{
    key: string;
    files: ChangedFile[];
    headSha?: string;
    baseSha?: string;
    loading: boolean;
    error: unknown;
  }>(() => ({
    key: filesKey,
    files: reviewFilesCache.get(filesKey)?.files ?? EMPTY_REVIEW_FILES,
    headSha: reviewFilesCache.get(filesKey)?.headSha,
    baseSha: reviewFilesCache.get(filesKey)?.baseSha,
    loading: !reviewFilesCache.has(filesKey),
    error: null,
  }));
  const cachedFiles = reviewFilesCache.get(filesKey);
  const files = useMemo(() => filesSnapshot.key === filesKey ? filesSnapshot.files : (cachedFiles?.files ?? EMPTY_REVIEW_FILES), [filesSnapshot, filesKey, cachedFiles]);
  const filesHeadSha = filesSnapshot.key === filesKey ? filesSnapshot.headSha : cachedFiles?.headSha;
  const filesBaseSha = filesSnapshot.key === filesKey ? filesSnapshot.baseSha : cachedFiles?.baseSha;
  const filesLoading =
    filesSnapshot.key === filesKey
      ? filesSnapshot.loading
      : cachedFiles === undefined;
  const filesError =
    filesSnapshot.key === filesKey ? filesSnapshot.error : null;
  const [filesReloadNonce, setFilesReloadNonce] = useState(0);
  const renamedPaths = useMemo(() => new Map(files.flatMap(file => file.oldPath ? [[file.oldPath, file.path] as const] : [])), [files]);
  const githubReview = useGithubReview({
    workspaceId: provider.family === "github" ? workspaceId : undefined,
    prNumber, cwd, active: active && (sub === "changes" || sub === "overview"),
    confirmedHeadSha: filesHeadSha, confirmedBaseSha: filesBaseSha, renamedPaths,
  });
  const reviewHeadSha = githubReview.snapshot?.headSha;
  const reviewBaseSha = githubReview.snapshot?.baseSha;
  // A published PR diff does not live in the worktree, so local refresh
  // generations (agent writes, builds) never re-download it; its head and base
  // SHAs are the comparison identity. A local base diff still follows them.
  const diffGeneration = provider.getDiff ? 0 : refreshKey;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const retainedFiles = reviewFilesCache.get(filesKey);
    setFilesSnapshot({
      key: filesKey,
      files: retainedFiles?.files ?? EMPTY_REVIEW_FILES,
      headSha: retainedFiles?.headSha,
      baseSha: retainedFiles?.baseSha,
      loading: retainedFiles === undefined,
      error: null,
    });
    // A remount on an unchanged refresh generation (workspace hop, tab
    // switch) with a fresh cached diff renders it as-is — re-pulling the
    // (potentially large) base diff is only warranted when the generation
    // or confirmed comparison moved, the cache aged out, or Retry invalidated it.
    const meta = reviewFilesMeta.get(filesKey);
    if (
      retainedFiles !== undefined &&
      meta &&
      meta.refreshKey === diffGeneration &&
      (!snap.pr?.headSha || retainedFiles.headSha === snap.pr.headSha) &&
      (!reviewHeadSha || retainedFiles.headSha === reviewHeadSha) &&
      (!reviewBaseSha || retainedFiles.baseSha === reviewBaseSha) &&
      Date.now() - meta.at < REVIEW_FILES_FRESH_MS
    ) {
      return;
    }
    const revision: ReviewFilesRevision = [
      diffGeneration,
      snap.pr?.headSha,
      reviewHeadSha,
      reviewBaseSha,
    ];
    const previousRequest = reviewFileRequestVersions.get(filesKey);
    const requestVersion: ReviewFileRequestVersion =
      previousRequest &&
      !previousRequest.retry &&
      previousRequest.revision.every(
        (value, index) => value === undefined || value === revision[index],
      )
        ? previousRequest
        : {
            revision,
            generation: ++reviewFileRequestGeneration,
            validateResult: false,
            retry: false,
            consumers: 0,
          };
    if (requestVersion === previousRequest) {
      // Metadata and the initial diff load in parallel. Learning a previously
      // unknown SHA does not invalidate that read; check its result instead.
      requestVersion.validateResult ||= requestVersion.revision.some(
        (value, index) => value !== revision[index],
      );
      requestVersion.revision = revision;
    }
    reviewFileRequestVersions.set(filesKey, requestVersion);
    const requestOwner = { workspaceId, key: filesKey, cancelled: false };
    reviewFileRequestOwners.add(requestOwner);
    requestVersion.consumers += 1;
    requestVersion.promise ??= reviewFileRequests
      .run(filesKey, requestVersion.generation, async () => {
        if (provider.getDiff) {
          const result = await provider.getDiff({ workspaceId, hostOrigin: provider.hostOrigin, reviewRef: String(prNumber) });
          return { files: parseUnifiedDiffFiles(result.patch), headSha: result.headSha, baseSha: result.baseSha };
        }
        const diff = await gitDiff({
          workspaceId,
          mode: "base",
          rawPatch: true,
        });
        return { files: parseUnifiedDiffFiles(diff.patch ?? "") };
      });
    void requestVersion.promise
      .then((nextFiles) => {
        if (
          cancelled ||
          requestOwner.cancelled ||
          reviewFileRequestVersions.get(filesKey) !== requestVersion
        )
          return;
        const [, prHead, reviewHead, reviewBase] = requestVersion.revision;
        if (
          provider.getDiff &&
          requestVersion.validateResult &&
          ((prHead && nextFiles.headSha !== prHead) ||
            (reviewHead && nextFiles.headSha !== reviewHead) ||
            (reviewBase && nextFiles.baseSha !== reviewBase))
        ) {
          // This read predates the now-known comparison. Keep confirmed files
          // visible and start a fresh request without publishing the mismatch.
          requestVersion.retry = true;
          setFilesReloadNonce((nonce) => nonce + 1);
          return;
        }
        cacheReviewFiles(filesKey, nextFiles, diffGeneration);
        setFilesSnapshot({
          key: filesKey,
          files: nextFiles.files,
          headSha: nextFiles.headSha,
          baseSha: nextFiles.baseSha,
          loading: false,
          error: null,
        });
      })
      .catch((e) => {
        if (
          cancelled ||
          requestOwner.cancelled ||
          reviewFileRequestVersions.get(filesKey) !== requestVersion
        )
          return;
        setFilesSnapshot((current) =>
          current.key === filesKey
            ? { ...current, loading: false, error: reviewReadFailure(e) }
            : current,
        );
      })
      .finally(() => {
        reviewFileRequestOwners.delete(requestOwner);
        requestVersion.consumers -= 1;
        if (
          requestVersion.consumers === 0 &&
          reviewFileRequestVersions.get(filesKey) === requestVersion
        )
          reviewFileRequestVersions.delete(filesKey);
      });
    return () => {
      cancelled = true;
    };
  }, [active, provider, workspaceId, prNumber, baseBranch, filesKey, diffGeneration, filesReloadNonce, snap.pr?.headSha, reviewHeadSha, reviewBaseSha]);

  const pr = snap.pr;
  // The sign-in gate is the review's failure even when the published diff
  // was refused first: both are the same connection, named in the banner.
  const signedOut = snap.authed === false;
  const primaryError = useReviewGithubFailure(
    signedOut ? GITHUB_SIGNED_OUT : snap.error ?? filesError,
    { workspaceId, active },
  );
  const resourceError = useReviewGithubFailure(
    snap.resourceErrors.checks ??
      snap.resourceErrors.commits ??
      snap.resourceErrors.timeline ??
      (sub === "changes" ? githubReview.error : null),
    { workspaceId, active },
  );
  useWorkbenchStatusSource(
    {
      error: primaryError,
      pending: snap.refreshing || (!signedOut && filesLoading),
      primary: true,
      hasContent:
        !signedOut &&
        !!pr &&
        (sub === "changes"
          ? cachedFiles !== undefined || files.length > 0
          : sub === "commits"
            ? snap.commits !== null
            : sub === "checks"
              ? snap.checks !== null
              : sub === "activity"
                ? snap.timeline !== null
                : true),
      retry: async () => {
        reviewFilesMeta.delete(filesKey);
        setFilesReloadNonce((n) => n + 1);
        await refresh();
      },
    },
    filesKey,
  );
  useWorkbenchStatusSource(
    {
      error: resourceError,
      pending:
        snap.refreshing ||
        (sub === "changes" && !!githubReview.source?.loading),
      retry: async () => {
        await Promise.allSettled([refresh(), githubReview.refresh()]);
      },
    },
    "review-resources",
  );
  const inlineViewer = githubReview.snapshot?.viewer;
  const commentViewer = useMemo(
    () => reviewCommentViewer({ login: snap.login, avatarUrl: snap.avatarUrl }, inlineViewer),
    [snap.login, snap.avatarUrl, inlineViewer],
  );
  const postAsViewer = useCallback(
    (body: string) => postComment(body, commentViewer),
    [postComment, commentViewer],
  );
  const checksSummary = summarizeChecks(snap.checks);
  const conversationCount = snap.timeline?.length ?? null;
  // The pull request's own totals; an older engine falls back to the diff.
  const changeCounts = useMemo<ReviewChangeCounts | null>(() => {
    const live = snap.pr;
    if (live && live.changedFiles != null && live.additions != null && live.deletions != null) {
      return { files: live.changedFiles, additions: live.additions, deletions: live.deletions };
    }
    if (filesLoading) return null;
    return files.reduce<ReviewChangeCounts>(
      (sum, file) => ({
        files: sum.files + 1,
        additions: sum.additions + (file.additions ?? 0),
        deletions: sum.deletions + (file.deletions ?? 0),
      }),
      { files: 0, additions: 0, deletions: 0 },
    );
  }, [snap.pr, files, filesLoading]);
  const statusView = useMemo(
    () =>
      snap.pr
        ? derivePrStatusView({ pr: snap.pr, branch, checks: snap.checks, timeline: snap.timeline })
        : null,
    [snap.pr, branch, snap.checks, snap.timeline],
  );
  // Findings: the agent's workspace comments joined with the host's review
  // apps and code scanning (the GitHub review source).
  const codeReview = useCodeReview({
    cwd,
    workspaceId,
    active: active && sub === "overview",
    refreshKey,
    external: githubReview.source,
  });
  const findings = useMemo(
    () => reviewFindings(codeReview.threads, prNumber),
    [codeReview.threads, prNumber],
  );

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

  const runRerunFailed = useCallback(async () => {
    if (!rerunFailedChecks) return;
    try {
      const rerun = await rerunFailedChecks();
      if (rerun > 0) toast.success(rerun === 1 ? "Re-running 1 failed run" : `Re-running ${rerun} failed runs`);
      else toast.info("No failed runs to re-run", { description: "These checks come from apps Zeros can’t restart." });
    } catch (e) {
      toast.error("Couldn’t re-run the failed checks", { description: humanGitError(e) });
    }
  }, [rerunFailedChecks]);

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
  if (signedOut) return <WorkbenchEmptyState type="review" />;
  if (!pr) {
    if (snap.error) {
      // The rows the workspace knows stay; the tab's banner names the failure
      // and offers Retry, and the body keeps the tab's one-line fallback.
      return (
        <div className="flex h-full min-h-0 flex-col" data-review-load-failed="">
          <WorkbenchTabToolbar>
            <ReviewKnownHeader
              prNumber={prNumber}
              repoSlug={repoSlug}
              hostLabel={provider.hostLabel}
              prUrl={prUrl}
              baseBranch={baseBranch}
              branch={branch}
            />
            <ReviewSubnav
              sub={sub}
              onSubChange={onSubChange}
              activityCount={null}
              commitsCount={null}
              checksCount={null}
              checks={summarizeChecks(null)}
            />
          </WorkbenchTabToolbar>
          <WorkbenchEmptyState type="review" />
        </div>
      );
    }
    return (
      <ReviewPendingShell
        branch={branch}
        baseBranch={baseBranch}
        prNumber={prNumber}
        repoSlug={repositoryLabel}
        sub={sub}
        onSubChange={onSubChange}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkbenchTabToolbar>
        <ReviewHeader
          pr={pr}
          repoSlug={repositoryLabel}
          hostLabel={provider.hostLabel}
          prUrl={prUrl}
          changes={changeCounts}
          onRefresh={() => void refresh()}
        />
        <ReviewSubnav
          sub={sub}
          onSubChange={onSubChange}
          activityCount={conversationCount}
          commitsCount={snap.commits?.length ?? null}
          checksCount={snap.checks?.total ?? null}
          checks={checksSummary}
        />
      </WorkbenchTabToolbar>
      {/* ── body ── */}
      <div ref={bodyScrollRef} className="min-h-0 flex-1 overflow-auto">
        {sub === "overview" && statusView && (
          <ReviewOverviewLayout
            gitStatus={gitStatus}
            prStatus={
              <PrStatusCard
                view={statusView}
                provider={provider}
                islandKind={islandKind}
                agentWorking={agentWorking}
                busy={busy}
                commitCount={snap.commits?.length ?? null}
                baseBranch={pr.baseBranch}
                onMerge={(method) => void runMerge(method)}
                onMarkReady={() => void runMarkReady()}
                onAddToChat={addToChat}
              />
            }
            findings={<FindingsSection findings={findings} onAddToChat={addToChat} />}
            rail={
              <ReviewRail
                pr={pr}
                timeline={snap.timeline}
                changes={changeCounts}
                onOpenChanges={() => onSubChange("changes")}
              />
            }
          />
        )}
        {sub === "changes" && (
          <>
            <div className="border-border1 flex h-10 items-center border-b px-3">
              <Button variant="ghost" size="compact" className="text-fg2" onClick={() => onSubChange("overview")}>
                <ArrowLeft aria-hidden />
                Overview
              </Button>
            </div>
            <ReviewChangesSection
              key={JSON.stringify([provider.cacheKey, workspaceId, prNumber])}
              workspaceId={workspaceId}
              cwd={cwd}
              active={active && sub === "changes"}
              refreshKey={refreshKey}
              reviewExternal={githubReview.source}
              files={files}
              loading={filesLoading}
              error={null}
              baseBranch={baseBranch}
              onRetry={() => {
                reviewFilesMeta.delete(filesKey);
                setFilesReloadNonce((n) => n + 1);
              }}
            />
          </>
        )}
        {sub === "description" && (
          <div className={SUBTAB_FRAME}>
            <DescriptionSection key={pr.number} pr={pr} hostLabel={provider.hostLabel} onSave={updateBody} />
          </div>
        )}
        {sub === "commits" && (
          <div className={SUBTAB_FRAME}>
            <ReviewCommitsSection
              commits={snap.commits}
              loading={snap.refreshing}
              error={null}
              prUrl={pr.url || prUrl}
              onRetry={() => void refresh()}
              chats={commitChats}
              onOpenChat={openChat}
            />
          </div>
        )}
        {sub === "checks" && (
          <div className={SUBTAB_FRAME}>
            <ReviewChecksSection
              data={snap.checks}
              loading={snap.refreshing}
              error={null}
              prNumber={pr.number}
              branch={branch || pr.headBranch}
              onAddToChat={addToChat}
              onRetry={() => void refresh()}
              onRerunFailed={rerunFailedChecks ? runRerunFailed : undefined}
            />
          </div>
        )}
        {sub === "activity" && (
          <ReviewTimelineSection
            pr={pr}
            prNumber={pr.number}
            commits={snap.commits}
            timeline={snap.timeline}
            loading={snap.refreshing}
            error={null}
            scrollKey={JSON.stringify([
              "review-timeline",
              workspaceId,
              pr.number,
            ])}
            hostLabel={provider.hostLabel}
            viewer={commentViewer}
            onAddToChat={addToChat}
            onPostComment={postAsViewer}
            onRetry={() => void refresh()}
            checks={snap.checks}
            chats={commitChats}
            onOpenChat={openChat}
            onViewChecks={viewChecks}
          />
        )}
      </div>
    </div>
  );
}

/** Paint only workspace-owned PR identity during the first provider read: the
 * number and branches in their final rows, the sub-tabs, and skeletons where
 * the title and cards will land, so nothing moves when the pull request
 * arrives. It invents no provider state, title, counts or mergeability. */
function ReviewPendingShell({
  branch,
  baseBranch,
  prNumber,
  repoSlug,
  sub,
  onSubChange,
}: {
  branch: string;
  baseBranch: string;
  prNumber: number;
  repoSlug: string | null;
  sub: ReviewSubtab;
  onSubChange: (sub: ReviewSubtab) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy="true">
      <header className="flex shrink-0 flex-col px-5 pt-4 pb-3.5">
        <div className="flex min-h-7 items-center">
          <span className="bg-bg2 h-6 w-16 rounded-full" />
        </div>
        <p className="text-fg3 m-0 mt-3 text-xs tabular-nums">
          {repoSlug ? `${repoSlug} · ` : ""}#{prNumber}
        </p>
        <span className="bg-bg2 mt-1.5 h-5 w-2/3 rounded-md" />
        <p className="text-fg3 m-0 mt-4 truncate text-3xxs leading-4">
          {baseBranch} ← {branch}
        </p>
      </header>
      <ReviewSubnav
        sub={sub}
        onSubChange={onSubChange}
        activityCount={null}
        commitsCount={null}
        checksCount={null}
        checks={summarizeChecks(null)}
      />
      <div className="min-h-0 flex-1" />
    </div>
  );
}

// ── description ──────────────────────────────────────────────

/** The body as Markdown, with Edit when the provider can write it. Saving
 * keeps the draft and says why if the write fails. */
function DescriptionSection({
  pr,
  hostLabel,
  onSave,
}: {
  pr: PR;
  hostLabel: string;
  onSave: ((body: string) => Promise<void>) | null;
}) {
  const html = useMemo(() => renderMarkdown(pr.body), [pr.body]);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!onSave || draft == null || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setDraft(null);
    } catch (e) {
      setError(humanGitError(e));
    } finally {
      setSaving(false);
    }
  };
  const edit =
    onSave && draft == null ? (
      <Button
        variant="ghost"
        size="compact"
        className="text-fg2"
        onClick={() => {
          setError(null);
          setDraft(pr.body);
        }}
      >
        <Pencil aria-hidden />
        Edit
      </Button>
    ) : null;
  return (
    <ReviewSection title="Description" action={edit}>
      {draft != null ? (
        <div data-review-description-editor="" className="flex min-w-0 flex-col gap-2">
          <Textarea
            aria-label="Pull request description"
            value={draft}
            maxLength={60_000}
            autoFocus
            rows={12}
            className="min-h-48 font-mono text-xs leading-5"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
          />
          {error ? <ErrorCallout text={error} /> : null}
          <div className="flex items-center gap-2">
            <span className="text-fg3 text-3xxs flex-1 leading-4">Saves to {hostLabel}</span>
            <Button variant="ghost" size="compact" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="compact"
              aria-keyshortcuts="Meta+Enter Control+Enter"
              loading={saving}
              disabled={draft === pr.body}
              onClick={() => void save()}
            >
              Save
              <ButtonShortcut keys="⌘↵" />
            </Button>
          </div>
        </div>
      ) : pr.body.trim() ? (
        <div className="zeros-agent-md [&_.zeros-md-prose>:first-child]:mt-0 [&_.zeros-md-prose>:last-child]:mb-0">
          <div className="zeros-md-prose text-sm" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      ) : (
        <p className="text-fg3 m-0 text-xs">No description yet.</p>
      )}
    </ReviewSection>
  );
}
