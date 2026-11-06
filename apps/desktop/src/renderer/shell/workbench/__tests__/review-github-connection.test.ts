import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubAuthSnapshot } from "@zeros/protocol/github-auth";
import type { PR } from "../../../platform/git";
import { workspaceOp } from "../../../platform/bridge/workspace-bridge";
import { ghAuthStatusCache } from "../../../state/read-caches";
import { forgetPrCachesForWorkspace } from "../../pr/pr-cache-forget";
import type { ReviewProvider } from "../../pr/review-provider";
import { prefetchReviewLiveData } from "../tabs/review-data";
import { ReviewView } from "../tabs/review-tab";
import { describeWorkbenchFailure, type WorkbenchSource } from "../tab-status-model";

const fixture = vi.hoisted(() => ({ sources: [] as Array<[WorkbenchSource, string | undefined]> }));
vi.mock("../tab-status", () => ({
  useWorkbenchStatusSource: (source: WorkbenchSource, owner?: string) => {
    fixture.sources.push([source, owner]);
    return true;
  },
  WorkbenchEmptyState: () => null,
  WorkbenchTabToolbar: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/renderer/features/code-review/use-github-review", () => ({
  useGithubReview: () => ({ source: undefined, snapshot: undefined, refresh: async () => {}, error: undefined, notice: undefined }),
}));
vi.mock("@/renderer/state/store", () => ({
  useWorkspaceStore: (select: (state: { activeChatId: null }) => unknown) => select({ activeChatId: null }),
  useWorkspaceDispatch: () => () => {},
}));
vi.mock("@/renderer/state/use-projects", () => ({ notifyWorkspacesChanged: () => {} }));
vi.mock("@/renderer/features/agent/markdown", () => ({ renderMarkdown: () => "" }));
vi.mock("../../scroll-memory", () => ({ useScrollMemoryRef: () => () => {} }));
vi.mock("../../pr/pr-island-state-store", () => ({ usePrIslandKind: () => null }));
vi.mock("../tabs/review-changes", () => ({ ReviewChangesSection: () => null }));
vi.mock("../tabs/review-commits", () => ({ ReviewCommitsSection: () => null }));
vi.mock("../tabs/review-checks", () => ({ ReviewChecksSection: () => null }));
vi.mock("../tabs/review-timeline", () => ({ ReviewTimelineSection: () => null }));

const LOCAL = "local-review-workspace";
const ORGANIZATION_LOCAL = "organization-local-review-workspace";
const CLOUD = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";

/** Settings in the reported state: the selected GitHub App row kept its login
 * but its refresh binding was refused, while gh CLI is still healthy. */
const reauthorize: GithubAuthSnapshot = {
  selectedMethod: "github-app",
  methods: {
    "gh-cli": { method: "gh-cli", health: "connected", configured: true, available: true, login: "octocat" },
    "github-app": {
      method: "github-app", health: "unavailable", configured: true, login: "octocat",
      detail: "This GitHub connection needs to be re-authorized.",
    },
    pat: { method: "pat", health: "not-connected", configured: false },
  },
};

const pr: PR = {
  number: 42, url: "https://github.com/owner/repo/pull/42", state: "ready", title: "Confirmed",
  body: "", authorLogin: "octocat", baseBranch: "main", headBranch: "feature",
  mergeableState: "clean", isMergeable: true, createdAt: 1, updatedAt: 2, mergedAt: null,
};

/** The engine's GitError reaches the renderer as a WORKSPACE_ERROR. Produce the
 * exact object the bridge throws for it rather than a hand-built lookalike. */
async function engineError(code: string, message: string, remediation?: string): Promise<unknown> {
  const bridge = { request: async () => ({ type: "WORKSPACE_ERROR", op: "gh.prGet", code, message, remediation }) };
  return workspaceOp(bridge as never, "gh.prGet", { workspaceId: LOCAL }).catch((error: unknown) => error);
}

function provider(cacheKey: string, overrides: Partial<ReviewProvider>): ReviewProvider {
  return {
    family: "github", hostOrigin: "github.com", cacheKey, hostLabel: "GitHub",
    capabilities: { reviewNoun: "pull request", mergeMethods: [] },
    authStatus: async () => ({ authenticated: true, login: "octocat" }),
    getPr: async () => pr,
    getChecks: async () => ({ checks: [], deployments: [], total: 0, passed: 0, failed: 0, pending: 0 }),
    getCommits: async () => [], getTimeline: async () => [],
    addComment: async () => ({ id: 1, url: "" }), merge: async () => ({ sha: "abc" }), markReady: async () => pr,
    ...overrides,
  };
}

/** Render the real Review body against the real live-data store and return the
 * copy its primary status source would put in the tab's banner. */
