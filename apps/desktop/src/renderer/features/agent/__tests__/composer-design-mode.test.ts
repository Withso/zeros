import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { composerDesignModeAvailable } from "../composer-design-mode";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("composer Design mode entry", () => {
  it("is available for Local workspaces and hidden for Cloud workspaces", () => {
    const input = {
      chatId: "chat-1",
      bridge: {},
      workspaceId: "/repo",
    };
    expect(composerDesignModeAvailable(input)).toBe(true);
    expect(composerDesignModeAvailable({ ...input, workspaceId: "cloud://org/workspace" })).toBe(false);
    expect(composerDesignModeAvailable({ ...input, chatId: null })).toBe(false);
    expect(composerDesignModeAvailable({ ...input, bridge: null })).toBe(false);
  });

  it("exposes Design mode as a one-click composer control while preserving the existing menu path", () => {
    const agentChat = read("../agent-chat.tsx");
    const attachmentMenu = read("../composer-attachment-menu.tsx");
    expect(agentChat).toContain("composerDesignModeAvailable({");
    expect(agentChat).toContain('label="Design mode"');
    expect(agentChat).toContain("composerFocusRef.current();");
    expect(agentChat).toContain("onClick={activateDesignMode}");
    expect(agentChat).toContain("designModeAvailable ? enterDesignMode : undefined");
    expect(agentChat).toContain('designModeAvailable && chatThread?.composerMode !== "design" && (');
    expect(attachmentMenu).toContain("<span>Design</span>");
  });
});
