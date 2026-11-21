// Every exported gh*/git* function, and every review request, that can reach a
// cloud workspace goes through the routing choke point: called with one
// repository's key of a workspace of several, each request it sends names that
// repository (or it refuses). A new export fails here until it is classified.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  cloud: vi.fn(),
  bridge: vi.fn(),
}));
vi.mock("../cloud-workspaces", () => ({ cloudAccountRequest: f.cloud }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 1 }));
vi.mock("../cloud-github-pr-capability", () => ({
  hasCloudGithubPrCapability: () => true,
  cloudGithubPrCatalogContext: () => "context",
  cloudGithubPrCatalogKeys: () => [],
  onCloudGithubPrContextChange: () => () => {},
}));
vi.mock("../../state/cloud-workspace-catalog", () => ({ refreshCloudWorkspace: vi.fn(async () => {}), cloudWorkspaceDocument: () => undefined }));
vi.mock("../../shell/pr/pr-cache-forget", () => ({ forgetPrCachesForWorkspace: vi.fn() }));
vi.mock("../../features/code-review/review-cache-forget", () => ({ forgetReviewCachesForFolders: vi.fn() }));
vi.mock("../bridge/active-bridge", () => ({
  getActiveBridge: () => ({
    request: (message: unknown) => f.bridge(message),
    requestConnected: (message: unknown) => f.bridge(message),
  }),
}));
import * as git from "../git";
import * as review from "../github-review";
import { clearCloudGithubPr } from "../cloud-github-pr";
import { publishCloudRepositoryLayouts } from "../bridge/cloud-repository-routing";
import { combinedPullRequest, pullRequestTarget } from "../../state/workspace-repositories";
import { planDiscard } from "../../shell/workbench/tabs/discard-file";

const root = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const web = `${root}/web`;
const sha = (c: string) => c.repeat(40);
const authority = { connectionGeneration: "g1", repositoryId: "44", repository: "withso/web", branch: "work", baseBranch: "main", contextRevision: "boot:1" };

beforeEach(() => {
  clearCloudGithubPr();
  f.cloud.mockReset().mockImplementation(async () => ({ authority, result: { number: 9, headSha: sha("a"), baseSha: sha("b") } }));
  f.bridge.mockReset().mockImplementation(async () => ({ type: "WORKSPACE_RESPONSE", result: {} }));
  publishCloudRepositoryLayouts(new Map([[root, { repositories: [{ repository: "withso/api", folder: "api" }, { repository: "withso/web", folder: "web" }] }]]));
});

