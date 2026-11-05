// Actual ReviewView, live caches, inline review hook and Pierre renderer. Only
// provider/engine I/O is synthetic; no request reaches a workspace or GitHub.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { createRoot } from "react-dom/client";
import type {
  PrInlineReview,
  PrReviewDiff,
} from "@zeros/protocol/github-review";
import { getPrInlineReview } from "../platform/github-review";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import type { PR } from "../platform/git";
import { TooltipProvider } from "../shared/ui/primitives";
import {
  githubReviewCache,
  githubReviewKey,
} from "../features/code-review/github-review-cache";
import type { ReviewProvider } from "../shell/pr/review-provider";
import {
  peekReviewLiveData,
  prefetchReviewLiveData,
} from "../shell/workbench/tabs/review-data";
import { ReviewView } from "../shell/workbench/tabs/review-tab";
import type { ReviewSubtab } from "../shell/workbench/tab-model";
import { GitStatusCard } from "../shell/pr/git-status-card";

const workspaceId = "review-comparison-fixture";
const cwd = "/fixture/review-comparison";
const comparisons = new Map<number, { baseSha: string; headSha: string }>();
const comparisonFor = (prNumber: number) => {
  let comparison = comparisons.get(prNumber);
  if (!comparison) {
    comparison = { baseSha: "b".repeat(40), headSha: "a".repeat(40) };
    comparisons.set(prNumber, comparison);
  }
  return comparison;
};
const diffReads: { prNumber: number; baseSha: string; headSha: string }[] = [];
const inlineReads: number[] = [];
// Local Git refresh generation (agent file writes, terminal edits).
let localRefresh = 0;
const posts: Record<string, unknown>[] = [];
const held = new Map<number, () => void>();
const fixtureParams = new URLSearchParams(location.search);
let holdDiffs = fixtureParams.has("holdDiffs");
let releaseMetadata: (() => void) | undefined;
const metadataReady = fixtureParams.has("holdMetadata")
  ? new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    })
  : Promise.resolve();
let currentPr = 42;
let mount = 0;
// `?sub=overview` opens another destination; `?rich` fills Overview with
// checks, reviews, reviewers, labels and merge methods.
let currentSub = (fixtureParams.get("sub") ?? "changes") as ReviewSubtab;
const rich = fixtureParams.has("rich");
const DAY = 86_400_000;

function prFor(prNumber: number): PR {
  return {
    number: prNumber,
    url: `https://github.com/example/fixture/pull/${prNumber}`,
    state: "ready",
    title: "Published comparison fixture",
    body: "",
    authorLogin: "fixture-reviewer",
    baseBranch: "main",
    headBranch: "feature",
    headSha: comparisonFor(prNumber).headSha,
    mergeableState: "clean",
    isMergeable: true,
    createdAt: rich ? Date.now() - 2 * DAY : 1,
    updatedAt: 1,
    mergedAt: null,
    ...(rich
      ? {
          title: "Fix login redirect loop",
          body: "Keeps `returnTo` through the OAuth state.\n\nFixes #31",
          authorLogin: "alex-morgan",
          headBranch: "alex/fix-login",
          additions: 39,
          deletions: 47,
          changedFiles: 4,
          requestedReviewers: [{ login: "priya-shah", avatarUrl: null }],
          assignees: [{ login: "alex-morgan", avatarUrl: null }],
          labels: [
            { name: "bug", color: "d73a4a" },
            { name: "auth", color: "0075ca" },
          ],
        }
      : {}),
  };
}

