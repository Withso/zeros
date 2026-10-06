import { describe, expect, it, vi } from "vitest";

import {
  bornChatThread,
  spawnDefaultChatForWorkspace,
  spawnNewChatTab,
} from "../spawn-default-chat";
import type { Action } from "../workspace-store";

describe("chat-tab workspace activity", () => {
  it("starts cloud tabs with a delegated model instead of the global default", () => {
    expect(bornChatThread({ id: "codex", name: "Codex", cloudModels: ["gpt-5.6-luna"] } as never,
      "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222").model).toBe("gpt-5.6-luna");
  });
  it("records an explicit new tab but not automatic empty-workspace repair", async () => {
    const explicitActions: Action[] = [];
    const explicitFolder = `/explicit-chat-${Date.now()}`;
    await spawnNewChatTab({
      folder: explicitFolder,
      sessions: {} as never,
      dispatch: (action) => explicitActions.push(action),
    });
    expect(explicitActions).toContainEqual(
      expect.objectContaining({
        type: "ADD_CHAT",
        recordWorkspaceActivity: true,
      }),
    );

    const automaticActions: Action[] = [];
    const automaticFolder = `/automatic-chat-${Date.now()}`;
    expect(
      await spawnDefaultChatForWorkspace({
        folder: automaticFolder,
        sessions: {} as never,
        dispatch: vi.fn((action: Action) => automaticActions.push(action)),
      }),
    ).toBe(true);
    expect(automaticActions).toContainEqual(
      expect.objectContaining({ type: "ADD_CHAT" }),
    );
    expect(automaticActions).not.toContainEqual(
      expect.objectContaining({ recordWorkspaceActivity: true }),
    );
  });
});
