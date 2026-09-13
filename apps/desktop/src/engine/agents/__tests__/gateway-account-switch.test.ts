import { expect, it, vi } from "vitest";
import * as credentials from "../provider-credentials";
import * as providerEnv from "../../settings/provider-env";
import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

it("refuses an unconfigured account before contacting the provider", async () => {
  vi.spyOn(credentials, "providerAccountProfile").mockReturnValue({
    id: "00000000-0000-4000-8000-000000000000",
    state: "disconnected",
  });
  vi.spyOn(providerEnv, "usesProviderApiKey").mockReturnValue(false);
  const gateway = new AgentGateway({
    projectRoot: "/tmp/zeros-account-switch",
    executionBoundary: testExecutionBoundary(),
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  });
  const prompt = vi.fn(async () => ({ response: { stopReason: "end_turn" } }));
  const internals = gateway as unknown as {
    adapters: Map<string, AgentAdapter>;
    executionToAgent: Map<string, string>;
  };
  internals.adapters.set("claude", {
    agentId: "claude",
    prompt,
  } as unknown as AgentAdapter);
  internals.executionToAgent.set("no-account", "claude");
  try {
    await expect(
      gateway.prompt("claude", "no-account", [{ type: "text", text: "hi" }]),
    ).rejects.toMatchObject({ failure: { kind: "auth-required" } });
    expect(prompt).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

it("retires an execution with an older account before dispatching a new prompt", async () => {
  const gateway = new AgentGateway({
    projectRoot: "/tmp/zeros-account-switch",
    executionBoundary: testExecutionBoundary(),
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  });
  const prompt = vi.fn(async () => ({ response: { stopReason: "end_turn" } }));
  const disposeSession = vi.fn(async () => {});
  const internals = gateway as unknown as {
    adapters: Map<string, AgentAdapter>;
    executionToAgent: Map<string, string>;
    executionAuthFingerprint: Map<string, string>;
  };
  internals.adapters.set("claude", {
    agentId: "claude",
    prompt,
    disposeSession,
  } as unknown as AgentAdapter);
  internals.executionToAgent.set("old-account", "claude");
  internals.executionAuthFingerprint = new Map([
    ["old-account", "old-authentication"],
  ]);
  await expect(
    gateway.prompt("claude", "old-account", [
      { type: "text", text: "next message" },
    ]),
  ).rejects.toMatchObject({ failure: { kind: "session-expired" } });
  expect(prompt).not.toHaveBeenCalled();
  expect(disposeSession).toHaveBeenCalledWith("old-account");
  expect(internals.executionToAgent.has("old-account")).toBe(false);
});
