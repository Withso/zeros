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
  workspace: {
    handle(op: string, params?: Record<string, unknown>): Promise<unknown>;
  };
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
// Another managed worktree of the same repository.
const sibling = {
  ...managed,
  id: "ws_sibling-owner",
  path: "/tmp/zeros-lifecycle-design-scope/sibling",
};

function engine(port: number): Internals {
  const state = new ZerosEngine({
    root: "/tmp/zeros-lifecycle-design-scope",
    port,
  }) as unknown as Internals;
  vi.spyOn(gitState, "getWorkspaceById").mockImplementation(
    (id: string) =>
      ([managed, sibling].find((owner) => owner.id === id) ?? null) as ReturnType<
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

/** Hold the first archive in the service; record every op that reaches it. */
function holdArchive(state: Internals) {
  const handled: string[] = [];
  let finishArchive: (() => void) | undefined;
  vi.mocked(state.workspace.handle).mockImplementation(
    async (op: string, params?: Record<string, unknown>) => {
      handled.push(`${op}:${String(params?.workspaceId)}`);
      if (op === "workspace.archive")
        await new Promise<void>((resolve) => {
          finishArchive = resolve;
        });
      return { ok: true };
    },
  );
  return {
    handled,
    started: () => vi.waitFor(() => expect(finishArchive).toBeTypeOf("function")),
    finish: () => finishArchive!(),
  };
}

describe("workspace lifecycle Design scope", () => {
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

  it("does not queue one workspace's lifecycle behind another's", async () => {
    const state = engine(29_977);
    vi.spyOn(state.agents, "suspendSessionTools").mockReturnValue(() => {});
    const held = holdArchive(state);
    const receiver = client();

    const archive = state.handleWorkspaceMessage(
      request("workspace.archive", managed.id),
      receiver,
    );
    await held.started();
    // Restoring several archived workspaces at once used to run strictly one
    // after another, so later restores waited for every earlier one.
    const restore = state.handleWorkspaceMessage(
      request("workspace.restore", sibling.id),
      receiver,
    );
    await vi.waitFor(() =>
      expect(held.handled).toContain(`workspace.restore:${sibling.id}`),
    );
    held.finish();
    await Promise.all([archive, restore]);
    expect(receiver.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "WORKSPACE_ERROR" }),
    );
  });

  it("keeps owner lifecycles ordered around an app-wide Design owner change", async () => {
    const state = engine(29_978);
    vi.spyOn(state.agents, "suspendSessionTools").mockReturnValue(() => {});
    const held = holdArchive(state);
    const receiver = client();

    const archive = state.handleWorkspaceMessage(
      request("workspace.archive", managed.id),
      receiver,
    );
    await held.started();
    const global = state.withGlobalDesignTerritoryTransition(async () => {
      held.handled.push("global");
    });
    const restore = state.handleWorkspaceMessage(
      request("workspace.restore", sibling.id),
      receiver,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The app-wide change waits for the running lifecycle; a lifecycle that
    // arrived after it waits for the app-wide change.
    expect(held.handled).toEqual([`workspace.archive:${managed.id}`]);
    held.finish();
    await Promise.all([archive, global, restore]);
    expect(held.handled).toEqual([
      `workspace.archive:${managed.id}`,
      "global",
      `workspace.restore:${sibling.id}`,
    ]);
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
