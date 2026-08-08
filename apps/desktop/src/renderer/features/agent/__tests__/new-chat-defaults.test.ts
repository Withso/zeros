// Regression: the unified "default model" must round-trip through settings.toml
// without flipping the user's default AGENT. The mirror writes a bare model
// value to [models].default, and hydrate reads it back — on the same device the
// mirror's own write triggers a re-resolve that runs hydrate seconds later. A
// Cursor model whose value embeds another family's name (e.g.
// `claude-opus-4-8-thinking-high`) must NOT be substring-matched back to claude.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getDefaultAgentId,
  pickDefaultAgentId,
  setDefaultAgentId,
} from "../../settings/default-agent";
import {
  effectiveFavoriteModel,
  getFavoriteSelection,
  getFavoriteModel,
  migrateDefaultModelSelection,
  setFavoriteModel,
} from "../model-favorites";
import { defaultFavoriteModelFor } from "../model-catalog";
import {
  getChatTitleModel,
  hydrateModelsFromSettings,
  newChatBornDefaults,
  rememberModelConfiguration,
  rememberPermissionMode,
  resolveChatTitleModel,
  setChatTitleModel,
  setDefaultPlanMode,
} from "../new-chat-defaults";
import {
  DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES,
  getClaudeIdleTimeoutMinutes,
  isClaudeWakeupBeyondIdleTimeout,
  setClaudeIdleTimeoutMinutes,
} from "../reliability-settings";
import {
  resolveModelConfiguration,
  setModelPreference,
} from "../model-preferences";
import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";
import { getSetting, setSetting } from "../../../platform/settings";

// The test env is `environment: "node"`; native/settings is localStorage-backed.
// Install a minimal in-memory Storage so the default-agent / favorite caches work.
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  (globalThis as { localStorage?: Storage }).localStorage =
    fake as unknown as Storage;
}

describe("hydrateModelsFromSettings — default agent round-trip", () => {
  beforeEach(() => installLocalStorage());
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("keeps Cursor as the default when default_agent records it (no flip to claude)", () => {
    setDefaultAgentId("cursor");
    setFavoriteModel("cursor", "claude-opus-4-8-thinking-high");
    // The file the mirror writes, read back by hydrate.
    hydrateModelsFromSettings({
      default: "claude-opus-4-8-thinking-high",
      default_agent: "cursor",
    });
    expect(getDefaultAgentId()).toBe("cursor");
    expect(getFavoriteModel("cursor")).toBe("claude-opus-4-8-thinking-high");
  });

  it("does NOT misclassify a claude-branded Cursor model when only `default` is present", () => {
    // The reported bug: agentFamily() substring-matched the value → "claude" →
    // the default agent silently flipped. The 2026-07 curated catalog no longer
    // lists this Cursor model, so membership can't recover its family either —
    // the value must simply be IGNORED (no flip to claude, nothing written).
    hydrateModelsFromSettings({ default: "claude-opus-4-8-thinking-high" });
    expect(getDefaultAgentId()).toBeNull();
    expect(getFavoriteModel("claude")).toBeNull();
  });

  it("recovers a no-substring-match Cursor model from a legacy file via catalog membership", () => {
    hydrateModelsFromSettings({ default: "composer-2.5" });
    expect(getDefaultAgentId()).toBe("cursor");
    // composer-2.5 IS cursor's catalog fallback, so no raw star is forged —
    // resolution still lands on it.
    expect(getFavoriteModel("cursor")).toBeNull();
    expect(effectiveFavoriteModel("cursor")).toBe("composer-2.5");
  });

  it("round-trips a normal claude default unchanged", () => {
    hydrateModelsFromSettings({
      default: "claude-opus-4-8[1m]",
      default_agent: "claude",
    });
    expect(getDefaultAgentId()).toBe("claude");
    // A still-supported non-fallback model remains the exact global default.
    expect(effectiveFavoriteModel("claude")).toBe("claude-opus-4-8[1m]");
  });
});

