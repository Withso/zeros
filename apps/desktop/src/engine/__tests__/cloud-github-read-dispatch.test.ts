import { afterEach, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import type { EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";
import { githubReadCanEdit, githubReadTransport } from "../git/github-read-context";

afterEach(() => vi.restoreAllMocks());
it.each(["viewer", "prompter", "developer", "manager", "owner"] as const)("binds v4 PR reads to the exact %s actor", async role => {
  const engine = new ZerosEngine({ root: "/tmp/zeros-v2-test-github-read", port: 29920 });
  const state = engine as unknown as {
    cloudWorker: object; cloudRuntimeRegistration: object;
    workspace: { lifecycleMutationWorkspaceId(): string | null; handle(): Promise<unknown> };
    handleWorkspaceMessage(message: Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>, client: TransportClient): Promise<void>;
  };
  state.cloudWorker = { version: 4 };
  vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(null);
  const githubReadRequest = vi.fn(async () => Response.json({ number: 7 }));
  state.cloudRuntimeRegistration = { githubReadRequest };
  vi.spyOn(state.workspace, "handle").mockImplementation(async () => {
    expect(githubReadCanEdit()).toBe(["developer", "manager", "owner"].includes(role));
    return (await githubReadTransport()!("https://api.github.com/repos/org/repo/pulls/7")).json();
  });
  const client: TransportClient = { id: "cloud", kind: "cloud", accountUserId: "actor", authorized: () => true,
    cloudActor: { sessionId: "exact-actor-session", deviceId: "device", role, fingerprint: "a".repeat(64) }, send: vi.fn(), close: vi.fn() };
  await state.handleWorkspaceMessage({ type: "WORKSPACE_REQUEST", source: "browser", id: "read", timestamp: 1,
    op: "gh.prGet", params: { workspaceId: "local-main", prNumber: 7 } }, client);
  expect(githubReadRequest).toHaveBeenCalledExactlyOnceWith("exact-actor-session", "https://api.github.com/repos/org/repo/pulls/7", undefined);
  expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: "WORKSPACE_RESPONSE", requestId: "read" }));
  expect(githubReadTransport()).toBeUndefined();
});
