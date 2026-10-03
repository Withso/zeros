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
    createdAt: 1,
    updatedAt: 1,
    mergedAt: null,
  };
}

const provider: ReviewProvider = {
  family: "github",
  hostOrigin: "github.com",
  cacheKey: "github:review-comparison-fixture",
  hostLabel: "GitHub",
  capabilities: { reviewNoun: "pull request", mergeMethods: [] },
  authStatus: async () => ({ authenticated: true, login: "fixture-reviewer" }),
  getPr: async ({ reviewRef }) => {
    if (fixtureParams.has("holdMetadata")) await metadataReady;
    return prFor(Number(reviewRef));
  },
  getChecks: async () => ({
    total: 0,
    passed: 0,
    pending: 0,
    failed: 0,
    checks: [],
    deployments: [],
  }),
  getCommits: async () => [],
  getTimeline: async () => [],
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
      result = { workspaceId, threads: [], viewerActorId: "fixture-reviewer" };
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
          refreshKey={0}
          active
          agentWorking={false}
          sub="changes"
          onSubChange={() => {}}
        />
      </main>
    </TooltipProvider>,
  );
}
Object.assign(window, {
  reviewComparisonFixture: {
    diffReads,
    posts,
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
