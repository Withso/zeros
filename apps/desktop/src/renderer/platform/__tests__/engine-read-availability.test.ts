import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ghPrGet,
  gitDiff,
  gitStage,
  gitStatus,
  listWorkspaceFiles,
  workspaceList,
  type Workspace,
} from "../git";
import { readWorkspaceFile, writeWorkspaceFile } from "../files";
import { turnDiff, turnsList } from "../turns";
import { ptyTerminals } from "../pty";
import { setActiveBridge } from "../bridge/active-bridge";
import type { RuntimeClient } from "../bridge/ws-client";
import {
  clearChat,
  dbChatSnapshot,
  dbHead,
  dbReplaceAllChats,
  windowMessages,
} from "../../features/agent/agent-history-client";

afterEach(() => setActiveBridge(null));

describe("engine-backed native façades", () => {
  it("rejects transport absence instead of publishing synthetic empty data", async () => {
    setActiveBridge(null);

    await expect(gitStatus("workspace-a")).rejects.toThrow(
      /not connected to the Zeros engine/i,
    );
    await expect(
      gitDiff({ workspaceId: "workspace-a", mode: "worktree-vs-head" }),
    ).rejects.toThrow(/not connected to the Zeros engine/i);
    await expect(workspaceList()).rejects.toThrow(
      /not connected to the Zeros engine/i,
    );
    await expect(turnsList("workspace-a")).rejects.toThrow(
      /not connected to the Zeros engine/i,
    );
    await expect(
      turnDiff({ chatId: "chat-a", turnId: "turn-a" }),
    ).rejects.toThrow(/not connected to the Zeros engine/i);
    await expect(
      ghPrGet({ workspaceId: "workspace-a", prNumber: 42 }),
    ).rejects.toThrow(/not connected to the Zeros engine/i);
    await expect(listWorkspaceFiles("/worktree-a")).rejects.toThrow(
      /not connected to the Zeros engine/i,
    );
    await expect(
      readWorkspaceFile("/worktree-a", "src/app.ts"),
    ).rejects.toThrow(/not connected to the Zeros engine/i);
    await expect(windowMessages("chat-a", 100)).rejects.toThrow(
      /not connected to the Zeros engine/i,
    );
    await expect(dbChatSnapshot()).rejects.toThrow(
      /not connected to the Zeros engine/i,
    );
    await expect(dbHead()).rejects.toThrow(
      /not connected to the Zeros engine/i,
    );
  });

  it("never reports a disconnected mutation as successful", async () => {
    setActiveBridge(null);
    await expect(
      gitStage({ workspaceId: "workspace-a", paths: ["src/app.ts"] }),
    ).rejects.toThrow(/not connected to the Zeros engine/i);
    await expect(
      writeWorkspaceFile("/worktree-a", "src/app.ts", "updated"),
    ).rejects.toThrow(/not connected to the Zeros engine/i);
    await expect(clearChat("chat-a")).rejects.toThrow(
      /not connected to the Zeros engine/i,
    );
    await expect(dbReplaceAllChats([])).rejects.toThrow(
      /not connected to the Zeros engine/i,
    );
  });

  it("does not turn a failed terminal registry read into zero terminals", async () => {
    const request = vi.fn().mockRejectedValue(new Error("engine reconnecting"));
    setActiveBridge({ request } as unknown as RuntimeClient);

    await expect(ptyTerminals("workspace-a")).resolves.toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it("makes generic workspace lists code-only unless a Design surface opts in", async () => {
    const code = {
      id: "code",
      kind: "code",
      repoSlug: "zeros",
    } as Workspace;
    const design = {
      id: "design",
      kind: "design",
      repoSlug: "zeros",
    } as Workspace;
    const request = vi.fn().mockResolvedValue({
      type: "WORKSPACE_RESPONSE",
      op: "workspace.list",
      result: { workspaces: [code, design] },
    });
    setActiveBridge({ request } as unknown as RuntimeClient);

    await expect(workspaceList()).resolves.toEqual([code]);
    await expect(workspaceList({ includeDesign: true })).resolves.toEqual([
      code,
      design,
    ]);
    expect(request.mock.calls[1]?.[0]?.params).not.toHaveProperty(
      "includeDesign",
    );
  });
});