type Call = (id: string) => Promise<unknown>;
/** Routed: sends only requests that name the repository of the id it is given. */
const routed: Record<string, Call> = {
  gitStatus: id => git.gitStatus(id),
  gitChangeCounts: id => git.gitChangeCounts(id),
  gitChangeLineCounts: id => git.gitChangeLineCounts(id),
  gitHasChanges: id => git.gitHasChanges(id),
  gitDiff: id => git.gitDiff({ workspaceId: id, filePath: "a.ts" }),
  gitShowCommit: id => git.gitShowCommit({ workspaceId: id, sha: sha("c") }),
  gitLog: id => git.gitLog({ workspaceId: id }),
  gitListBranches: id => git.gitListBranches(id),
  gitListRemoteBranches: id => git.gitListRemoteBranches(id),
  gitRenameBranch: id => git.gitRenameBranch({ workspaceId: id, newName: "next" }),
  gitStage: id => git.gitStage({ workspaceId: id, paths: ["a.ts"] }),
  gitUnstage: id => git.gitUnstage({ workspaceId: id, paths: ["a.ts"] }),
  gitCommit: id => git.gitCommit({ workspaceId: id, message: "m" }),
  gitFetch: id => git.gitFetch({ workspaceId: id }),
  gitPush: id => git.gitPush({ workspaceId: id }),
  gitPull: id => git.gitPull({ workspaceId: id, strategy: "rebase" }),
  gitChangeTargetBranch: id => git.gitChangeTargetBranch({ workspaceId: id, newTarget: "main" }),
  gitDiscard: id => git.gitDiscard({ workspaceId: id, paths: ["a.ts"] }),
  gitClean: id => git.gitClean({ workspaceId: id, paths: ["a.ts"] }),
  ghAuthStatus: id => git.ghAuthStatus(id),
  ghRepoAccess: id => git.ghRepoAccess(id),
  ghPrCreate: id => git.ghPrCreate({ workspaceId: id, title: "t", body: "b" }),
  ghPrMarkReady: id => git.ghPrMarkReady({ workspaceId: id, prNumber: 9 }),
  ghPrUpdate: id => git.ghPrUpdate({ workspaceId: id, prNumber: 9, body: "b" }),
  ghPrGet: id => git.ghPrGet({ workspaceId: id, prNumber: 9 }),
  ghPrSync: id => git.ghPrSync(id),
  ghPrList: id => git.ghPrList({ workspaceId: id, state: "open" }),
  ghPrMerge: id => git.ghPrMerge({ workspaceId: id, prNumber: 9, method: "squash" }),
  ghPrChecks: id => git.ghPrChecks({ workspaceId: id, prNumber: 9 }),
  ghPrRerunFailed: id => git.ghPrRerunFailed({ workspaceId: id, prNumber: 9, headSha: sha("a") }),
  ghPrCommits: id => git.ghPrCommits({ workspaceId: id, prNumber: 9 }),
  ghPrReviews: id => git.ghPrReviews({ workspaceId: id, prNumber: 9 }),
  ghPrComment: id => git.ghPrComment({ workspaceId: id, prNumber: 9, body: "b" }),
  getPrInlineReview: id => review.getPrInlineReview({ workspaceId: id, prNumber: 9 }),
  getPrReviewDiff: id => review.getPrReviewDiff({ workspaceId: id, prNumber: 9 }),
  postPrLineComment: id => review.postPrLineComment({ workspaceId: id, prNumber: 9, body: "b", path: "a.ts", side: "RIGHT", line: 1, commitSha: sha("a"), baseSha: sha("b") }),
  replyPrReviewThread: id => review.replyPrReviewThread({ workspaceId: id, prNumber: 9, body: "b", commentId: 1 }),
  setPrReviewThreadResolved: id => review.setPrReviewThreadResolved({ workspaceId: id, prNumber: 9, threadId: "t1", resolved: true }),
};
/** Addressed by a repository root, not a workspace id: a workspace of several has no one root to honor, so it is refused. */
const byRoot: Record<string, Call> = {
  gitListAllBranches: id => git.gitListAllBranches({ repoSlug: "withso/web", repoRoot: id }),
  gitRepoBranchCatalog: id => git.gitRepoBranchCatalog({ repoRoot: id }),
  gitInitInPlace: id => git.gitInitInPlace(id),
  ghRepositoryOwnerAvatar: id => git.ghRepositoryOwnerAvatar(id),
  ghPublishRepo: id => git.ghPublishRepo({ repoRoot: id, name: "n" }),
};
/** Take no workspace: the account's GitHub connection, or a repository named outright. */
const noWorkspace = new Set(["ghAuthSnapshot", "ghMethodSelect", "ghPatConnect", "ghPatRestore", "ghAppConnect", "ghAppCancel",
  "ghMethodDisconnect", "ghListOwners", "ghCheckRepoName", "ghBranchList", "gitErrorDescription"]);

function sent() {
  return [
    ...f.cloud.mock.calls.map(([path, , init]) => ({ via: "cloud",
      workspaceId: `cloud://11111111-1111-4111-8111-111111111111/${/workspaces\/([^/]+)\//.exec(path as string)![1]}`,
      repository: (init as { body: { repository?: string } }).body.repository })),
    ...f.bridge.mock.calls.map(([message]) => {
      const params = (message as { params: { workspaceId?: string; repository?: string } }).params;
      return { via: "bridge", workspaceId: params.workspaceId, repository: params.repository };
    }),
  ];
}