describe("chat-title model (Settings → Models → Custom models)", () => {
  beforeEach(() => installLocalStorage());
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  const ALL = new Set(["claude", "codex", "cursor"]);

  it("defaults to Haiku and round-trips a specific pick", () => {
    expect(getChatTitleModel()).toBe("claude-haiku-4-5");
    setChatTitleModel("gpt-5.6-luna");
    expect(getChatTitleModel()).toBe("gpt-5.6-luna");
  });

  it("honors the saved pick when its agent is connected (or connectivity is unknown)", () => {
    setChatTitleModel("gpt-5.6-luna");
    expect(resolveChatTitleModel("claude", ALL)).toEqual({
      family: "codex",
      model: "gpt-5.6-luna",
    });
    // Registry not loaded yet → trust the pick.
    expect(resolveChatTitleModel("claude", null)).toEqual({
      family: "codex",
      model: "gpt-5.6-luna",
    });
  });

  it("falls down the chain when the pick's agent is disconnected", () => {
    // Default Haiku, but Claude not connected → Luna.
    expect(
      resolveChatTitleModel("codex", new Set(["codex", "cursor"])),
    ).toEqual({ family: "codex", model: "gpt-5.6-luna" });
    // Only Cursor connected → Composer 2.5.
    expect(resolveChatTitleModel("cursor", new Set(["cursor"]))).toEqual({
      family: "cursor",
      model: "composer-2.5",
    });
  });

  it("distrusts an all-disconnected snapshot and titles through the chat's own family", () => {
    expect(resolveChatTitleModel("cursor", new Set())).toEqual({
      family: "cursor",
      model: "composer-2.5",
    });
    // Unknown/retired agent AND nothing connected → no AI titling.
    expect(resolveChatTitleModel("gemini", new Set())).toBeNull();
  });

  it('hydrates from settings.toml; absence, the retired "default", and garbage all mean Haiku', () => {
    hydrateModelsFromSettings({ chat_title_model: "composer-2.5" });
    expect(getChatTitleModel()).toBe("composer-2.5");
    // The mirror deletes the key for the Haiku default, so absence IS the value.
    hydrateModelsFromSettings({});
    expect(getChatTitleModel()).toBe("claude-haiku-4-5");
    hydrateModelsFromSettings({ chat_title_model: "default" });
    expect(getChatTitleModel()).toBe("claude-haiku-4-5");
    hydrateModelsFromSettings({ chat_title_model: "gpt-9-mega" });
    expect(getChatTitleModel()).toBe("claude-haiku-4-5");
  });
});

describe("Claude idle timeout (Settings → Models → Claude)", () => {
  beforeEach(() => installLocalStorage());
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("defaults to 30 minutes and accepts only the four bounded choices", () => {
    expect(getClaudeIdleTimeoutMinutes()).toBe(
      DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES,
    );
    for (const value of [60, 120, 300] as const) {
      setClaudeIdleTimeoutMinutes(value);
      expect(getClaudeIdleTimeoutMinutes()).toBe(value);
    }
    setClaudeIdleTimeoutMinutes(999 as never);
    expect(getClaudeIdleTimeoutMinutes()).toBe(
      DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES,
    );
  });

  it("hydrates a persisted choice and treats an absent or invalid value as the default", () => {
    hydrateModelsFromSettings({
      claude_code: { idle_timeout_minutes: 300 },
    });
    expect(getClaudeIdleTimeoutMinutes()).toBe(300);

    hydrateModelsFromSettings({});
    expect(getClaudeIdleTimeoutMinutes()).toBe(30);

    setClaudeIdleTimeoutMinutes(120);
    hydrateModelsFromSettings({
      claude_code: { idle_timeout_minutes: 999 },
    });
    expect(getClaudeIdleTimeoutMinutes()).toBe(30);
  });

  it("warns only when a future wake-up is strictly beyond the chosen timeout", () => {
    const now = 10_000;
    expect(isClaudeWakeupBeyondIdleTimeout(now + 30 * 60_000, 30, now)).toBe(
      false,
    );
    expect(
      isClaudeWakeupBeyondIdleTimeout(now + 30 * 60_000 + 1, 30, now),
    ).toBe(true);
    expect(isClaudeWakeupBeyondIdleTimeout(now - 1, 30, now)).toBe(false);
    expect(isClaudeWakeupBeyondIdleTimeout(Number.NaN, 30, now)).toBe(false);
  });
});

