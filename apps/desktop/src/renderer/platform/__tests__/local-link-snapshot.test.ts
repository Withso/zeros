import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "../bridge/ws-client";
import { WorkspaceRuntimeClient } from "../bridge/workspace-runtime-client";
import { readLocalLinkSnapshot } from "../local-link-snapshot";

afterEach(() => vi.restoreAllMocks());

describe("Local link metadata reads", () => {
  it("waits for native reads without touching a warm cloud catalog or opening peers", async () => {
    const open = vi.fn(),
      workspaces = vi.fn(() => [{ id: "cloud", path: "cloud://org/ws" }]);
    const client = new WorkspaceRuntimeClient({ open, workspaces });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi
      .spyOn(RuntimeClient.prototype, "request")
      .mockImplementation(async (message) => {
        await wait;
        const op = (message as unknown as { op: string }).op;
        const key =
          op === "project.list"
            ? "projects"
            : op === "workspace.list"
              ? "workspaces"
              : "chats";
        return {
          type: "WORKSPACE_RESPONSE",
          op,
          result: { [key]: [] },
        } as never;
      });
    let settled = false;
    const read = readLocalLinkSnapshot(client).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
    expect(open).not.toHaveBeenCalled();
    expect(workspaces).not.toHaveBeenCalled();
    release();
    expect(await read).toEqual({ projects: [], workspaces: [], chats: [] });
    client.dispose();
  });

  it("refuses a cloud transport before issuing any read", async () => {
    const request = vi.fn();
    await expect(
      readLocalLinkSnapshot({
        executionIdentity: { kind: "cloud" },
        request,
      } as unknown as RuntimeClient),
    ).rejects.toThrow("Local engine");
    expect(request).not.toHaveBeenCalled();
  });

  it("treats malformed or failed snapshots as failures, never as empty catalogs", async () => {
    for (const reply of [
      { type: "WORKSPACE_RESPONSE", result: {} },
      { type: "WORKSPACE_ERROR", code: "NOT_FOUND" },
    ]) {
      const client = {
        executionIdentity: { kind: "local" },
        request: vi.fn().mockResolvedValue(reply),
      } as unknown as RuntimeClient;
      await expect(readLocalLinkSnapshot(client)).rejects.toThrow(
        "Local catalog",
      );
    }
  });
});
