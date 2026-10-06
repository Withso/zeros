import { afterEach, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import type { EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";
import * as worktree from "../git/worktree";
import type { Workspace } from "../git/types";
import { githubWriteCredential, type GithubWriteCredential } from "../git/github-write-context";
import { scopedCloudGitAuthorEnvironment } from "../git/cloud-git-author";
import type { CloudGithubWriteRequest } from "../cloud-github-write-client";
import type { CloudGitAuthor } from "@zeros/protocol/cloud-agent-execution";

afterEach(() => vi.restoreAllMocks());

it.each(["git.fetch", "git.pull"])("composes the grant and any commit author for managed %s", async op => {
  const engine = new ZerosEngine({ root: "/tmp/zeros-v2-test-managed-git", port: 29920 });
  const state = engine as unknown as {
    cloudWorker: object;
    cloudRuntimeRegistration: object;
    workspace: { lifecycleMutationWorkspaceId(): string | null; handle(): Promise<unknown> };
    handleWorkspaceMessage(message: Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>, client: TransportClient): Promise<void>;
  };
  state.cloudWorker = {};
  vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(null);
  vi.spyOn(worktree, "getWorkspace").mockReturnValue({ branch: "topic", baseBranch: "main" } as Workspace);
  const credential: GithubWriteCredential = { token: "fixture-proxy-capability", owner: "org", repository: "repo",
    expiresAtMs: Date.now() + 60000, gitBaseUrl: "https://api.example.test/git/", apiBaseUrl: "https://api.example.test/api" };
  const githubWriteRequest = vi.fn(async (request: CloudGithubWriteRequest) => request.kind === "redeem" ? credential : null);
  const gitAuthorRequest = vi.fn(async (): Promise<CloudGitAuthor | null> => ({ name: "Test Member", email: "123+member@users.noreply.github.com" }));
  state.cloudRuntimeRegistration = { githubWriteRequest, gitAuthorRequest };
  let observedCredential: GithubWriteCredential | null = null;
  let observedAuthor: Record<string, string> = {};
  const handle = vi.spyOn(state.workspace, "handle").mockImplementation(async () => {
    observedCredential = githubWriteCredential();
    observedAuthor = scopedCloudGitAuthorEnvironment();
    return { ok: true };
  });
  const client: TransportClient = { id: "cloud", kind: "cloud", accountUserId: "actor", authorized: () => true,
    cloudActor: { sessionId: "actor-session", deviceId: "device", role: "developer", fingerprint: "a".repeat(64) },
    send: vi.fn(), close: vi.fn() };
  await state.handleWorkspaceMessage({ type: "WORKSPACE_REQUEST", source: "browser", id: op, timestamp: 1, op,
    params: { workspaceId: "local-main", strategy: "rebase", $cloudGithubWriteGrant: "fixture-grant" } }, client);
  expect(handle).toHaveBeenCalledOnce();
  expect(observedCredential).toBe(credential);
  expect(gitAuthorRequest).toHaveBeenCalledTimes(op === "git.pull" ? 1 : 0);
  expect(observedAuthor).toEqual(op === "git.pull" ? {
    GIT_AUTHOR_NAME: "Test Member", GIT_AUTHOR_EMAIL: "123+member@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Test Member", GIT_COMMITTER_EMAIL: "123+member@users.noreply.github.com",
  } : {});
  expect(githubWriteRequest).toHaveBeenLastCalledWith({ kind: "release", grant: "fixture-grant" });
  expect(githubWriteCredential()).toBeNull();

  handle.mockClear();
  githubWriteRequest.mockClear();
  await state.handleWorkspaceMessage({ type: "WORKSPACE_REQUEST", source: "browser", id: "missing-grant", timestamp: 1, op,
    params: { workspaceId: "local-main", strategy: "rebase" } }, client);
  expect(handle).not.toHaveBeenCalled();
  expect(githubWriteRequest).not.toHaveBeenCalled();
  expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: "WORKSPACE_ERROR", requestId: "missing-grant" }));

  if (op === "git.pull") {
    gitAuthorRequest.mockResolvedValueOnce(null);
    await state.handleWorkspaceMessage({ type: "WORKSPACE_REQUEST", source: "browser", id: "missing-author", timestamp: 1, op,
      params: { workspaceId: "local-main", strategy: "rebase", $cloudGithubWriteGrant: "fixture-grant" } }, client);
    expect(handle).not.toHaveBeenCalled();
    expect(githubWriteRequest).toHaveBeenLastCalledWith({ kind: "release", grant: "fixture-grant" });
    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: "WORKSPACE_ERROR", requestId: "missing-author" }));
  }
});
