import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import type { EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";
import * as gitState from "../git/state";

afterEach(() => vi.restoreAllMocks());

const LIFECYCLE_OPS = [
  "workspace.archive",
  "workspace.delete",
  "workspace.restore",
  "workspace.recover",
] as const;

type WorkspaceRequest = Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>;
type Targets = readonly { workspaceId: string; designDirectory: string }[];
interface Internals {
  cloudWorker: unknown;
  workspace: { handle(op: string): Promise<unknown> };
  agents: {
    suspendSessionTools(workspaceId?: string): () => void;
    suspendPooledUtilityWorkspaceTerritory(workspaceRoot: string): void;
    retirePooledUtilityWorkspaceTerritory(workspaceRoot: string): Promise<void>;
    resumePooledUtilityWorkspaceTerritory(workspaceRoot: string): void;
    assertWorkspaceDesignAuthorityRetirementsProven(workspaceRoot: string): void;
  };
  setup: { stopForWorkspaceTerritoryAndProve(...args: unknown[]): Promise<void> };
  runs: { stopForWorkspaceTerritoryAndProve(...args: unknown[]): Promise<void> };
  retireCodeAgentSessionsForTerritoryChange(...args: unknown[]): Promise<void>;
  withDesignTerritoryTransition<T>(
    targets: Targets,
    mutation: () => Promise<T>,
  ): Promise<T>;
  withGlobalDesignTerritoryTransition<T>(mutation: () => Promise<T>): Promise<T>;
  handleWorkspaceMessage(
    message: WorkspaceRequest,
    client: TransportClient,
    cloudMutationAdmitted?: boolean,
  ): Promise<void>;
}

// A managed worktree archived while another workspace's prompt is being
// prepared.
const managed = {
  id: "ws_archived-owner",
  path: "/tmp/zeros-lifecycle-design-scope/archived",
  repoRoot: "/tmp/zeros-lifecycle-design-scope/main",
  archivedAt: null,
  placement: "local",
};

function engine(port: number): Internals {
  const state = new ZerosEngine({
    root: "/tmp/zeros-lifecycle-design-scope",
    port,
  }) as unknown as Internals;
  vi.spyOn(gitState, "getWorkspaceById").mockImplementation(
    (id: string) =>
      (id === managed.id ? managed : null) as ReturnType<
        typeof gitState.getWorkspaceById
      >,
  );
  vi.spyOn(state.workspace, "handle").mockResolvedValue({ ok: true });
  return state;
}

function request(op: string, workspaceId: string): WorkspaceRequest {
  return {
    type: "WORKSPACE_REQUEST",
    source: "browser",
    id: `${op}:${workspaceId}`,
    timestamp: 1,
    op,
    params: { workspaceId },
  } as WorkspaceRequest;
}

function client(): TransportClient {
  return { id: "desktop", kind: "local", send: vi.fn(), close: vi.fn() };
}

describe("workspace lifecycle Design scope (Local)", () => {
  it.each(LIFECYCLE_OPS)(
    "%s suspends only the managed workspace's Design grants",
    async (op) => {
      const state = engine(29_971);
      const scopes: Array<string | undefined> = [];
      vi.spyOn(state.agents, "suspendSessionTools").mockImplementation(
        (workspaceId?: string) => {
          scopes.push(workspaceId);
          return () => {};
        },
      );

      await state.handleWorkspaceMessage(request(op, managed.id), client());

      // An unscoped suspension also pauses every other workspace's chats, and a
      // prompt prepared there failed with "The operation was aborted.".
      expect(scopes).toEqual([managed.id]);
      expect(state.workspace.handle).toHaveBeenCalledOnce();
    },
  );

  it("queues a follow-up lifecycle for the same owner behind its transition", async () => {
    const state = engine(29_975);
    const scopes: Array<string | undefined> = [];
    vi.spyOn(state.agents, "suspendSessionTools").mockImplementation(
      (workspaceId?: string) => {
        scopes.push(workspaceId);
        return () => {};
      },
    );
    let finishArchive: (() => void) | undefined;
    const handled: string[] = [];
    vi.mocked(state.workspace.handle).mockImplementation(async (op: string) => {
      handled.push(op);
      if (op === "workspace.archive")
        await new Promise<void>((resolve) => {
          finishArchive = resolve;
        });
      return { ok: true };
    });
    const receiver = client();

    const archive = state.handleWorkspaceMessage(
      request("workspace.archive", managed.id),
      receiver,
    );
    await vi.waitFor(() => expect(finishArchive).toBeTypeOf("function"));
    // Another window restores while the archive still owns the transition.
    const restore = state.handleWorkspaceMessage(
      request("workspace.restore", managed.id),
      receiver,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handled).toEqual(["workspace.archive"]);
    finishArchive!();
    await Promise.all([archive, restore]);

    expect(handled).toEqual(["workspace.archive", "workspace.restore"]);
    expect(receiver.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "WORKSPACE_ERROR" }),
    );
    expect(scopes).toEqual([managed.id, managed.id]);
  });

  it("keeps the app-wide gate for a lifecycle request without a managed owner", async () => {
    const state = engine(29_972);
    const scopes: Array<string | undefined> = [];
    vi.spyOn(state.agents, "suspendSessionTools").mockImplementation(
      (workspaceId?: string) => {
        scopes.push(workspaceId);
        return () => {};
      },
    );

    await state.handleWorkspaceMessage(
      request("workspace.archive", "local-main"),
      client(),
    );

    expect(scopes).toEqual([undefined]);
  });
});

