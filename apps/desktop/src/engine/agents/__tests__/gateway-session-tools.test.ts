import { describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";
import type { SessionToolsInventorySnapshot } from "@zeros/protocol/agent-extensions";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

function fixture() {
  const gateway = new AgentGateway({
    projectRoot: "/fixture",
    executionBoundary: testExecutionBoundary(),
    events: {
      onSessionUpdate() {},
      onPermissionRequest() {},
      onQuestionRequest() {},
      onAgentStderr() {},
      onAgentExit() {},
    },
  });
  const list = vi.fn().mockResolvedValue({ state: "ready", entries: [] });
  const authenticate = vi
    .fn()
    .mockResolvedValue({ authorizationUrl: "https://auth.example/" });
  const internal = gateway as unknown as {
    adapters: Map<string, AgentAdapter>;
    executionToAgent: Map<string, string>;
    executionToCwd: Map<string, string>;
  };
  internal.adapters.set("codex", {
    agentId: "codex",
    capabilityPorts: { sessionTools: { list, authenticate } },
    dispose: async () => {},
  } as unknown as AgentAdapter);
  internal.executionToAgent.set("session-a", "codex");
  internal.executionToCwd.set("session-a", "/fixture/a");
  return { gateway, internal, list, authenticate };
}

describe("session tools authority", () => {
  it("keys grouped inventory to the admitted execution and validates the response", async () => {
    const f = fixture();
    const inventory = vi.fn().mockResolvedValue({ state: "ready", entries: [], groups: [{ kind: "apps", state: "ready", entries: [] }] });
    f.internal.adapters.get("codex")!.capabilityPorts!.sessionTools!.inventory = inventory;
    try {
      await expect(f.gateway.readSessionToolInventory("codex", "session-a", "/fixture/b")).rejects.toThrow();
      expect(inventory).not.toHaveBeenCalled();
      const result = await f.gateway.readSessionToolInventory("codex", "session-a", "/fixture/a");
      expect(result.groups?.[0].kind).toBe("apps");
      inventory.mockResolvedValue({ state: "ready", entries: [], groups: [{ kind: "apps", state: "ready", entries: [], token: "SECRET" }] });
      await expect(f.gateway.readSessionToolInventory("codex", "session-a", "/fixture/a")).rejects.toThrow("Could not read");
    } finally { await f.gateway.dispose(); }
  });

  it("rejects a grouped snapshot arriving after the session ends", async () => {
    const f = fixture();
    let finish!: (value: SessionToolsInventorySnapshot) => void;
    f.internal.adapters.get("codex")!.capabilityPorts!.sessionTools!.inventory = () => new Promise((resolve) => { finish = resolve; });
    try {
      const pending = f.gateway.readSessionToolInventory("codex", "session-a", "/fixture/a");
      f.internal.executionToAgent.delete("session-a");
      finish({ state: "ready", entries: [], groups: [] });
      await expect(pending).rejects.toThrow("Could not read");
    } finally { await f.gateway.dispose(); }
  });
  it("requires the exact admitted provider, execution and workspace", async () => {
    const f = fixture();
    try {
      await expect(
        f.gateway.readSessionTools("claude", "session-a", "/fixture/a"),
      ).rejects.toThrow("no longer available");
      await expect(
        f.gateway.readSessionTools("codex", "unknown", "/fixture/a"),
      ).rejects.toThrow("no longer available");
      await expect(
        f.gateway.authenticateSessionTool(
          "codex",
          "session-a",
          "/fixture/b",
          "tool",
        ),
      ).rejects.toThrow("no longer available");
      expect(f.list).not.toHaveBeenCalled();
      expect(f.authenticate).not.toHaveBeenCalled();
      await expect(
        f.gateway.readSessionTools("codex", "session-a", "/fixture/a"),
      ).resolves.toEqual({ state: "ready", entries: [] });
    } finally {
      await f.gateway.dispose();
    }
  });
  it("rejects late status/auth results after a session ends and scrubs provider errors", async () => {
    const f = fixture();
    try {
      let finish!: (value: unknown) => void;
      f.list.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const read = f.gateway.readSessionTools(
        "codex",
        "session-a",
        "/fixture/a",
      );
      f.internal.executionToAgent.delete("session-a");
      finish({ state: "ready", entries: [] });
      await expect(read).rejects.toThrow("Could not read");
      f.internal.executionToAgent.set("session-a", "codex");
      f.authenticate.mockRejectedValue(new Error("SECRET"));
      await expect(
        f.gateway.authenticateSessionTool(
          "codex",
          "session-a",
          "/fixture/a",
          "tool",
        ),
      ).rejects.toThrow("Could not start tool authentication");
    } finally {
      await f.gateway.dispose();
    }
  });
});
