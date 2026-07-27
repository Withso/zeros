// Regression coverage for isRemovedAgent — the "Agent no longer available"
// card was firing for a live Claude chat (snapshot transiently missing
// "claude" / a legacy variant id), even though Claude is a current agent.
// The card must ONLY appear for genuinely retired adapters (gemini, copilot,
// and the 2026-06-16 ACP-retired set: opencode, factory-droid, antigravity).

import { describe, expect, it } from "vitest";

import { isRemovedAgent } from "../agent-runnable";
import type { BridgeRegistryAgent } from "../../bridge/messages";

// Minimal registry fixtures — isRemovedAgent only reads `id`.
const agents = (...ids: string[]) =>
  ids.map((id) => ({ id })) as unknown as BridgeRegistryAgent[];
const FULL = agents("claude", "codex", "cursor");

describe("isRemovedAgent", () => {
  it("flags retired adapters (gemini, copilot, opencode, droid, antigravity) + variants", () => {
    expect(isRemovedAgent("gemini", FULL)).toBe(true);
    expect(isRemovedAgent("gemini-cli", FULL)).toBe(true);
    expect(isRemovedAgent("copilot", FULL)).toBe(true);
    expect(isRemovedAgent("github-copilot", FULL)).toBe(true);
    // Retired 2026-06-16 alongside the ACP fabric.
    expect(isRemovedAgent("opencode", FULL)).toBe(true);
    expect(isRemovedAgent("factory-droid", FULL)).toBe(true);
    expect(isRemovedAgent("antigravity", FULL)).toBe(true);
  });

  it("NEVER flags a current agent — even when the snapshot lacks it (the bug)", () => {
    // This is the reported regression: a Claude chat showing "removed".
    expect(isRemovedAgent("claude", [])).toBe(false);
    expect(isRemovedAgent("claude", agents("codex"))).toBe(false);
    expect(isRemovedAgent("codex", [])).toBe(false);
  });

  it("resolves legacy/variant ids to their current family (not removed)", () => {
    expect(isRemovedAgent("claude-code", [])).toBe(false);
    expect(isRemovedAgent("@anthropic-ai/claude-code", [])).toBe(false);
    expect(isRemovedAgent("openai", [])).toBe(false);
  });

  it("flags a genuinely unknown id only once the registry has loaded", () => {
    expect(isRemovedAgent("totally-unknown-xyz", FULL)).toBe(true);
    // Still loading → no cold-start flash.
    expect(isRemovedAgent("totally-unknown-xyz", null)).toBe(false);
  });

  it("returns false for a missing id", () => {
    expect(isRemovedAgent(null, FULL)).toBe(false);
    expect(isRemovedAgent(undefined, FULL)).toBe(false);
    expect(isRemovedAgent("", FULL)).toBe(false);
  });
});
