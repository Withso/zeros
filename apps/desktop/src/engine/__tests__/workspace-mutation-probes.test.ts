import { afterEach, describe, expect, it, vi } from "vitest";

import { ZerosEngine } from "../index";
import * as gitState from "../git/state";
import type { Workspace } from "../git/types";
import { shareWorkspaceChangeProbe } from "../git/workspace-change-probe";
import type { TransportClient } from "../transport/types";
import type { EngineMessage } from "../types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function workspace(id: string): Workspace {
  return { id, path: `/work/${id}`, repoRoot: "/work/repo", repoSlug: "fixture", branch: id, baseBranch: "main",
    status: "in-progress", createdAt: 1, archivedAt: null, stashRef: null,
    prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null };
}

afterEach(() => vi.restoreAllMocks());

describe("workspace mutation change-probe invalidation", () => {
  it.each([true, false])("fences an in-flight probe before mutation response and refresh (exact owner: %s)", async (exact) => {
    const target = workspace(`ws_mutation_${exact}`);
    const sibling = workspace(`ws_sibling_${exact}`);
    vi.spyOn(gitState, "getWorkspaceById").mockImplementation((id) => [target, sibling].find((owner) => owner.id === id) ?? null);
    const pending = deferred<boolean>();
    const before = shareWorkspaceChangeProbe(target, "origin", () => pending.promise);
    const siblingBefore = shareWorkspaceChangeProbe(sibling, "origin", () => pending.promise);
    let fromResponse: Promise<boolean> | undefined;
    let fromRefresh: Promise<boolean> | undefined;
    const readAfter = vi.fn(async () => true);
    const refresh = () => { fromRefresh = shareWorkspaceChangeProbe(target, "origin", readAfter); };
    const client: TransportClient = { id: "mutation-client", kind: "local", close: vi.fn(), send: (message) => {
      if (message.type === "WORKSPACE_RESPONSE") fromResponse = shareWorkspaceChangeProbe(target, "origin", readAfter);
    } };
    const engine = Object.create(ZerosEngine.prototype) as {
      handleWorkspaceMessage(message: EngineMessage, peer: TransportClient): Promise<void>;
    };
    Object.assign(engine, {
      workspace: { isWriteOp: () => true, lifecycleMutationWorkspaceId: () => null, handle: async () => ({ ok: true }) },
      slowWorkspaceOperations: { observe: vi.fn() },
      router: { broadcast: refresh, broadcastExcept: refresh },
    });

    await engine.handleWorkspaceMessage({ type: "WORKSPACE_REQUEST", id: "mutation", source: "browser", timestamp: 1,
      op: "git.stage", params: exact ? { workspaceId: target.id } : {} }, client);
    const siblingAfter = shareWorkspaceChangeProbe(sibling, "origin", readAfter);
    pending.resolve(false);

    expect(fromResponse).not.toBe(before);
    expect(fromRefresh).toBe(fromResponse);
    expect(siblingAfter === siblingBefore).toBe(exact);
    expect(await before).toBe(false);
    expect(await fromResponse).toBe(true);
    expect(await fromRefresh).toBe(true);
    expect(await siblingAfter).toBe(!exact);
  });

  it("keeps ordinary successful reads in their current probe generation", async () => {
    const target = workspace("ws_read_mutation_probe");
    const pending = deferred<boolean>();
    const before = shareWorkspaceChangeProbe(target, "origin", () => pending.promise);
    let after: Promise<boolean> | undefined;
    const client: TransportClient = { id: "read-client", kind: "local", close: vi.fn(), send: () => {
      after = shareWorkspaceChangeProbe(target, "origin", async () => true);
    } };
    const engine = Object.create(ZerosEngine.prototype) as {
      handleWorkspaceMessage(message: EngineMessage, peer: TransportClient): Promise<void>;
    };
    Object.assign(engine, {
      workspace: { isWriteOp: () => false, lifecycleMutationWorkspaceId: () => null, handle: async () => false },
      slowWorkspaceOperations: { observe: vi.fn() },
    });
    await engine.handleWorkspaceMessage({ type: "WORKSPACE_REQUEST", id: "read", source: "browser", timestamp: 1,
      op: "git.hasChanges", params: { workspaceId: target.id } }, client);
    pending.resolve(false);
    expect(after).toBe(before);
    expect(await after).toBe(false);
  });
});
