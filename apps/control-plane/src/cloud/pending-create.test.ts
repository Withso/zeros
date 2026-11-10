import { expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { GithubTemporaryError } from "../github-availability.js";
import { createPendingSourceResolver, type PendingSourceDeps } from "./pending-create.js";
import type { CloudV2Workspace } from "./store.js";

const workspace = { id: "w", organizationId: "org", creatorUserId: "user", repository: "Example/Project", baseBranch: "main",
  computerBuildId: "build", state: "creating", sourcePending: true } as CloudV2Workspace;
const ids: Record<string, string> = { "example/docs": "41", "example/project": "42", "example/site": "43" };

function fixture() {
  const deps = {
    activeComputer: vi.fn<PendingSourceDeps["activeComputer"]>(async () => ({ buildId: "build", repositories: [
      { repository: "example/docs", defaultBranch: "main" }, { repository: "example/project", defaultBranch: "main" },
      { repository: "example/site", defaultBranch: "main" }] })),
    authorizeBuildRepository: vi.fn<PendingSourceDeps["authorizeBuildRepository"]>(async (_o, _u, _b, repository) =>
      ({ repository, repositoryId: ids[repository]! })),
    remoteHead: vi.fn<PendingSourceDeps["remoteHead"]>(async () => "c".repeat(40)),
    resolve: vi.fn<PendingSourceDeps["resolve"]>(async () => true),
  };
  return { deps, resolve: createPendingSourceResolver(deps) };
}

it("checks the requested repository first with renewal, the rest fresh in order, and reads its branch meanwhile", async () => {
  const f = fixture();
  expect(await f.resolve(workspace)).toEqual({ baseCommit: "c".repeat(40) });
  expect(f.deps.authorizeBuildRepository.mock.calls).toEqual([
    ["org", "user", "build", "example/project", { renew: true }],
    ["org", "user", "build", "example/docs", { fresh: true }],
    ["org", "user", "build", "example/site", { fresh: true }],
  ]);
  expect(f.deps.remoteHead).toHaveBeenCalledWith("org", "user", { repository: "example/project", repositoryId: "42" }, "main");
  expect(f.deps.remoteHead.mock.invocationCallOrder[0]).toBeLessThan(f.deps.authorizeBuildRepository.mock.invocationCallOrder[1]!);
  expect(f.deps.resolve).toHaveBeenCalledWith("w", { sourceRepositoryId: "42", readableRepositoryIds: ["42", "41", "43"], baseCommit: "c".repeat(40) });
});

it("leaves another repository the creator can't read out of the readable set", async () => {
  const f = fixture();
  f.deps.authorizeBuildRepository.mockImplementation(async (_o, _u, _b, repository) => {
    if (repository === "example/docs") throw new HttpError(404, "github_repository_unavailable", "Unavailable");
    return { repository, repositoryId: ids[repository]! };
  });
  expect(await f.resolve(workspace)).toEqual({ baseCommit: "c".repeat(40) });
  expect(f.deps.resolve).toHaveBeenCalledWith("w", expect.objectContaining({ readableRepositoryIds: ["42", "43"] }));
});

it.each([
  ["the Cloud Computer was rebuilt", (f: ReturnType<typeof fixture>) => { f.deps.activeComputer.mockResolvedValue({ buildId: "newer", repositories: [] }); }, "cloud_computer_changed"],
  ["the Cloud Computer is gone", (f: ReturnType<typeof fixture>) => { f.deps.activeComputer.mockResolvedValue(null); }, "cloud_computer_changed"],
  ["the repository left the Computer", (f: ReturnType<typeof fixture>) => {
    f.deps.activeComputer.mockResolvedValue({ buildId: "build", repositories: [{ repository: "example/docs", defaultBranch: "main" }] }); }, "repository_not_installed"],
  ["the requested repository is refused", (f: ReturnType<typeof fixture>) => {
    f.deps.authorizeBuildRepository.mockRejectedValueOnce(new HttpError(403, "github_cloud_access_denied", "Denied")); }, "cloud_source_access_denied"],
  ["the base branch is gone", (f: ReturnType<typeof fixture>) => { f.deps.remoteHead.mockResolvedValue(null); }, "repository_branch_not_found"],
  ["the member lost Pro", (f: ReturnType<typeof fixture>) => {
    f.deps.resolve.mockRejectedValue(new HttpError(403, "pro_required", "Requires Pro")); }, "pro_required"],
  ["the member left the organization", (f: ReturnType<typeof fixture>) => {
    f.deps.resolve.mockRejectedValue(new HttpError(404, "not_found", "Organization not found")); }, "not_found"],
  // Definite answers that aren't a plain refusal fail at once too, instead of
  // retrying for minutes: a synchronous create returns them to the request.
  ["the creator disconnected GitHub", (f: ReturnType<typeof fixture>) => {
    f.deps.authorizeBuildRepository.mockRejectedValueOnce(new HttpError(401, "github_connection_required", "Connect GitHub")); }, "github_connection_required"],
  ["the repository's identity changed", (f: ReturnType<typeof fixture>) => {
    f.deps.authorizeBuildRepository.mockRejectedValueOnce(new HttpError(409, "cloud_source_review_required", "Review")); }, "cloud_source_review_required"],
  ["another repository's identity changed", (f: ReturnType<typeof fixture>) => {
    f.deps.authorizeBuildRepository.mockImplementation(async (_o, _u, _b, repository) => {
      if (repository === "example/site") throw new HttpError(409, "cloud_source_review_required", "Review");
      return { repository, repositoryId: ids[repository]! };
    }); }, "cloud_source_review_required"],
  ["the branch read is refused", (f: ReturnType<typeof fixture>) => {
    f.deps.remoteHead.mockRejectedValue(new HttpError(403, "github_cloud_access_denied", "Denied")); }, "cloud_source_access_denied"],
] as const)("fails the create when %s", async (_case, change, errorCode) => {
  const f = fixture();
  change(f);
  expect(await f.resolve(workspace)).toEqual({ errorCode });
});

it("skips a row that stopped being a pending create meanwhile", async () => {
  const f = fixture(); f.deps.resolve.mockResolvedValue(false);
  expect(await f.resolve(workspace)).toEqual({ skipped: true });
});

it.each([
  ["a GitHub outage on the requested repository", (f: ReturnType<typeof fixture>) => {
    f.deps.authorizeBuildRepository.mockRejectedValueOnce(new GithubTemporaryError("github_unavailable")); }],
  ["a rate limit on another repository", (f: ReturnType<typeof fixture>) => {
    f.deps.authorizeBuildRepository.mockImplementation(async (_o, _u, _b, repository) => {
      if (repository === "example/site") throw new GithubTemporaryError("github_rate_limited");
      return { repository, repositoryId: ids[repository]! };
    }); }],
  ["an unavailable branch read", (f: ReturnType<typeof fixture>) => { f.deps.remoteHead.mockRejectedValue(new GithubTemporaryError("github_unavailable")); }],
  ["a busy database", (f: ReturnType<typeof fixture>) => { f.deps.resolve.mockRejectedValue(new HttpError(503, "database_busy", "Busy")); }],
  ["a connection that changed during the check", (f: ReturnType<typeof fixture>) => {
    f.deps.authorizeBuildRepository.mockRejectedValueOnce(new HttpError(409, "github_authorization_changed", "Changed")); }],
  ["an unexpected error", (f: ReturnType<typeof fixture>) => { f.deps.resolve.mockRejectedValue(new Error("connection reset")); }],
] as const)("throws %s so the lifecycle retries it", async (_case, change) => {
  const f = fixture();
  change(f);
  await expect(f.resolve(workspace)).rejects.toBeInstanceOf(Error);
});
