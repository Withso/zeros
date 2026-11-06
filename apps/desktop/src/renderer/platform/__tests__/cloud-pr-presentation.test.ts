import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ request: vi.fn(), forget: vi.fn() }));
vi.mock("../cloud-workspaces", () => ({ cloudAccountRequest: f.request }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 1 }));
vi.mock("../../state/cloud-workspace-catalog", () => ({ refreshCloudWorkspace: async () => {} }));
vi.mock("../../shell/pr/pr-cache-forget", () => ({ forgetPrCachesForWorkspace: f.forget }));
vi.mock("../../features/code-review/review-cache-forget", () => ({ forgetReviewCachesForFolders: f.forget }));
import { clearCloudGithubPr, cloudGithubPrAuthority, requestCloudGithubPr } from "../cloud-github-pr";
import { publishCloudGithubPrCapabilities } from "../cloud-github-pr-capability";
import { cloudGithubPrScope } from "../cloud-github-pr-scope";
import { cloudWorkspaceKey } from "../bridge/cloud-workspace-key";
import type { CloudWorkspaceDocument } from "../cloud-workspace-contract";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const key = cloudWorkspaceKey(target);
const authority = { connectionGeneration: "generation-1", repositoryId: "42", repository: "example/project",
  branch: "work", baseBranch: "main", contextRevision: "boot-1:3" };
const pr = { number: 7, headSha: "a".repeat(40), baseSha: "b".repeat(40) };
const document = (headSha = pr.headSha, branch = "work"): CloudWorkspaceDocument => ({
  id: target.workspaceId, organizationId: target.organizationId, teamId: target.organizationId,
  name: "Example", createdBy: target.workspaceId, placement: "cloud", status: "ready",
  repository: { forge: "github.com", owner: "example", name: "project", revision: "main" },
  capabilities: { githubPullRequests: 1, canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
  github: { repositoryId: "42", branch, baseBranch: "main", headSha, prNumber: 7, prState: "ready", prUrl: "https://github.com/example/project/pull/7" },
  generation: { number: 1, architecture: "x86_64", resources: { cpuMillicores: 1000, memoryMiB: 1024, storageMiB: 1024 }, observedState: "running", lastObservedAt: null },
  version: 1, error: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deletedAt: null,
});

beforeEach(() => {
  clearCloudGithubPr();
  publishCloudGithubPrCapabilities([document()]);
  vi.clearAllMocks();
  f.request.mockResolvedValue({ authority, result: pr });
});

it("retains a branch's presentation across HEAD changes but requires fresh mutation authority", async () => {
  await requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
  const scope = cloudGithubPrScope(key);
  publishCloudGithubPrCapabilities([document("c".repeat(40))]);
  expect(cloudGithubPrScope(key)).toBe(scope);
  expect(f.forget).not.toHaveBeenCalled();
  expect(cloudGithubPrAuthority(target)).toBeUndefined();
  await expect(requestCloudGithubPr(target, "gh.prMarkReady", { prNumber: 7 })).rejects.toThrow(/Refresh/);
  const updated = { ...authority, contextRevision: "boot-1:4" };
  f.request.mockResolvedValue({ authority: updated, result: { ...pr, headSha: "c".repeat(40) } });
  await requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
  expect(cloudGithubPrScope(key)).toBe(scope);
  expect(f.forget).not.toHaveBeenCalled();
  expect(cloudGithubPrAuthority(target)).toEqual(updated);
});

it("retains same-branch presentation on a fresh checkout revision even before the catalog catches up", async () => {
  await requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
  const scope = cloudGithubPrScope(key);
  f.request.mockResolvedValue({ authority: { ...authority, contextRevision: "boot-1:4" }, result: pr });
  await requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
  expect(cloudGithubPrScope(key)).toBe(scope);
  expect(f.forget).not.toHaveBeenCalled();
});

it("rejects old HEAD responses across A to B to A without clearing the branch presentation", async () => {
  await requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
  const scope = cloudGithubPrScope(key);
  let release!: (value: unknown) => void;
  f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  publishCloudGithubPrCapabilities([document("c".repeat(40))]);
  publishCloudGithubPrCapabilities([document()]);
  release({ authority, result: pr });
  await expect(pending).rejects.toThrow(/changed/);
  expect(cloudGithubPrScope(key)).toBe(scope);
  expect(cloudGithubPrAuthority(target)).toBeUndefined();
});

it.each(["branch", "connection"] as const)("retires presentation when its %s changes", async change => {
  await requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
  const scope = cloudGithubPrScope(key);
  if (change === "branch") publishCloudGithubPrCapabilities([document(pr.headSha, "other")]);
  else {
    f.request.mockResolvedValue({ authority: { ...authority, connectionGeneration: "generation-2" }, result: pr });
    await requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
  }
  expect(cloudGithubPrScope(key)).not.toBe(scope);
  expect(f.forget).toHaveBeenCalled();
});
