import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeReviewThread } from "@zeros/protocol/code-review";
import { ZerosEngine } from "../zeros-engine";
import type { EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";
import { WorkspaceService, LOCAL_MAIN_WORKSPACE_ID } from "../workspace/service";
import { closeState, setStateRootForTesting } from "../git";
import { upsertRepoByRoot } from "../db/projects";
import { codeReviewProfileName } from "../code-review/actors";

const dispatch = (ZerosEngine.prototype as unknown as {
  handleWorkspaceMessage(this: unknown, message: EngineMessage, client: TransportClient): Promise<void>;
}).handleWorkspaceMessage;
const bind = (ZerosEngine.prototype as unknown as {
  verifyAccountBinding(this: unknown, message: EngineMessage, client: TransportClient): Promise<void>;
}).verifyAccountBinding;

describe("review attribution and invalidation through WORKSPACE_REQUEST", () => {
  let directory: string;
  let root: string;
  let workspace: WorkspaceService;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-review-transport-"));
    root = path.join(directory, "repo"); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "example.ts"), "original\n");
    setStateRootForTesting(path.join(directory, "state"));
    workspace = new WorkspaceService(root);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks(); closeState(); setStateRootForTesting(null);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function fixture() {
    const client: TransportClient = { id: "local-view", kind: "local", send: vi.fn(), close: vi.fn() };
    const engine = {
      workspace, cloudWorker: null, cloudRuntimeAuthorityStopping: false,
      clientAccount: new Map<string, string>(), clientAccountNames: new Map<string, string>(),
      ownerAccountSub: "trusted-account", ownerAccountName: "Ada Reviewer",
      globalDesignTerritoryTransitionCount: 0,
      isHostRelayClient: () => false, slowWorkspaceOperations: { observe: vi.fn() },
      router: { broadcast: vi.fn(), broadcastExcept: vi.fn() }, reportEngineError: vi.fn(),
    };
    const send = (op: string, params: Record<string, unknown>) => dispatch.call(engine, {
      type: "WORKSPACE_REQUEST", id: "request", timestamp: 1, source: "browser", op, params,
    }, client);
    return { client, engine, send };
  }
  const create = (workspaceId: string = LOCAL_MAIN_WORKSPACE_ID) => ({
    workspaceId, anchor: { path: "example.ts", side: "file", startLine: 1, endLine: 1, revision: "original" }, body: "Review this line",
  });

  it("uses verified owner/account names and sends viewer identity without accepting impersonation", async () => {
    const f = fixture();
    await f.send("codeReview.create", create());
    const first = (vi.mocked(f.client.send).mock.calls[0]![0] as Extract<EngineMessage, { type: "WORKSPACE_RESPONSE" }>).result as CodeReviewThread;
    expect(first.comments[0]!.author).toEqual({ id: "human:trusted-account", name: "Ada Reviewer", kind: "human" });
    f.engine.clientAccount.set(f.client.id, "verified-other-account");
    f.engine.clientAccountNames.set(f.client.id, "Grace Reviewer");
    await f.send("codeReview.reply", { workspaceId: LOCAL_MAIN_WORKSPACE_ID, threadId: first.id, body: "Follow-up" });
    const second = (vi.mocked(f.client.send).mock.calls.at(-1)![0] as Extract<EngineMessage, { type: "WORKSPACE_RESPONSE" }>).result as CodeReviewThread;
    expect(second.comments[1]!.author).toEqual({ id: "human:verified-other-account", name: "Grace Reviewer", kind: "human" });
    await f.send("codeReview.list", { workspaceId: LOCAL_MAIN_WORKSPACE_ID });
    expect(f.client.send).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "WORKSPACE_RESPONSE", result: expect.objectContaining({ viewerActorId: "human:verified-other-account" }),
    }));
    await f.send("codeReview.reply", { workspaceId: LOCAL_MAIN_WORKSPACE_ID, threadId: first.id, body: "Forged", author: { id: "human:trusted-account", name: "Ada Reviewer", kind: "human" } });
    expect(f.client.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "WORKSPACE_ERROR", code: "CODE_REVIEW_INVALID" }));
    expect((await workspace.handle("codeReview.list", { workspaceId: LOCAL_MAIN_WORKSPACE_ID }) as { threads: CodeReviewThread[] }).threads[0]!.comments).toHaveLength(2);
  });

  it("preserves stale error codes and publishes exact local-main/rowless owner events to all clients", async () => {
    const f = fixture();
    await f.send("codeReview.create", create());
    const thread = (vi.mocked(f.client.send).mock.calls[0]![0] as Extract<EngineMessage, { type: "WORKSPACE_RESPONSE" }>).result as CodeReviewThread;
    expect(f.engine.router.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "DB_CHANGED", kinds: ["codeReview"], workspaceIds: [LOCAL_MAIN_WORKSPACE_ID] }));
    await f.send("codeReview.reply", { workspaceId: LOCAL_MAIN_WORKSPACE_ID, threadId: thread.id, body: "Concurrent reply" });
    f.engine.router.broadcast.mockClear();
    await f.send("codeReview.setResolved", { workspaceId: LOCAL_MAIN_WORKSPACE_ID, threadId: thread.id, resolved: true, expectedVersion: 1 });
    expect(f.client.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "WORKSPACE_ERROR", code: "CODE_REVIEW_STALE" }));
    expect(f.engine.router.broadcast).not.toHaveBeenCalled();
    const other = path.join(directory, "registered-repo"); fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "example.ts"), "other\n");
    upsertRepoByRoot({ repoRoot: other, name: "Other" });
    await f.send("codeReview.create", create(other));
    expect(f.engine.router.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "DB_CHANGED", kinds: ["codeReview"], workspaceIds: [other] }));
    expect(f.engine.router.broadcastExcept).not.toHaveBeenCalled();
  });

  it("captures names only after account-token verification and ignores unsigned connection profile fields", async () => {
    const f = fixture();
    const engine = {
      ...f.engine, accountAuth: { required: false }, clientTokenExp: new Map(), ensureBindingSweep: vi.fn(),
      verifyAccountToken: vi.fn().mockResolvedValue({ sub: "signed-account", name: "Verified Name" }),
    };
    await bind.call(engine, { type: "CONNECTED", id: "connection", timestamp: 1, source: "browser", capabilities: {}, authToken: "fixture", name: "Forged Name" } as unknown as EngineMessage, f.client);
    expect(engine.ownerAccountSub).toBe("signed-account");
    expect(engine.ownerAccountName).toBe("Verified Name");
    engine.verifyAccountToken.mockRejectedValue(new Error("invalid fixture token"));
    await bind.call(engine, { type: "CONNECTED", id: "invalid", timestamp: 1, source: "browser", authToken: "fixture" } as EngineMessage, f.client);
    expect(engine.ownerAccountName).toBe("Verified Name");
    expect(codeReviewProfileName({ name: "\u0000invalid", first_name: "Ada", last_name: "Reviewer" })).toBe("Ada Reviewer");
    expect(codeReviewProfileName({ email: "fixture@example.invalid" })).toBeUndefined();
  });
});
