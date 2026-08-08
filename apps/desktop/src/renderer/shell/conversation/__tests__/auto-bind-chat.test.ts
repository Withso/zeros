import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";
import { setModelPreference } from "../../../features/agent/model-preferences";
import { resolveAutoBindChatSettings } from "../auto-bind-chat";

function installLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

const agent = (id: string): BridgeRegistryAgent =>
  ({ id, name: id, authenticated: true }) as unknown as BridgeRegistryAgent;

const detectedAgent = (
  id: string,
  overrides: Partial<{ installed: boolean; authenticated: boolean }> = {},
): BridgeRegistryAgent =>
  ({
    id,
    name: id,
    installed: overrides.installed ?? false,
    authenticated: overrides.authenticated ?? false,
    authBinary: id,
  }) as unknown as BridgeRegistryAgent;

describe("cold chat default binding", () => {
  beforeEach(installLocalStorage);
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("waits only while the registry is loading, never once it answered", () => {
    // Still loading — wait for the authoritative list.
    expect(resolveAutoBindChatSettings(null)).toBeNull();
    // Loaded-but-empty (zero adapters / failed list). A chat must still get
    // an agent — the composer's spawn error is actionable, a dead pane isn't.
    expect(resolveAutoBindChatSettings([])).toMatchObject({
      agentId: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      fast: false,
    });
  });

  it("binds the best detected agent when nothing is signed in yet", () => {
    // Fresh machine: CLIs detected, nobody authenticated. The chat binds so
    // AgentChat's "Sign in required" flow can take over — never a blank pane.
    expect(
      resolveAutoBindChatSettings([
        detectedAgent("claude", { installed: true }),
        detectedAgent("cursor", { installed: true }),
      ]),
    ).toMatchObject({ agentId: "claude", model: "claude-opus-5[1m]" });
    // Installed beats merely-listed within the same product order.
    expect(
      resolveAutoBindChatSettings([
        detectedAgent("codex"),
        detectedAgent("claude", { installed: true }),
      ]),
    ).toMatchObject({ agentId: "claude" });
    // A runnable agent still outranks every not-ready one.
    expect(
      resolveAutoBindChatSettings([
        detectedAgent("codex", { installed: true }),
        agent("cursor"),
      ]),
    ).toMatchObject({ agentId: "cursor", model: "composer-2.5" });
  });

  it("binds agent, fallback model, and exact default configuration together", () => {
    expect(resolveAutoBindChatSettings([agent("claude")])).toMatchObject({
      agentId: "claude",
      model: "claude-opus-5[1m]",
      effort: "high",
      fast: false,
    });
    expect(
      resolveAutoBindChatSettings([agent("claude"), agent("codex")]),
    ).toMatchObject({
      agentId: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      fast: false,
    });
    expect(resolveAutoBindChatSettings([agent("cursor")])).toMatchObject({
      agentId: "cursor",
      model: "composer-2.5",
      effort: "high",
      fast: false,
    });
  });

  it("restores the selected default model's remembered configuration", () => {
    setModelPreference("codex", "gpt-5.6-sol", {
      effort: "max",
      fast: true,
    });
    expect(resolveAutoBindChatSettings([agent("codex")])).toMatchObject({
      agentId: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
      fast: true,
      sessionId: undefined,
      lastModeId: "auto-edit",
      prePlanModeId: undefined,
    });
  });

  it("returns a repaired chat to its own agent, keeping a same-agent session", () => {
    const registry = [agent("claude"), agent("codex")];
    // Codex would win the product order, but this chat already ran on Claude.
    expect(
      resolveAutoBindChatSettings(registry, null, undefined, {
        agentName: "Claude",
        sessionId: "sess-claude-1",
      }),
    ).toMatchObject({ agentId: "claude", sessionId: "sess-claude-1" });
  });

  it("drops a session id that the rebound agent could not resume", () => {
    // Prior agent is gone from the registry, so the chat lands on Codex — a
    // Claude session id would fail the load and strand the chat in an error.
    expect(
      resolveAutoBindChatSettings([agent("codex")], null, undefined, {
        agentName: "Claude",
        sessionId: "sess-claude-1",
      }),
    ).toMatchObject({ agentId: "codex", sessionId: undefined });
    // An unidentifiable prior agent can never vouch for the session either.
    expect(
      resolveAutoBindChatSettings([agent("codex")], null, undefined, {
        agentName: "some-extension-agent",
        sessionId: "sess-unknown-1",
      }),
    ).toMatchObject({ agentId: "codex", sessionId: undefined });
  });
});