const provider: ReviewProvider = {
  family: "github",
  hostOrigin: "github.com",
  cacheKey: "github:review-comparison-fixture",
  hostLabel: "GitHub",
  capabilities: {
    reviewNoun: "pull request",
    mergeMethods: rich
      ? [
          { id: "squash", label: "Squash and merge" },
          { id: "merge", label: "Create a merge commit" },
          { id: "rebase", label: "Rebase and merge" },
        ]
      : [],
  },
  authStatus: async () => ({ authenticated: true, login: "fixture-reviewer" }),
  getPr: async ({ reviewRef }) => {
    if (fixtureParams.has("holdMetadata")) await metadataReady;
    return prFor(Number(reviewRef));
  },
  getChecks: async () =>
    rich
      ? {
          total: 7,
          passed: 5,
          pending: 1,
          failed: 1,
          deployments: [],
          checks: [
            { name: "test (ubuntu-latest)", status: "completed", conclusion: "failure", detailsUrl: "https://example.test/run/1", startedAt: null, completedAt: null },
            { name: "lint", status: "in_progress", conclusion: null, detailsUrl: null, startedAt: null, completedAt: null },
            ...["build", "typecheck", "unit", "e2e", "codeql"].map((name) => ({
              name, status: "completed", conclusion: "success", detailsUrl: null, startedAt: null, completedAt: null,
            })),
          ],
        }
      : { total: 0, passed: 0, pending: 0, failed: 0, checks: [], deployments: [] },
  getCommits: async () => [],
  getTimeline: async () =>
    rich
      ? [
          { kind: "review" as const, id: 1, author: "priya-shah", authorAvatarUrl: null, state: "CHANGES_REQUESTED", body: "Please add a test for the SSO path.", url: null, createdAt: Date.now() - DAY },
          { kind: "review" as const, id: 2, author: "sam-lee", authorAvatarUrl: null, state: "APPROVED", body: "", url: null, createdAt: Date.now() - DAY / 2 },
          { kind: "comment" as const, id: 3, author: "alex-morgan", authorAvatarUrl: null, state: "", body: "Addressed.", url: null, createdAt: Date.now() - DAY / 4 },
        ]
      : [],
  getDiff: async ({ reviewRef }) => {
    const prNumber = Number(reviewRef);
    const comparison = comparisonFor(prNumber);
    const marker = `pr-${prNumber}-base-${comparison.baseSha[0]}-head-${comparison.headSha[0]}.ts`;
    const result: PrReviewDiff = {
      ...comparison,
      patch:
        "diff --git a/src/example.ts b/src/example.ts\n" +
        "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,3 @@\n" +
        " export function example() {\n" +
        `-  return '${comparison.baseSha[0]}';\n+  return '${comparison.headSha[0]}';\n }\n` +
        `diff --git a/${marker} b/${marker}\nnew file mode 100644\n` +
        `--- /dev/null\n+++ b/${marker}\n@@ -0,0 +1 @@\n+export const comparison = true;\n`,
    };
    diffReads.push({ prNumber, ...comparison });
    const read = diffReads.length;
    if (holdDiffs)
      await new Promise<void>((resolve) => held.set(read, resolve));
    return result;
  },
  addComment: async () => {
    throw new Error("Unexpected conversation write");
  },
  merge: async () => {
    throw new Error("Unexpected merge");
  },
  markReady: async () => {
    throw new Error("Unexpected mark-ready write");
  },
};

window.__ZEROS_NATIVE__ = {
  invoke: async <T,>() => undefined as T,
  on: () => () => {},
};
setActiveBridge({
  status: "connected",
  executionIdentity: { kind: "local" },
  onStatusChange: () => () => {},
  on: () => () => {},
  request: async ({
    op,
    params,
  }: {
    op: string;
    params: Record<string, unknown>;
  }) => {
    let result: unknown;
    if (op === "gh.prInlineReview") {
      inlineReads.push(Number(params.prNumber));
      if (fixtureParams.has("holdMetadata")) await metadataReady;
      result = {
        ...comparisonFor(Number(params.prNumber)),
        threads: [],
        annotations: [],
        threadsTruncated: false,
        annotationsTruncated: false,
        annotationError: null,
      } satisfies PrInlineReview;
    } else if (op === "gh.prComment") {
      posts.push(params);
      result = { id: posts.length, url: "https://github.com/example/fixture" };
    } else if (op === "workspace.list") {
      result = { workspaces: [] };
    } else if (op === "codeReview.list") {
      result = {
        workspaceId,
        viewerActorId: "fixture-reviewer",
        threads: rich
          ? [
              {
                id: "finding-1",
                workspaceId,
                anchor: { path: "src/auth/login.ts", side: "new", startLine: 18, endLine: 18, revision: "fixture" },
                comments: [
                  {
                    id: "finding-1-c",
                    author: { id: "claude", name: "Claude", kind: "agent", provider: "claude" },
                    body: "Protocol-relative URLs pass `safeRedirect`",
                    createdAt: 1,
                  },
                ],
                resolved: false,
                version: 1,
                createdAt: 1,
                updatedAt: 1,
              },
              {
                id: "finding-2",
                workspaceId,
                anchor: { path: "src/auth/session.test.ts", side: "new", startLine: 24, endLine: 24, revision: "fixture" },
                comments: [
                  {
                    id: "finding-2-c",
                    author: { id: "codex", name: "Codex", kind: "agent", provider: "codex" },
                    body: "No test for the 12-hour expiry boundary",
                    createdAt: 2,
                  },
                ],
                resolved: false,
                version: 1,
                createdAt: 2,
                updatedAt: 2,
              },
            ]
          : [],
      };
    } else {
      throw new Error(`Unexpected fixture operation: ${op}`);
    }
    return { type: "WORKSPACE_RESPONSE", op, result };
  },
} as unknown as RuntimeClient);