describe("workspace lifecycle Design scope (cloud worker)", () => {
  function cloudEngine(port: number) {
    const state = engine(port);
    state.cloudWorker = { version: 1 };
    const scoped = vi
      .spyOn(state, "withDesignTerritoryTransition")
      .mockImplementation((_targets, mutation) => mutation());
    const global = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation((mutation) => mutation());
    return { state, scoped, global };
  }

  it.each(LIFECYCLE_OPS)(
    "%s retires only the managed owner's authority",
    async (op) => {
      const { state, scoped, global } = cloudEngine(29_973);

      await state.handleWorkspaceMessage(
        request(op, managed.id),
        client(),
        true,
      );

      expect(scoped).toHaveBeenCalledExactlyOnceWith(
        [
          {
            workspaceId: managed.id,
            designDirectory: path.join(managed.path, "Zeros Design"),
          },
        ],
        expect.any(Function),
      );
      expect(global).not.toHaveBeenCalled();
    },
  );

  it("queues a follow-up lifecycle for the same owner behind its cloud transition", async () => {
    const state = engine(29_976);
    state.cloudWorker = { version: 1 };
    // The owner's authority retirement is covered elsewhere; this test proves
    // the real cloud transition releases its owner to a queued request.
    vi.spyOn(state.agents, "suspendPooledUtilityWorkspaceTerritory").mockReturnValue();
    vi.spyOn(state.agents, "retirePooledUtilityWorkspaceTerritory").mockResolvedValue();
    vi.spyOn(state.agents, "resumePooledUtilityWorkspaceTerritory").mockReturnValue();
    vi.spyOn(state.agents, "assertWorkspaceDesignAuthorityRetirementsProven").mockReturnValue();
    vi.spyOn(state.setup, "stopForWorkspaceTerritoryAndProve").mockResolvedValue();
    vi.spyOn(state.runs, "stopForWorkspaceTerritoryAndProve").mockResolvedValue();
    const retired = vi
      .spyOn(state, "retireCodeAgentSessionsForTerritoryChange")
      .mockResolvedValue();
    let finishArchive: (() => void) | undefined;
    const handled: string[] = [];
    vi.mocked(state.workspace.handle).mockImplementation(async (op: string) => {
      handled.push(op);
      if (op === "workspace.archive")
        await new Promise<void>((resolve) => {
          finishArchive = resolve;
        });
      return { ok: true };
    });
    const receiver = client();

    const archive = state.handleWorkspaceMessage(
      request("workspace.archive", managed.id),
      receiver,
      true,
    );
    await vi.waitFor(() => expect(finishArchive).toBeTypeOf("function"));
    const restore = state.handleWorkspaceMessage(
      request("workspace.restore", managed.id),
      receiver,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handled).toEqual(["workspace.archive"]);
    finishArchive!();
    await Promise.all([archive, restore]);

    expect(handled).toEqual(["workspace.archive", "workspace.restore"]);
    expect(receiver.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "WORKSPACE_ERROR" }),
    );
    expect(retired.mock.calls.map(([workspaceId]) => workspaceId)).toEqual(
      expect.arrayContaining([managed.id]),
    );
    expect(
      retired.mock.calls.every(([workspaceId]) => workspaceId === managed.id),
    ).toBe(true);
  });

  it("keeps the primary checkout's lifecycle request on its existing gate", async () => {
    const { state, scoped, global } = cloudEngine(29_974);

    await state.handleWorkspaceMessage(
      request("workspace.archive", "local-main"),
      client(),
      true,
    );

    expect(global).toHaveBeenCalledOnce();
    expect(scoped).not.toHaveBeenCalled();
  });
});