// ── One global default model + per-family product fallbacks ──

describe("favorite models — catalog fallbacks + user stars", () => {
  beforeEach(() => installLocalStorage());
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("falls back to the curated defaultFavorites when nothing is starred", () => {
    expect(defaultFavoriteModelFor("claude")).toBe("claude-opus-5[1m]");
    expect(defaultFavoriteModelFor("codex")).toBe("gpt-5.6-sol");
    expect(defaultFavoriteModelFor("cursor")).toBe("composer-2.5");
    expect(effectiveFavoriteModel("claude")).toBe("claude-opus-5[1m]");
    expect(effectiveFavoriteModel("codex")).toBe("gpt-5.6-sol");
    expect(effectiveFavoriteModel("cursor")).toBe("composer-2.5");
  });

  it("keeps exactly one favorite globally and clearing it reverts to the family fallback", () => {
    setFavoriteModel("claude", "claude-fable-5[1m]");
    expect(effectiveFavoriteModel("claude")).toBe("claude-fable-5[1m]");
    setFavoriteModel("codex", "gpt-5.6-terra");
    expect(getFavoriteModel("claude")).toBeNull();
    expect(getFavoriteModel("codex")).toBe("gpt-5.6-terra");
    expect(getFavoriteSelection()).toEqual({
      agentId: "codex",
      model: "gpt-5.6-terra",
    });
    setFavoriteModel("claude", null);
    expect(getFavoriteModel("claude")).toBeNull();
    expect(effectiveFavoriteModel("claude")).toBe("claude-opus-5[1m]");
  });

  it("reads the legacy pair without writing, then normalizes it once at boot", () => {
    // Every model surface calls this during render, so the read must be pure —
    // a render-phase localStorage write is a side effect React may double-run
    // or discard. The boot step is the only writer.
    setSetting("default-agent-id", "claude");
    setSetting("favorite-models-by-family", { claude: "claude-fable-5[1m]" });
    expect(getFavoriteSelection()).toEqual({
      agentId: "claude",
      model: "claude-fable-5[1m]",
    });
    expect(getSetting("default-model-selection", null)).toBeNull();

    expect(migrateDefaultModelSelection()).toBe(true);
    expect(getSetting("default-model-selection", null)).toEqual({
      agentId: "claude",
      model: "claude-fable-5[1m]",
    });
    // Idempotent, and it never overwrites a real selection.
    expect(migrateDefaultModelSelection()).toBe(false);
    setFavoriteModel("codex", "gpt-5.6-terra");
    expect(migrateDefaultModelSelection()).toBe(false);
    expect(getFavoriteSelection()).toEqual({
      agentId: "codex",
      model: "gpt-5.6-terra",
    });
  });

  // The old composer's star deliberately never set `default-agent-id`, so a
  // user who only ever starred a model has favorites and no agent id. Requiring
  // the agent id to read the star dropped that choice on upgrade — and the
  // mirror then deleted the durable copy from settings.toml.
  it("carries a legacy star that was saved without any default agent", () => {
    setSetting("favorite-models-by-family", { claude: "claude-sonnet-5[1m]" });

    expect(getFavoriteSelection()).toEqual({
      agentId: "claude",
      model: "claude-sonnet-5[1m]",
    });
    expect(effectiveFavoriteModel("claude")).toBe("claude-sonnet-5[1m]");
    expect(getDefaultAgentId()).toBe("claude");
    expect(newChatBornDefaults("claude").model).toBe("claude-sonnet-5[1m]");
    expect(migrateDefaultModelSelection()).toBe(true);
  });

  // Two stars and no recorded default is a real ambiguity: the old model let
  // all three coexist and nothing in storage says which one was the user's
  // default. Forging an agent identity out of that would silently move their
  // provider, so those keep resolving through the catalog fallbacks.
  it("does not forge an agent from an ambiguous multi-family legacy map", () => {
    setSetting("favorite-models-by-family", {
      claude: "claude-sonnet-5[1m]",
      codex: "gpt-5.5",
    });

    expect(getFavoriteSelection()).toBeNull();
    expect(getDefaultAgentId()).toBeNull();
    expect(effectiveFavoriteModel("claude")).toBe("claude-opus-5[1m]");
  });

  it("migrates a settings.toml favorites table that carries no default", () => {
    hydrateModelsFromSettings({ favorites: { cursor: "grok-4.5-xhigh" } });

    expect(getDefaultAgentId()).toBe("cursor");
    expect(getFavoriteModel("cursor")).toBe("grok-4.5-xhigh");
  });

  it("ignores a stale star for a since-retired model id (catalog update)", () => {
    // A pre-v4-catalog user starred Opus 4.7; the id is gone. New chats must
    // NOT be born with a dead model — resolution falls to the fallback while
    // the raw star stays in storage (a future catalog could revive it).
    setFavoriteModel("claude", "claude-opus-4-7");
    expect(getFavoriteModel("claude")).toBe("claude-opus-4-7");
    expect(effectiveFavoriteModel("claude")).toBe("claude-opus-5[1m]");
    expect(newChatBornDefaults("claude").model).toBe("claude-opus-5[1m]");
  });

  it("newChatBornDefaults opens on the effective favorite at High effort", () => {
    expect(newChatBornDefaults("claude").model).toBe("claude-opus-5[1m]");
    expect(newChatBornDefaults("claude").effort).toBe("high");
    expect(newChatBornDefaults("codex").model).toBe("gpt-5.6-sol");
    expect(newChatBornDefaults("codex").effort).toBe("high");
    expect(newChatBornDefaults("cursor").model).toBe("composer-2.5");
    setFavoriteModel("codex", "gpt-5.5");
    expect(newChatBornDefaults("codex").model).toBe("gpt-5.5");
  });

  it("uses Auto / Approve for me / Auto as the exact first-use permission defaults", () => {
    expect(newChatBornDefaults("claude")).toMatchObject({
      permissionMode: "auto",
      lastModeId: "auto",
    });
    expect(newChatBornDefaults("codex")).toMatchObject({
      permissionMode: "auto",
      lastModeId: "auto-edit",
    });
    expect(newChatBornDefaults("cursor")).toMatchObject({
      permissionMode: "auto",
      lastModeId: "auto",
    });
  });

  it("restores each agent's last exact permission choice in future chats", () => {
    rememberPermissionMode("claude", "accept-edits");
    rememberPermissionMode("codex", "ask");

    expect(newChatBornDefaults("claude")).toMatchObject({
      permissionMode: "auto",
      lastModeId: "accept-edits",
    });
    expect(newChatBornDefaults("codex")).toMatchObject({
      permissionMode: "tool-approval",
      lastModeId: "ask",
    });
    expect(newChatBornDefaults("cursor")).toMatchObject({
      permissionMode: "auto",
      lastModeId: "auto",
    });
  });

  // Bypass / Full access turn off the prompts that stand between an agent and
  // the machine. One chat's escape hatch must not silently become the posture
  // every later chat is born in — the composer's permission pill is icon-only
  // at rest, so an inherited escalation carries no visible label at all. The
  // escalation still applies to the chat that asked for it.
  it("keeps a danger escalation out of every future chat's birth posture", () => {
    rememberPermissionMode("claude", "accept-edits");
    rememberPermissionMode("claude", "bypass");
    rememberPermissionMode("codex", "full-access");
    rememberPermissionMode("cursor", "agent");

    expect(newChatBornDefaults("claude")).toMatchObject({
      permissionMode: "auto",
      lastModeId: "accept-edits",
    });
    expect(newChatBornDefaults("codex")).toMatchObject({
      permissionMode: "auto",
      lastModeId: "auto-edit",
    });
    expect(newChatBornDefaults("cursor")).toMatchObject({
      permissionMode: "auto",
      lastModeId: "auto",
    });
  });

  it("lets the explicit plan default override and then reveal remembered modes", () => {
    rememberPermissionMode("claude", "default");
    rememberPermissionMode("codex", "ask");
    setDefaultPlanMode(true);

    expect(newChatBornDefaults("claude")).toMatchObject({
      permissionMode: "plan",
      lastModeId: "plan",
    });
    // Codex intentionally exposes no Plan mode in the composer.
    expect(newChatBornDefaults("codex")).toMatchObject({
      permissionMode: "tool-approval",
      lastModeId: "ask",
    });
    expect(newChatBornDefaults("cursor")).toMatchObject({
      permissionMode: "plan",
      lastModeId: "plan",
    });

    setDefaultPlanMode(false);
    expect(newChatBornDefaults("claude")).toMatchObject({
      permissionMode: "tool-approval",
      lastModeId: "default",
    });
  });

  it("migrates legacy per-family stars to only the selected default agent", () => {
    hydrateModelsFromSettings({
      default_agent: "claude",
      favorites: { claude: "claude-sonnet-5[1m]", cursor: "grok-4.5-xhigh" },
    });
    expect(getFavoriteModel("claude")).toBe("claude-sonnet-5[1m]");
    expect(getFavoriteModel("cursor")).toBeNull();
  });

  it("does NOT forge a user star from a legacy `default` that matches the fallback", () => {
    // The mirror writes default = the EFFECTIVE favorite even when the user
    // never starred anything (and an all-null favorites table drops out of
    // the file). Hydrating that back must not turn the code-level fallback
    // into a durable user star — future defaultFavorites bumps must still
    // reach this user.
    hydrateModelsFromSettings({
      default: "claude-opus-5[1m]",
      default_agent: "claude",
    });
    expect(getDefaultAgentId()).toBe("claude");
    expect(getFavoriteModel("claude")).toBeNull();
    expect(effectiveFavoriteModel("claude")).toBe("claude-opus-5[1m]");
    // A legacy default that DIFFERS from the fallback is a real user pick —
    // it still seeds the star.
    hydrateModelsFromSettings({
      default: "claude-fable-5[1m]",
      default_agent: "claude",
    });
    expect(getFavoriteModel("claude")).toBe("claude-fable-5[1m]");
  });

  it("a favorites table wins over the legacy bare `default` for the same family", () => {
    hydrateModelsFromSettings({
      default: "claude-opus-4-8[1m]",
      default_agent: "claude",
      favorites: { claude: "claude-fable-5[1m]" },
    });
    expect(getDefaultAgentId()).toBe("claude");
    expect(getFavoriteModel("claude")).toBe("claude-fable-5[1m]");
  });

  it("hydrates exact-model effort/Fast memory without leaking it to a sibling", () => {
    hydrateModelsFromSettings({
      default: "gpt-5.6-sol",
      default_agent: "codex",
      model_preferences: [
        {
          agent: "codex",
          model: "gpt-5.6-sol",
          effort: "max",
          fast: true,
        },
        {
          agent: "codex",
          model: "gpt-5.6-terra",
          effort: "medium",
          fast: false,
        },
      ],
    });

    expect(newChatBornDefaults("codex")).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "max",
      fast: true,
    });
    expect(resolveModelConfiguration("codex", "gpt-5.6-terra", null)).toEqual({
      effort: "medium",
      fast: false,
    });
  });

  it("hydrates exact permission memory and treats an explicit empty array as a clear", () => {
    hydrateModelsFromSettings({
      permission_preferences: [
        { agent: "claude", mode: "bypass" },
        { agent: "codex", mode: "ask" },
      ],
    });

    expect(newChatBornDefaults("claude")).toMatchObject({
      permissionMode: "danger",
      lastModeId: "bypass",
    });
    expect(newChatBornDefaults("codex")).toMatchObject({
      permissionMode: "tool-approval",
      lastModeId: "ask",
    });

    hydrateModelsFromSettings({ permission_preferences: [] });
    expect(newChatBornDefaults("claude")).toMatchObject({
      permissionMode: "auto",
      lastModeId: "auto",
    });
    expect(newChatBornDefaults("codex")).toMatchObject({
      permissionMode: "auto",
      lastModeId: "auto-edit",
    });
  });

  it("treats an explicit empty exact-model array as an authoritative clear", () => {
    setFavoriteModel("codex", "gpt-5.6-terra");
    setModelPreference("codex", "gpt-5.6-sol", {
      effort: "max",
      fast: true,
    });

    hydrateModelsFromSettings({ model_preferences: [] });

    expect(getDefaultAgentId()).toBeNull();
    expect(resolveModelConfiguration("codex", "gpt-5.6-sol", null)).toEqual({
      effort: "high",
      fast: false,
    });
  });

  it("round-trips an extension-provided default agent even when its model id overlaps a curated family", () => {
    hydrateModelsFromSettings({
      default_agent: "extension-agent",
      default: "gpt-5.6-sol",
      model_preferences: [],
    });

    expect(getDefaultAgentId()).toBe("extension-agent");
  });

  it("migrates legacy family effort/global Fast only onto the selected model", () => {
    hydrateModelsFromSettings({
      default: "gpt-5.6-sol",
      default_agent: "codex",
      default_fast_mode: true,
      codex: { default_thinking_level: "max" },
    });

    expect(newChatBornDefaults("codex")).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "max",
      fast: true,
    });
    expect(resolveModelConfiguration("codex", "gpt-5.6-terra", null)).toEqual({
      effort: "high",
      fast: false,
    });
  });

  it("moves local legacy values once, then clears their migration inputs", () => {
    setSetting("default-effort-by-family", { codex: "max" });
    setSetting("default-fast-mode", true);

    expect(newChatBornDefaults("codex")).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "max",
      fast: true,
    });
    expect(getSetting("default-effort-by-family", { codex: "stale" })).toEqual(
      {},
    );
    expect(getSetting("default-fast-mode", true)).toBe(false);
  });

  it("does not let an early default read mask durable legacy settings hydration", () => {
    expect(newChatBornDefaults("codex")).toMatchObject({
      effort: "high",
      fast: false,
    });

    hydrateModelsFromSettings({
      default: "gpt-5.6-sol",
      default_agent: "codex",
      default_fast_mode: true,
      codex: { default_thinking_level: "max" },
    });

    expect(newChatBornDefaults("codex")).toMatchObject({
      effort: "max",
      fast: true,
    });
  });

  it("does not discard another family's legacy effort before that family migrates", () => {
    setSetting("default-effort-by-family", { claude: "max" });

    expect(newChatBornDefaults("codex").effort).toBe("high");
    expect(newChatBornDefaults("claude").effort).toBe("max");
  });

  // Migration is ONE-SHOT: the marker it writes makes every later call a no-op,
  // and it clears the whole legacy map. A family left unmigrated in that single
  // pass therefore loses its value permanently — Claude's Max silently became
  // High for anyone whose default agent was Codex.
  it("migrates every family's legacy effort in the one pass it gets", () => {
    setSetting("default-effort-by-family", { claude: "max", codex: "low" });

    expect(newChatBornDefaults("codex").effort).toBe("low");
    expect(newChatBornDefaults("claude").effort).toBe("max");
    expect(getSetting("default-effort-by-family", { codex: "stale" })).toEqual(
      {},
    );
  });

  it("migrates every family's durable legacy effort from settings.toml", () => {
    hydrateModelsFromSettings({
      default: "gpt-5.6-sol",
      default_agent: "codex",
      claude_code: { default_effort_level: "max" },
      codex: { default_thinking_level: "low" },
    });

    expect(newChatBornDefaults("codex").effort).toBe("low");
    expect(newChatBornDefaults("claude").effort).toBe("max");
  });

  // The legacy effort belongs to the family's own selected model, never to
  // whichever model the migrating family happened to be on.
  it("lands each migrated family's effort on that family's own model", () => {
    setFavoriteModel("claude", "claude-sonnet-5[1m]");
    setSetting("default-effort-by-family", { claude: "max", codex: "low" });

    newChatBornDefaults("codex");

    expect(
      resolveModelConfiguration("claude", "claude-sonnet-5[1m]", null),
    ).toEqual({ effort: "max", fast: false });
    expect(
      resolveModelConfiguration("claude", "claude-opus-5[1m]", null),
    ).toEqual({ effort: "high", fast: false });
  });

  it("merges a first interactive change with unmigrated legacy state", () => {
    setSetting("default-effort-by-family", { codex: "max" });
    setSetting("default-fast-mode", true);

    rememberModelConfiguration("codex", "gpt-5.6-sol", { fast: false });

    expect(resolveModelConfiguration("codex", "gpt-5.6-sol", null)).toEqual({
      effort: "max",
      fast: false,
    });
  });
});

