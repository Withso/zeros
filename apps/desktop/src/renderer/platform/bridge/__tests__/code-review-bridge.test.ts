import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveBridge } from "../active-bridge";
import { createCodeReviewThread, listCodeReviewThreads, replyCodeReviewThread, setCodeReviewThreadResolved } from "../code-review-bridge";
import type { RuntimeClient } from "../ws-client";
import { cloudIncoming, cloudOutgoing, type CloudRuntimeScope } from "../cloud-runtime-wire";
import { cloudWorkspaceKey } from "../cloud-workspace-key";
import type { CodeReviewThread } from "@zeros/protocol/code-review";

const thread: CodeReviewThread = {
  id: "thread-one", workspaceId: "A",
  anchor: { path: "example.ts", side: "new", startLine: 2, endLine: 3, revision: "original" },
  comments: [{ id: "comment-one", author: { id: "human:reviewer", name: "Reviewer", kind: "human" }, body: "Please review", createdAt: 1 }],
  resolved: false, version: 1, createdAt: 1, updatedAt: 1,
};
function bridgeFixture(result: unknown = thread) {
  const request = vi.fn(async (message: { op: string }) => ({
    type: "WORKSPACE_RESPONSE", op: message.op,
    result: message.op === "workspace.list" ? { workspaces: [{ id: "A", path: "/workspace/A", repoRoot: "/workspace/A" }] } : message.op === "codeReview.list" ? { workspaceId: "A", threads: [result] } : result,
  }));
  const bridge = { request, executionIdentity: { kind: "local", sidecar: "active" } } as unknown as RuntimeClient;
  setActiveBridge(bridge);
  return { request, bridge };
}
afterEach(() => setActiveBridge(null));
describe("review bridge exact-workspace contract", () => {
  it("resolves cwd to the registered owner for list/create/reply/state requests", async () => {
    const { request } = bridgeFixture();
    expect((await listCodeReviewThreads({ workspaceId: "/workspace/A" })).threads).toEqual([thread]);
    expect(await createCodeReviewThread({ workspaceId: "/workspace/A", anchor: thread.anchor, body: "Please review", requestId: "request-one" })).toEqual(thread);
    await replyCodeReviewThread({ workspaceId: "A", threadId: thread.id, body: "Reply", requestId: "reply-one" });
    await setCodeReviewThreadResolved({ workspaceId: "A", threadId: thread.id, resolved: true, expectedVersion: 1, requestId: "resolve-one" });
    const calls = request.mock.calls.map(([message]) => message);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "codeReview.list", params: { workspaceId: "A" } }),
      expect.objectContaining({ op: "codeReview.create", params: { workspaceId: "A", anchor: thread.anchor, body: "Please review", requestId: "request-one" } }),
      expect.objectContaining({ op: "codeReview.reply", params: { workspaceId: "A", threadId: thread.id, body: "Reply", requestId: "reply-one" } }),
      expect.objectContaining({ op: "codeReview.setResolved", params: { workspaceId: "A", threadId: thread.id, resolved: true, expectedVersion: 1, requestId: "resolve-one" } }),
    ]));
  });
  it("rejects malformed or wrong-owner responses instead of confirming an empty/different snapshot", async () => {
    bridgeFixture({ ...thread, workspaceId: "B" });
    await expect(listCodeReviewThreads({ workspaceId: "A" })).rejects.toThrow(/another workspace/);
    await expect(createCodeReviewThread({ workspaceId: "A", anchor: thread.anchor, body: "Comment" })).rejects.toThrow(/another workspace/);
    bridgeFixture({});
    await expect(listCodeReviewThreads({ workspaceId: "A" })).rejects.toThrow();
  });
  it("preserves structured stale errors and refuses a mutation after a bridge replacement during resolution", async () => {
    const { bridge, request } = bridgeFixture();
    request.mockImplementationOnce(async () => {
      setActiveBridge(null);
      return { type: "WORKSPACE_RESPONSE", op: "workspace.list", result: { workspaces: [{ id: "A", path: "/workspace/A", repoRoot: "/workspace/A" }] } };
    });
    await expect(createCodeReviewThread({ workspaceId: "/workspace/A", anchor: thread.anchor, body: "Comment" })).rejects.toThrow(/connection changed/);
    expect(request).toHaveBeenCalledTimes(1);
    setActiveBridge(bridge);
    request.mockImplementationOnce(async () => ({ type: "WORKSPACE_ERROR", op: "codeReview.setResolved", code: "CODE_REVIEW_STALE", message: "Refresh the review thread" }) as never);
    await expect(setCodeReviewThreadResolved({ workspaceId: "A", threadId: thread.id, resolved: true, expectedVersion: 1 })).rejects.toMatchObject({ code: "CODE_REVIEW_STALE" });
  });
  it("does not route a cloud semantic owner to a local workspace lookup", async () => {
    const scope: CloudRuntimeScope = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", engineWorkspaceId: "local-main", root: "/workspace/repo" };
    const key = cloudWorkspaceKey(scope);
    const nativeThread = { ...thread, workspaceId: "local-main" };
    const seen = vi.fn();
    const bridge = {
      executionIdentity: { kind: "local", sidecar: "active" },
      request: async (message: Record<string, unknown>) => {
        seen(message);
        const outgoing = cloudOutgoing(scope, message);
        expect(outgoing.params).toEqual({ workspaceId: "local-main" });
        return cloudIncoming(scope, { type: "WORKSPACE_RESPONSE", op: "codeReview.list", result: { workspaceId: "local-main", threads: [nativeThread] } });
      },
    } as unknown as RuntimeClient;
    setActiveBridge(bridge);
    const result = await listCodeReviewThreads({ workspaceId: key });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(result.workspaceId).toBe(key);
    expect(result.threads[0]!.workspaceId).toBe(key);
    expect(result.threads[0]!.anchor).toEqual(thread.anchor);
    expect(result.threads[0]!.comments).toEqual(thread.comments);
  });
});
