import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";
import { setModelPreference } from "../../../features/agent/model-preferences";
import {
  clearProvisionalBindings,
  rememberProvisionalBinding,
  resolveAutoBindChatSettings,
  takeProvisionalBinding,
} from "../auto-bind-chat";

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

  it("never waits for the registry — a cold snapshot resolves the same product default", () => {
    // Still loading. Binding anyway is the point: the composer paints now and
    // the guess is reconciled once the live list lands. Blocking here would put
    // a spinner + timeout in front of a data waterfall.
    const provisional = resolveAutoBindChatSettings(null);
    // Loaded-but-empty (zero adapters / failed list). A chat must still get
    // an agent — the composer's spawn error is actionable, a dead pane isn't.
    const empty = resolveAutoBindChatSettings([]);
    for (const settings of [provisional, empty]) {
      expect(settings).toMatchObject({
        agentId: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        fast: false,
      });
    }
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

  it("keeps a repaired chat's own model and configuration on its own family", () => {
    // sanitizeCachedChat preserves model/effort/fast while nulling agentId, and
    // this path exists for exactly that shape: the chat resumes the same
    // provider session, so it must not resume it under a different model. The
    // star's own remembered effort (low, below) is what a NEW chat would get.
    setModelPreference("claude", "claude-opus-5[1m]", { effort: "low" });
    expect(
      resolveAutoBindChatSettings(
        [agent("claude"), agent("codex")],
        null,
        undefined,
        {
          agentName: "Claude",
          sessionId: "sess-claude-1",
          model: "claude-opus-4-8[1m]",
          effort: "max",
          fast: true,
          permissionMode: "plan",
          lastModeId: "plan",
        },
      ),
    ).toMatchObject({
      agentId: "claude",
      sessionId: "sess-claude-1",
      model: "claude-opus-4-8[1m]",
      effort: "max",
      fast: true,
      permissionMode: "plan",
      lastModeId: "plan",
    });
  });

  it("repairs a prior configuration the current catalog can no longer honor", () => {
    // Luna's ladder stops at xhigh, so a record written when it advertised
    // `ultracode` is clamped rather than carried forward.
    expect(
      resolveAutoBindChatSettings([agent("codex")], null, undefined, {
        agentName: "Codex",
        model: "gpt-5.6-luna",
        effort: "ultracode",
        fast: true,
      }),
    ).toMatchObject({ model: "gpt-5.6-luna", effort: "high", fast: true });
    // Sonnet 5 has no Fast mode — the stored flag cannot claim otherwise.
    expect(
      resolveAutoBindChatSettings([agent("claude")], null, undefined, {
        agentName: "Claude",
        model: "claude-sonnet-5[1m]",
        effort: "max",
        fast: true,
      }),
    ).toMatchObject({
      model: "claude-sonnet-5[1m]",
      effort: "max",
      fast: false,
    });
    // A model the resolved agent doesn't offer at all falls back to the global
    // default rather than stamping a value the agent would reject.
    expect(
      resolveAutoBindChatSettings([agent("claude")], null, undefined, {
        agentName: "Claude",
        model: "gpt-5.6-sol",
        effort: "max",
      }),
    ).toMatchObject({ model: "claude-opus-5[1m]" });
    // A different family can't vouch for the configuration either.
    expect(
      resolveAutoBindChatSettings([agent("codex")], null, undefined, {
        agentName: "Claude",
        model: "claude-sonnet-5[1m]",
        effort: "max",
      }),
    ).toMatchObject({ agentId: "codex", model: "gpt-5.6-sol", effort: "high" });
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

describe("provisional bindings", () => {
  beforeEach(() => {
    installLocalStorage();
    clearProvisionalBindings();
  });
  afterEach(() => {
    clearProvisionalBindings();
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("hands back the PRE-guess identity, exactly once", () => {
    rememberProvisionalBinding("chat-1", {
      agentName: "Claude",
      sessionId: "sess-1",
    });
    expect(takeProvisionalBinding("chat-1")).toEqual({
      agentName: "Claude",
      sessionId: "sess-1",
    });
    // One-shot: a reconciled chat is never re-resolved on a later registry
    // refresh, which is what keeps the user's own later pick from being undone.
    expect(takeProvisionalBinding("chat-1")).toBeNull();
    expect(takeProvisionalBinding("never-bound")).toBeNull();
  });

  // Reconciling with the GUESS as `prior` would pin it: priorFamily outranks
  // the global default by design, so the guessed family would win forever.
  it("re-resolves from the live registry instead of the guess", () => {
    const cold = resolveAutoBindChatSettings(null, null, undefined, {});
    expect(cold.agentId).toBe("codex");
    rememberProvisionalBinding("chat-2", {});
    const prior = takeProvisionalBinding("chat-2");
    expect(prior).toEqual({});
    // Live list: only Claude is present, so the codex guess must not survive.
    expect(
      resolveAutoBindChatSettings([agent("claude")], null, undefined, prior!),
    ).toMatchObject({ agentId: "claude", model: "claude-opus-5[1m]" });
  });

  it("bounds the pending map instead of growing with every chat", () => {
    for (let index = 0; index < 40; index += 1) {
      rememberProvisionalBinding(`chat-${index}`, { agentName: `a-${index}` });
    }
    // 32 most recent survive; the oldest guesses are dropped, not leaked.
    expect(takeProvisionalBinding("chat-0")).toBeNull();
    expect(takeProvisionalBinding("chat-7")).toBeNull();
    expect(takeProvisionalBinding("chat-8")).toEqual({ agentName: "a-8" });
    expect(takeProvisionalBinding("chat-39")).toEqual({ agentName: "a-39" });
  });
});