describe("default agent — deterministic connected-provider preference", () => {
  beforeEach(() => installLocalStorage());
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  // authenticated:true is the strongest isRunnableAgent() branch — enough
  // to make the fake pass the runnable filter without provider-prefs state.
  const agent = (id: string): BridgeRegistryAgent =>
    ({ id, name: id, authenticated: true }) as unknown as BridgeRegistryAgent;

  it("prefers Codex over Claude over Cursor regardless of registry order", () => {
    expect(getDefaultAgentId()).toBeNull();
    expect(
      pickDefaultAgentId([agent("codex"), agent("claude"), agent("cursor")]),
    ).toBe("codex");
    expect(pickDefaultAgentId([agent("cursor"), agent("claude")])).toBe(
      "claude",
    );
    expect(pickDefaultAgentId([agent("cursor"), agent("codex")])).toBe("codex");
    expect(pickDefaultAgentId([agent("claude"), agent("codex")])).toBe("codex");
    expect(pickDefaultAgentId([agent("codex")])).toBe("codex");
    expect(pickDefaultAgentId([agent("cursor")])).toBe("cursor");
    expect(pickDefaultAgentId([agent("claude")])).toBe("claude");
  });

  it("applies provider priority only across agents enabled for chat", () => {
    localStorage.setItem(
      "zeros.agent.enabledAgents",
      JSON.stringify({ ids: ["cursor"] }),
    );

    expect(
      pickDefaultAgentId([agent("codex"), agent("claude"), agent("cursor")]),
    ).toBe("cursor");
  });

  it("honors an explicit default over provider priority", () => {
    setDefaultAgentId("cursor");
    expect(getFavoriteSelection()).toEqual({ agentId: "cursor", model: null });
    expect(
      pickDefaultAgentId([agent("codex"), agent("claude"), agent("cursor")]),
    ).toBe("cursor");
  });

  it("falls back to provider priority when the explicit default is disconnected", () => {
    setDefaultAgentId("cursor");
    expect(pickDefaultAgentId([agent("claude"), agent("codex")])).toBe("codex");
  });

  it("degrades deterministically for unknown runnable agents", () => {
    expect(pickDefaultAgentId([agent("other-b"), agent("other-a")])).toBe(
      "other-b",
    );
  });

  it("does not let an old curated default shadow an extension-provided default", () => {
    setDefaultAgentId("cursor");
    setDefaultAgentId("extension-agent");

    expect(getDefaultAgentId()).toBe("extension-agent");
    expect(pickDefaultAgentId([agent("codex"), agent("extension-agent")])).toBe(
      "extension-agent",
    );
  });
});
