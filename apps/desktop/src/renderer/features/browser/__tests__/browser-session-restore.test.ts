import { describe, expect, it } from "vitest";

import type { Workspace } from "../../../platform/git";
import { conversationBrowserOwner } from "../browser-session-restore";

const FOLDER = "/Users/dev/zeros/.zeros/worktrees/zeros/ws_restore01";

function row(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_restore01",
    path: FOLDER,
    repoRoot: "/Users/dev/zeros",
    placement: "local",
    archivedAt: null,
    ...overrides,
  } as Workspace;
}

describe("the Local owner a reopened Browser page is keyed by", () => {
  it("resolves the conversation's workspace the way agent spawns do", () => {
    expect(
      conversationBrowserOwner(
        "conversation-a",
        [{ id: "conversation-a", folder: FOLDER }],
        [row({ id: "ws_other", path: "/Users/dev/other" }), row()],
      ),
    ).toEqual({ workspaceId: "ws_restore01", workspaceRoot: FOLDER });
    // A chat opened in a subfolder still belongs to its workspace.
    expect(
      conversationBrowserOwner(
        "conversation-a",
        [{ id: "conversation-a", folder: "/Users/dev/main/apps" }],
        [row({ id: "local-main", path: "/Users/dev/main" })],
      ),
    ).toEqual({ workspaceId: "local-main", workspaceRoot: "/Users/dev/main" });
  });

  it("leaves an unknown, cloud or archived owner to main's existing record", () => {
    const chats = [{ id: "conversation-a", folder: FOLDER }];
    expect(conversationBrowserOwner("conversation-b", chats, [row()])).toBeNull();
    // Rows not loaded yet: the id in the worktree path alone is not enough.
    expect(conversationBrowserOwner("conversation-a", chats, [])).toBeNull();
    expect(
      conversationBrowserOwner("conversation-a", chats, [
        row({ archivedAt: 1 }),
      ]),
    ).toBeNull();
    expect(
      conversationBrowserOwner("conversation-a", chats, [
        row({ placement: "cloud" }),
      ]),
    ).toBeNull();
    expect(
      conversationBrowserOwner(
        "conversation-a",
        [{ id: "conversation-a", folder: "cloud://org_1/ws_restore01" }],
        [row()],
      ),
    ).toBeNull();
    expect(
      conversationBrowserOwner(
        "conversation-a",
        [{ id: "conversation-a", folder: "" }],
        [row()],
      ),
    ).toBeNull();
  });
});