describe("the routing choke point for a workspace of several repositories", () => {
  it("classifies every exported gh*/git* function and every review request", () => {
    const exported = [...Object.keys(git).filter(name => /^(gh|git)[A-Z]/.test(name) && typeof (git as Record<string, unknown>)[name] === "function"),
      ...Object.keys(review).filter(name => typeof (review as Record<string, unknown>)[name] === "function")].sort();
    expect(exported).toEqual([...Object.keys(routed), ...Object.keys(byRoot), ...noWorkspace].sort());
  });

  it("nothing but the choke point sends a cloud pull request request or reads its authority by target", () => {
    const renderer = join(__dirname, "../..");
    const files = (readdirSync(renderer, { recursive: true }) as string[])
      .filter(file => /\.tsx?$/.test(file) && !/__tests__|\.test\./.test(file) && !file.startsWith("harnesses"));
    const callers = files.filter(file => /\b(requestCloudGithubPr|cloudGithubPrAuthority)\(/.test(readFileSync(join(renderer, file), "utf8")))
      .map(file => relative(renderer, join(renderer, file)));
    expect(callers.sort()).toEqual(["platform/bridge/workspace-bridge.ts", "platform/cloud-github-pr.ts"]);
  });

  it.each(Object.keys(routed))("%s on the second repository's key names that repository on every request", async name => {
    // A write needs this repository's own pull request read first.
    await git.ghPrGet({ workspaceId: web, prNumber: 9 }).catch(() => {});
    f.cloud.mockClear(); f.bridge.mockClear();
    await routed[name]!(web).catch(() => {});
    const requests = sent();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests).toEqual(requests.map(request => ({ ...request, workspaceId: root, repository: "withso/web" })));
  });

  it.each(Object.keys(byRoot))("%s refuses a repository's key, and the workspace's, before sending anything", async name => {
    for (const id of [web, root]) {
      // The owner avatar is best effort: its refusal reads as no avatar.
      const outcome = await byRoot[name]!(id).then(value => value, (error: Error) => error.message);
      expect(name === "ghRepositoryOwnerAvatar" ? outcome : String(outcome)).toEqual(name === "ghRepositoryOwnerAvatar" ? null : expect.stringMatching(/several repositories/));
    }
    expect(sent()).toEqual([]);
  });

  it("refuses a pull request number on the bare workspace key: it may be another repository's", async () => {
    for (const call of [routed.ghPrGet!, routed.ghPrMerge!, routed.ghPrMarkReady!, routed.ghPrComment!, routed.ghPrRerunFailed!, routed.getPrInlineReview!])
      await expect(call(root)).rejects.toThrow(/Choose which of this workspace's repositories/);
    expect(sent()).toEqual([]);
  });

  it("refuses a folder that is not one of the repositories, never serving it as the first", async () => {
    await expect(routed.ghPrGet!(`${root}/docs`)).rejects.toThrow(/not one of the workspace's repositories/);
    await expect(routed.gitStatus!(`${root}/docs`)).rejects.toThrow(/not one of the workspace's repositories/);
    expect(sent()).toEqual([]);
  });

  it("syncing the workspace syncs each repository's pull request; its connection reads the first", async () => {
    await git.ghPrSync(root);
    expect(sent().map(request => request.repository)).toEqual(["withso/api", "withso/web"]);
    f.cloud.mockClear();
    await git.ghAuthStatus(root);
    expect(sent().map(request => request.repository)).toEqual(["withso/api"]);
  });

  it("a workspace of one repository is unchanged: its key, no repository named", async () => {
    const one = "cloud://11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
    await git.ghPrGet({ workspaceId: one, prNumber: 9 });
    await git.gitStatus(one);
    expect(sent()).toEqual([{ via: "cloud", workspaceId: one, repository: undefined }, { via: "bridge", workspaceId: one, repository: undefined }]);
  });

  it("a card's Merge acts on the repository its combined pull request mark comes from", async () => {
    const repositories = [
      { repository: "withso/api", folder: "api", target: `${root}/api`, branch: "work", baseBranch: "main", prNumber: 9, prState: "merged" as const, prUrl: "https://github.com/withso/api/pull/9" },
      { repository: "withso/web", folder: "web", target: web, branch: "work", baseBranch: "main", prNumber: 9, prState: "ready" as const, prUrl: "https://github.com/withso/web/pull/9" },
    ];
    const workspace = { id: root, path: root, repoRoot: root, repoSlug: "cloud-project", branch: "work", baseBranch: "main", repositories,
      ...combinedPullRequest(repositories) } as unknown as git.Workspace;
    expect(pullRequestTarget(workspace)).toBe(web);
    await git.ghPrGet({ workspaceId: pullRequestTarget(workspace), prNumber: 9 });
    await git.ghPrMerge({ workspaceId: pullRequestTarget(workspace), prNumber: workspace.prNumber!, method: "squash" });
    expect(sent().map(request => request.repository)).toEqual(["withso/web", "withso/web"]);
    // On the bare key the number is refused: it is web's #9 here, and api has a #9 too.
    await expect(git.ghPrMerge({ workspaceId: root, prNumber: 9, method: "squash" })).rejects.toThrow(/Choose which/);
  });

  it("a project-folder file's status comes back in the project folder, so Discard plans on the file it was asked about", async () => {
    f.bridge.mockImplementation(async () => ({ type: "WORKSPACE_RESPONSE",
      result: { staged: [{ path: "new.ts", status: "added" }], unstaged: [{ path: "moved.ts", oldPath: "old.ts", status: "renamed" }], untracked: ["scratch.ts"], conflicted: [] } }));
    const status = await git.gitStatus(root, { paths: ["web/scratch.ts"], includeTracking: false });
    expect(sent()).toEqual([{ via: "bridge", workspaceId: root, repository: "withso/web" }]);
    expect(f.bridge.mock.calls[0]![0].params.paths).toEqual(["scratch.ts"]);
    expect(planDiscard(status, "web/scratch.ts")).toMatchObject({ operation: "clean", isNewFile: true });
    expect(planDiscard(status, "web/new.ts")).toMatchObject({ operation: "unstage-clean" });
    expect(planDiscard(status, "web/moved.ts")).toMatchObject({ operation: "discard", restorePaths: ["web/old.ts", "web/moved.ts"] });
  });
});
