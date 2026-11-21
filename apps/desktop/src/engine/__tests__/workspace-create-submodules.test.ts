// The engine's post-create chain: submodules, then setup, then run-on-create.
// The submodule step itself is covered in git/__tests__/submodules*.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";

const submoduleStep = vi.hoisted(() => ({
  fetch: vi.fn<(workspaceId: string, signal?: AbortSignal) => Promise<string | null>>(),
}));
vi.mock("../git/submodules", () => ({
  fetchCreatedWorkspaceSubmodules: submoduleStep.fetch,
}));

import { ZerosEngine } from "../index";

interface Internals {
  workspace: {
    submoduleFetcher: ((workspaceId: string) => Promise<void>) | null;
    isWriteOp(op: string): boolean;
    lifecycleMutationWorkspaceId(op: string, params: Record<string, unknown>): string | null;
    handle(op: string, params?: Record<string, unknown>, opts?: { remote?: boolean }): Promise<unknown>;
  };
  setup: {
    start(args: { workspaceId: string; command: string; onPassed?: () => void }): Promise<void>;
    recordNote(workspaceId: string, note: string): void;
  };
  workspaceAllowsProcessStart(workspaceId: string | null): boolean;
  startRunOnCreateActions(workspaceId: string): void;
  workspaceProcessStarts: Map<string, Set<Promise<unknown>>>;
  handleWorkspaceMessage(
    msg: Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
    client: TransportClient,
  ): Promise<void>;
}

function client(): TransportClient {
  return { id: "client-local", kind: "local", send: vi.fn(), close: vi.fn() };
}

let port = 29_960;
function engine(setupCommand: string | null) {
  const state = new ZerosEngine({ root: "/tmp/zeros-submodule-chain", port: port++ }) as unknown as Internals;
  vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
  vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(null);
  vi.spyOn(state.workspace, "handle").mockResolvedValue({
    workspaceId: "ws_sub",
    branch: "b",
    path: "/tmp/zeros-submodule-chain/ws",
    status: "in-progress",
    setupCommand,
  });
  const order: string[] = [];
  let allowed = true;
  vi.spyOn(state, "workspaceAllowsProcessStart").mockImplementation(() => allowed);
  vi.spyOn(state.setup, "start").mockImplementation(async (args) => {
    order.push("setup");
    args.onPassed?.();
  });
  vi.spyOn(state.setup, "recordNote").mockImplementation((_id, note) => {
    order.push(`note:${note}`);
  });
  vi.spyOn(state, "startRunOnCreateActions").mockImplementation(() => {
    order.push("run-on-create");
  });
  return { state, order, block: () => { allowed = false; } };
}

async function create(state: Internals): Promise<void> {
  await state.handleWorkspaceMessage(
    {
      type: "WORKSPACE_REQUEST",
      id: "create-1",
      source: "browser",
      timestamp: 1,
      op: "workspace.create",
      params: { repoRoot: "/tmp/zeros-submodule-chain/repo" },
    } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
    client(),
  );
}

afterEach(() => {
  submoduleStep.fetch.mockReset();
  vi.restoreAllMocks();
});

describe("workspace.create post-create chain", () => {
  it("fetches submodules first, reports through the Setup log, then runs setup and run-on-create", async () => {
    let finish!: (note: string | null) => void;
    submoduleStep.fetch.mockImplementation((_id, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return new Promise((resolve) => { finish = resolve; });
    });
    const { state, order } = engine("pnpm install");
    await create(state);
    await vi.waitFor(() => expect(submoduleStep.fetch).toHaveBeenCalledWith("ws_sub", expect.any(AbortSignal)));
    // Archive/delete drains this start like any other workspace process start.
    expect(state.workspaceProcessStarts.get("ws_sub")?.size).toBe(1);
    expect(order).toEqual([]);

    finish("Submodules: 1 fetched, 0 skipped, 0 failed.\r\n\r\n");
    await vi.waitFor(() => expect(order).toHaveLength(3));
    expect(order).toEqual([
      "note:Submodules: 1 fetched, 0 skipped, 0 failed.\r\n\r\n",
      "setup",
      "run-on-create",
    ]);
  });

  it("still runs setup when the submodule step fails", async () => {
    submoduleStep.fetch.mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { state, order } = engine("pnpm install");
    await create(state);
    await vi.waitFor(() => expect(order).toEqual(["setup", "run-on-create"]));
    expect(error).toHaveBeenCalled();
  });

  it("starts run-on-create directly when there is no setup command and nothing to report", async () => {
    submoduleStep.fetch.mockResolvedValue(null);
    const { state, order } = engine(null);
    await create(state);
    await vi.waitFor(() => expect(order).toEqual(["run-on-create"]));
  });

  it("aborts the fetch once archive or delete blocks the workspace", async () => {
    let seen: AbortSignal | undefined;
    submoduleStep.fetch.mockImplementation((_id, signal) => {
      seen = signal;
      return new Promise((resolve) => signal!.addEventListener("abort", () => resolve(null)));
    });
    const { state, order, block } = engine("pnpm install");
    await create(state);
    await vi.waitFor(() => expect(seen).toBeDefined());
    block();
    await vi.waitFor(() => expect(seen!.aborted).toBe(true), { timeout: 2_000 });
    await vi.waitFor(() => expect(state.workspaceProcessStarts.has("ws_sub")).toBe(false));
    expect(order).toEqual([]);
  });

  it("wires the same step into workspace.createFromBranch", async () => {
    submoduleStep.fetch.mockResolvedValue("Submodules: 1 fetched, 0 skipped, 0 failed.\r\n\r\n");
    const { state, order } = engine("pnpm install");
    await state.workspace.submoduleFetcher!("ws_branch");
    expect(submoduleStep.fetch).toHaveBeenCalledWith("ws_branch", expect.any(AbortSignal));
    expect(order).toEqual(["note:Submodules: 1 fetched, 0 skipped, 0 failed.\r\n\r\n"]);
  });
});