async function refreshInline(prNumber: number): Promise<void> {
  await githubReviewCache.load(
    githubReviewKey(workspaceId, prNumber),
    () => getPrInlineReview({ workspaceId, prNumber }),
    { force: true },
  );
}
async function prefetch(prNumber: number): Promise<void> {
  await Promise.all([
    prefetchReviewLiveData(provider, workspaceId, prNumber),
    refreshInline(prNumber),
  ]);
}

const root = createRoot(document.getElementById("root")!);
function render(): void {
  root.render(
    <TooltipProvider>
      <main
        data-testid="review-comparison-harness"
        className="bg-bg1 text-fg1 h-screen"
      >
        <ReviewView
          key={mount}
          provider={provider}
          workspaceId={workspaceId}
          cwd={cwd}
          baseBranch="main"
          branch="feature"
          prNumber={currentPr}
          prUrl={prFor(currentPr).url}
          repoSlug={null}
          refreshKey={localRefresh}
          active
          agentWorking={false}
          sub={currentSub}
          onSubChange={(next) => {
            currentSub = next;
            render();
          }}
          gitStatus={
            rich ? (
              <GitStatusCard
                state={{ kind: "up-to-date", label: "Branch is up to date", tone: "success", actions: [] }}
                checklist={{ uncommitted: 0, ahead: 0, behind: 0, conflicts: false, behindBase: 0, baseBranch: "main" }}
                actionState={() => ({ running: false, disabled: false, reason: null })}
                onAction={() => {}}
              />
            ) : undefined
          }
        />
      </main>
    </TooltipProvider>,
  );
}
Object.assign(window, {
  reviewComparisonFixture: {
    diffReads,
    inlineReads,
    posts,
    bumpLocalRefresh: () => {
      localRefresh += 1;
      render();
    },
    metadata: () => ({
      pr: peekReviewLiveData(provider, workspaceId, currentPr).pr,
      inline:
        githubReviewCache.getSnapshot(githubReviewKey(workspaceId, currentPr))
          .data ?? null,
    }),
    releaseMetadata: (base?: string) => {
      if (base)
        comparisons.set(currentPr, {
          ...comparisonFor(currentPr),
          baseSha: base.repeat(40),
        });
      releaseMetadata?.();
    },
    holdDiffs: () => {
      holdDiffs = true;
    },
    releaseDiff: (read: number) => {
      const release = held.get(read);
      if (!release) throw new Error(`No held comparison read ${read}`);
      held.delete(read);
      release();
    },
    refreshReview: async (base: string, head?: string) => {
      const previous = comparisonFor(currentPr);
      comparisons.set(currentPr, {
        baseSha: base.repeat(40),
        headSha: head ? head.repeat(40) : previous.headSha,
      });
      await refreshInline(currentPr);
    },
    refreshPrHead: async (head: string) => {
      comparisons.set(currentPr, {
        ...comparisonFor(currentPr),
        headSha: head.repeat(40),
      });
      await prefetchReviewLiveData(provider, workspaceId, currentPr, {
        force: true,
      });
    },
    selectPr: async (prNumber: number) => {
      await prefetch(prNumber);
      currentPr = prNumber;
      render();
    },
    remount: () => {
      mount += 1;
      render();
    },
  },
});
if (!fixtureParams.has("cold")) await prefetch(currentPr);
render();
