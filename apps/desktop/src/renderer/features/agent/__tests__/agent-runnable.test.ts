import { describe, expect, it } from "vitest";

import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";
import { isRemovedAgent, isRunnableAgent } from "../agent-runnable";

function agent(
  id: string,
  overrides: Partial<BridgeRegistryAgent>,
): BridgeRegistryAgent {
  return {
    id,
    name: id,
    version: "",
    description: "",
    distribution: {},
    authBinary: id,
    ...overrides,
  };
}

describe("isRunnableAgent", () => {
  it("does not turn an unavailable contained auth probe into signed-out state", () => {
    const unavailable = {
      installed: true,
      authenticated: undefined,
      authenticationUnavailableReason:
        "Authentication could not be checked right now.",
    } as const;

    expect(isRunnableAgent(agent("codex", unavailable))).toBe(true);
    expect(isRunnableAgent(agent("claude", unavailable))).toBe(true);
    expect(isRunnableAgent(agent("cursor", unavailable))).toBe(true);
  });

  it("still blocks a confirmed signed-out CLI", () => {
    expect(
      isRunnableAgent(
        agent("codex", { installed: true, authenticated: false }),
      ),
    ).toBe(false);
  });
});

// Minimal registry fixtures — isRemovedAgent only reads `id`.
const agents = (...ids: string[]) =>
  ids.map((id) => ({ id })) as unknown as BridgeRegistryAgent[];
const FULL = agents("claude", "codex", "cursor");

describe("isRemovedAgent", () => {
  it("flags retired adapters and their persisted identifier variants", () => {
    expect(isRemovedAgent("gemini", FULL)).toBe(true);
    expect(isRemovedAgent("gemini-cli", FULL)).toBe(true);
    expect(isRemovedAgent("copilot", FULL)).toBe(true);
    expect(isRemovedAgent("github-copilot", FULL)).toBe(true);
    expect(isRemovedAgent("opencode", FULL)).toBe(true);
    expect(isRemovedAgent("factory-droid", FULL)).toBe(true);
    expect(isRemovedAgent("antigravity", FULL)).toBe(true);
  });

  it("never flags a current agent when a transient snapshot omits it", () => {
    expect(isRemovedAgent("claude", [])).toBe(false);
    expect(isRemovedAgent("claude", agents("codex"))).toBe(false);
    expect(isRemovedAgent("codex", [])).toBe(false);
  });

  it("resolves legacy current-agent identifiers by family", () => {
    expect(isRemovedAgent("claude-code", [])).toBe(false);
    expect(isRemovedAgent("@anthropic-ai/claude-code", [])).toBe(false);
    expect(isRemovedAgent("openai", [])).toBe(false);
  });

  it("flags a genuinely unknown id only after the registry has loaded", () => {
    expect(isRemovedAgent("totally-unknown-xyz", FULL)).toBe(true);
    expect(isRemovedAgent("totally-unknown-xyz", null)).toBe(false);
  });

  it("returns false for a missing id", () => {
    expect(isRemovedAgent(null, FULL)).toBe(false);
    expect(isRemovedAgent(undefined, FULL)).toBe(false);
    expect(isRemovedAgent("", FULL)).toBe(false);
  });
});