async function primaryBanner(review: ReviewProvider, workspaceId: string) {
  await prefetchReviewLiveData(review, workspaceId, 42, { force: true });
  fixture.sources.length = 0;
  renderToStaticMarkup(React.createElement(ReviewView, {
    provider: review, workspaceId, cwd: workspaceId, baseBranch: "main", branch: "feature",
    prNumber: 42, prUrl: null, repoSlug: "owner/repo", refreshKey: 0, active: true,
    agentWorking: false, sub: "description", onSubChange: () => {},
  }));
  const source = fixture.sources.find(([candidate]) => candidate.primary)?.[0];
  expect(source).toBeDefined();
  const status = describeWorkbenchFailure("review", source!.error);
  return { source: source!, status, message: status.message };
}

afterEach(() => {
  for (const id of [LOCAL, ORGANIZATION_LOCAL, CLOUD]) forgetPrCachesForWorkspace(id);
  ghAuthStatusCache.clear();
});

describe.each([
  ["Local Personal", LOCAL],
  ["organization-local", ORGANIZATION_LOCAL],
])("Review GitHub connection banner (%s)", (_owner, workspaceId) => {
  it("names the re-authorization Settings reports instead of a generic load failure", async () => {
    ghAuthStatusCache.setData("auth", reauthorize);
    const { source, status, message } = await primaryBanner(
      provider(`github:reauthorize:${workspaceId}`, { authStatus: async () => ({ authenticated: false }) }),
      workspaceId,
    );
    expect(message).toBe("This GitHub connection needs to be re-authorized.");
    // Retrying cannot fix it; the banner leads to where it is fixed.
    expect(status.command?.label).toBe("Open GitHub settings");
    expect(status.action).toBeUndefined();
    // A refused connection never presents an earlier account's PR content.
    expect(source.hasContent).toBe(false);
  });

  it("asks to connect GitHub only when Settings confirms nothing is connected", async () => {
    ghAuthStatusCache.setData("auth", {
      selectedMethod: "gh-cli",
      methods: {
        "gh-cli": { method: "gh-cli", health: "not-connected", configured: false, available: true, detail: "GitHub CLI is installed but not signed in." },
        "github-app": { method: "github-app", health: "not-connected", configured: false },
        pat: { method: "pat", health: "not-connected", configured: false },
      },
    });
    const { message } = await primaryBanner(
      provider(`github:signed-out:${workspaceId}`, { authStatus: async () => ({ authenticated: false }) }),
      workspaceId,
    );
    expect(message).toBe("Connect GitHub to load this pull request.");
  });

  it("explains a pull request the connection cannot reach", async () => {
    const refused = await engineError(
      "GITHUB_REPO_NOT_INSTALLED",
      "This repository or GitHub resource is not available to the selected connection.",
      "Grant the GitHub connection access to this repository, or verify that the remote still points to the right repository.",
    );
    const { status, message } = await primaryBanner(
      provider(`github:not-installed:${workspaceId}`, { getPr: async () => { throw refused; } }),
      workspaceId,
    );
    expect(message).toBe("Your GitHub connection can't reach this repository.");
    expect(status.command?.label).toBe("Open GitHub settings");
  });

  it("keeps ordinary read failures generic", async () => {
    const { status, message } = await primaryBanner(
      provider(`github:engine:${workspaceId}`, { getPr: async () => { throw new Error("engine disconnected"); } }),
      workspaceId,
    );
    expect(message).toBe("Couldn't load the review.");
    expect(status).toMatchObject({ action: "Retry" });
    expect(status.command).toBeUndefined();
  });
});

describe("Review GitHub connection banner (cloud)", () => {
  it("names the cloud connection instead of the Mac's GitHub methods", async () => {
    // The Mac's App needs re-authorization; that must not describe the cloud.
    ghAuthStatusCache.setData("auth", reauthorize);
    const authStatus = vi.fn(async () => ({ authenticated: false }));
    const refused = await engineError("NOT_AUTHENTICATED", "Reconnect your cloud GitHub connection.");
    const { source, message } = await primaryBanner(
      provider("github:cloud-signed-out", { authStatus, getPr: async () => { throw refused; } }),
      CLOUD,
    );
    expect(authStatus).not.toHaveBeenCalled();
    expect(message).toBe("Reconnect your cloud GitHub connection to load this pull request.");
    expect(source.hasContent).toBe(false);
  });

  it("explains a cloud pull request the connection cannot reach", async () => {
    const refused = Object.assign(new Error("Your connected GitHub account no longer has the required repository access."), {
      code: "GITHUB_FORBIDDEN_SCOPE",
    });
    const { message } = await primaryBanner(
      provider("github:cloud-forbidden", { getPr: async () => { throw refused; } }),
      CLOUD,
    );
    expect(message).toBe("Your cloud GitHub connection can't read this pull request.");
  });
});
