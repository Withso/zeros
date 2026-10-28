import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  request: vi.fn(),
  generation: 1,
  enabled: true,
  branch: "work",
  refresh: vi.fn(),
  forget: vi.fn(),
}));
vi.mock("../cloud-workspaces", () => ({ cloudAccountRequest: f.request }));
vi.mock("../../features/team/team-store", () => ({
  getOrganizationStoreGeneration: () => f.generation,
}));
vi.mock("../cloud-github-pr-capability", () => ({
  hasCloudGithubPrCapability: () => f.enabled,
  cloudGithubPrCatalogContext: () => (f.enabled ? f.branch : undefined),
  cloudGithubPrCatalogKeys: () => [],
  onCloudGithubPrContextChange: () => () => {},
}));
vi.mock("../../state/cloud-workspace-catalog", () => ({
  refreshCloudWorkspace: f.refresh,
}));
vi.mock("../../shell/pr/pr-cache-forget", () => ({
  forgetPrCachesForWorkspace: f.forget,
}));
vi.mock("../../features/code-review/review-cache-forget", () => ({
  forgetReviewCachesForFolders: f.forget,
}));
import { clearCloudGithubPr, requestCloudGithubPr } from "../cloud-github-pr";
import {
  cloudGithubPrScope,
  subscribeCloudGithubPrScope,
} from "../cloud-github-pr-scope";

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const authority = {
  connectionGeneration: "generation-1",
  repositoryId: "42",
  repository: "example/project",
  branch: "work",
  baseBranch: "main",
  contextRevision: "boot-1:3",
};
const pr = { number: 7, headSha: "a".repeat(40), baseSha: "b".repeat(40) };
beforeEach(() => {
  clearCloudGithubPr();
  vi.resetAllMocks();
  f.generation = 1;
  f.enabled = true;
  f.branch = "work";
  f.refresh.mockResolvedValue(undefined);
  f.request.mockResolvedValue({ authority, result: pr });
});
describe("cloud PR transport", () => {
  it("reads through the control plane without a connect or wake request", async () => {
    await expect(
      requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 }),
    ).resolves.toEqual(pr);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]?.[0]).toBe(
      `/v1/cloud-v2/workspaces/${target.workspaceId}/github`,
    );
  });
  it("fails closed for older backends and unknown operations", async () => {
    f.enabled = false;
    await expect(
      requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 }),
    ).rejects.toThrow(/not available/i);
    f.enabled = true;
    await expect(
      requestCloudGithubPr(target, "gh.unknown", {}),
    ).rejects.toThrow(/not available/i);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("uses the workspace binding for PR suggestions instead of accepting a renderer repository override", async () => {
    f.request.mockResolvedValue({ authority, result: [pr] });
    await expect(
      requestCloudGithubPr(target, "gh.prList", {
        workspaceId: "ignored",
        originUrl: "https://github.com/another/repository.git",
        owner: "another",
        repo: "repository",
        state: "open",
      }),
    ).resolves.toEqual([pr]);
    expect(f.request.mock.calls[0]?.[2].body.params).toEqual({ state: "open" });
  });
  it.each(["branch", "capability"])(
    "rejects a late read when the catalog changes its %s",
    async (change) => {
      let release!: (value: unknown) => void;
      f.request.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const pending = requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
      await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
      if (change === "branch") f.branch = "another-branch";
      else f.enabled = false;
      release({ authority, result: pr });
      await expect(pending).rejects.toThrow(/changed/i);
      expect(f.refresh).not.toHaveBeenCalled();
    },
  );
  it("uses the displayed connection, repository, branch and revisions for a write", async () => {
    await requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
    f.request.mockResolvedValue({ authority, result: { sha: "c".repeat(40) } });
    await requestCloudGithubPr(target, "gh.prMerge", {
      prNumber: 7,
      method: "squash",
    });
    expect(f.request.mock.calls[1]?.[2].body).toEqual({
      op: "gh.prMerge",
      expected: authority,
      params: {
        prNumber: 7,
        method: "squash",
        headSha: pr.headSha,
        baseSha: pr.baseSha,
      },
    });
  });
  it("requires a fresh read after changing the connection and ignores late replies from its prior generation", async () => {
    let release!: (value: unknown) => void;
    f.request.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    clearCloudGithubPr(target.organizationId);
    release({ authority, result: pr });
    await expect(pending).rejects.toThrow(/changed/i);
    await expect(
      requestCloudGithubPr(target, "gh.prMerge", {
        prNumber: 7,
        method: "squash",
      }),
    ).rejects.toThrow(/refresh/i);
  });
  it("fences account A → B → A during a held request", async () => {
    let release!: (value: unknown) => void;
    f.request.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    f.generation += 2;
    release({ authority, result: pr });
    await expect(pending).rejects.toThrow(/changed/i);
  });
  it("coalesces reads for the same exact key without sharing across workspaces", async () => {
    let release!: (value: unknown) => void;
    f.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const one = requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
    const two = requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
    release({ authority, result: pr });
    await Promise.all([one, two]);
    f.request.mockResolvedValue({ authority, result: pr });
    await requestCloudGithubPr(
      { ...target, workspaceId: "33333333-3333-4333-8333-333333333333" },
      "gh.prGet",
      { prNumber: 7 },
    );
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("preserves a confirmed mutation when the following catalog refresh fails", async () => {
    await requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
    f.refresh.mockRejectedValue(new Error("Temporarily offline"));
    await expect(
      requestCloudGithubPr(target, "gh.prMarkReady", { prNumber: 7 }),
    ).resolves.toEqual(pr);
  });
  it("retires mounted presentation when the connection changes, even without a cached PR", () => {
    const key = `cloud://${target.organizationId}/${target.workspaceId}`;
    const previous = cloudGithubPrScope(key),
      listener = vi.fn();
    const stop = subscribeCloudGithubPrScope(listener);
    clearCloudGithubPr(target.organizationId);
    expect(cloudGithubPrScope(key)).not.toBe(previous);
    expect(listener).toHaveBeenCalled();
    stop();
  });
  it("acknowledges an accepted mutation without publishing stale data after disconnect", async () => {
    await requestCloudGithubPr(target, "gh.prGet", { prNumber: 7 });
    let release!: (value: unknown) => void;
    f.request.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = requestCloudGithubPr(target, "gh.prMerge", {
      prNumber: 7,
      method: "squash",
    });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    clearCloudGithubPr(target.organizationId);
    release({
      authority,
      authorityCurrent: false,
      result: { sha: "c".repeat(40) },
    });
    await expect(pending).resolves.toEqual({ sha: "c".repeat(40) });
    expect(f.refresh).not.toHaveBeenCalled();
    await expect(
      requestCloudGithubPr(target, "gh.prMerge", {
        prNumber: 7,
        method: "squash",
      }),
    ).rejects.toThrow(/refresh/i);
  });
});
