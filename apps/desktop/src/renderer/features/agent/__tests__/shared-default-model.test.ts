import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";
import { setSetting } from "../../../platform/settings";
import { FALLBACK_NEW_CHAT_AGENT_ID, getDefaultAgentId, pickAgentForNewChat, pickDefaultAgentId } from "../../settings/default-agent";
import { getFavoriteSelection, setFavoriteModel } from "../model-favorites";
import { defaultFavoriteModelFor, resolveModelOption } from "../model-catalog";
import { getModelPreference, resolveModelConfiguration, setModelPreference } from "../model-preferences";
import { hasModelDefaults, hydrateModelsFromSettings, newChatBornDefaults } from "../new-chat-defaults";

const families = ["claude", "codex", "cursor"] as const;
const models = { claude: "claude-opus-5-5[1m]", codex: "gpt-6.1-sol", cursor: "grok-4.7" };
const efforts = { claude: "medium", codex: "max", cursor: "xhigh" };
const registry = (mask: number): BridgeRegistryAgent[] => families.map((id, index) => ({
  id, name: id, version: "fixture", description: "fixture", distribution: {},
  installed: true, authBinary: id, authenticated: Boolean(mask & (1 << index)),
}));
const masks = Array.from({ length: 8 }, (_, mask) => mask);

beforeEach(() => {
  const values = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(), key: () => null, length: 0,
  };
});
afterEach(() => { delete (globalThis as { localStorage?: Storage }).localStorage; });

describe("shared default model policy", () => {
  it.each(masks)("uses confirmed connections and the same installed fallback for combination %i", mask => {
    const expected = mask & 1 ? "claude" : mask & 2 ? "codex" : mask & 4 ? "cursor" : "claude";
    for (const agents of [registry(mask), registry(mask).reverse()]) {
      expect(pickDefaultAgentId(agents)).toBe(expected);
      expect(pickAgentForNewChat(agents)?.id).toBe(expected);
      expect(newChatBornDefaults(expected)).toMatchObject({ model: models[expected], effort: efforts[expected], fast: false });
    }
    expect(getDefaultAgentId()).toBeNull();
    expect(getFavoriteSelection()).toBeNull();
  });

  it.each(masks)("keeps a saved model and provider regardless of connection combination %i", mask => {
    setFavoriteModel("claude", "claude-sonnet-5-5[1m]");
    expect(pickDefaultAgentId(registry(mask))).toBe("claude");
    expect(pickAgentForNewChat(registry(mask))?.id).toBe("claude");
    expect(newChatBornDefaults("claude")).toMatchObject({ model: "claude-sonnet-5-5[1m]", effort: "high", fast: false });
    expect(getFavoriteSelection()).toEqual({ agentId: "claude", model: "claude-sonnet-5-5[1m]" });
  });

  it("relaxes through the existing installed and enabled tiers in provider order", () => {
    const agents = registry(0).reverse();
    expect(pickAgentForNewChat(agents)?.id).toBe("claude");
    expect(pickAgentForNewChat(agents.map(agent => ({ ...agent, installed: agent.id === "codex" })))?.id).toBe("codex");
    expect(pickAgentForNewChat(agents.map(agent => ({ ...agent, installed: agent.id === "cursor" })))?.id).toBe("cursor");
    expect(pickAgentForNewChat(agents.map(agent => ({ ...agent, installed: false })))?.id).toBe("claude");
    expect(pickAgentForNewChat(agents, null, id => id !== "claude")?.id).toBe("codex");
    expect(pickAgentForNewChat(agents, null, () => false)?.id).toBe("claude");
    expect(pickDefaultAgentId([])).toBeNull();
    expect(FALLBACK_NEW_CHAT_AGENT_ID).toBe("claude");
  });

  it("prefers confirmed Codex authentication to an unavailable Claude probe", () => {
    const agents = registry(2).map(agent => agent.id === "claude" ? {
      ...agent, authenticated: undefined, authenticationUnavailableReason: "Probe unavailable",
    } : agent);
    expect(pickAgentForNewChat(agents)?.id).toBe("codex");
  });

  it.each(families)("uses the %s catalog born effort only without an exact remembered effort", family => {
    expect(defaultFavoriteModelFor(family)).toBe(models[family]);
    expect(newChatBornDefaults(family)).toMatchObject({ effort: efforts[family], fast: false });
    setModelPreference(family, models[family], { effort: "high" });
    expect(newChatBornDefaults(family)).toMatchObject({ model: models[family], effort: "high", fast: false });
  });

  it("keeps native capability narrowing authoritative over the catalog born effort", () => {
    const live = { protocolVersion: 1, _meta: { models: [{ value: models.claude, label: "Opus", effortLevels: ["low", "high"], supportsFast: false }] } };
    // The catalog's Medium default is unavailable here; use the supported
    // fallback, while preserving a stored supported choice when present.
    expect(resolveModelOption("claude", models.claude, live)?.defaultEffort).toBe("medium");
    expect(resolveModelConfiguration("claude", models.claude, live)).toEqual({ effort: "high", fast: false });
    setModelPreference("claude", models.claude, { effort: "low" });
    expect(resolveModelConfiguration("claude", models.claude, live)).toEqual({ effort: "low", fast: false });
  });

  it("moves an existing user with no saved default onto the new chain without saving an implicit star", () => {
    hydrateModelsFromSettings({ default: null, default_agent: null, model_preferences: [], permission_preferences: [] }, true);
    const agent = pickAgentForNewChat(registry(7))!;
    expect(newChatBornDefaults(agent.id)).toMatchObject({ model: models.claude, effort: "medium", fast: false });
    expect(getFavoriteSelection()).toBeNull();
    expect(hasModelDefaults()).toBe(false);
  });

  it.each([
    ["claude", "claude-opus-5[1m]"], ["codex", "gpt-5.6-sol"], ["cursor", "composer-2.5"],
  ])("preserves an old saved %s default %s from settings", (family, model) => {
    hydrateModelsFromSettings({ default_agent: family, default: model, model_preferences: [] }, true);
    expect(getDefaultAgentId()).toBe(family);
    expect(newChatBornDefaults(family).model).toBe(model);
  });

  it.each([
    ["claude", "opus", "claude-opus-4-8[1m]"],
    ["claude", "opus-5", "claude-opus-5[1m]"],
    ["claude", "opus-5.5", "claude-opus-5-5[1m]"],
    ["claude", "sonnet", "claude-sonnet-5[1m]"],
    ["claude", "sonnet-5.5", "claude-sonnet-5-5[1m]"],
    ["claude", "haiku", "claude-haiku-4-5"],
    ["claude", "haiku-5.5", "claude-haiku-5-5"],
    ["cursor", "auto", "default"],
  ])("keeps the persisted %s alias %s mapped to %s", (family, alias, model) => {
    setFavoriteModel(family, alias);
    expect(newChatBornDefaults(family).model).toBe(alias);
    expect(resolveModelOption(family, alias, null)?.value).toBe(model);
  });

  it("keeps legacy family effort and global Fast on their old model rather than the new born default", () => {
    setSetting("default-effort-by-family", { claude: "max", codex: "low" });
    setSetting("default-fast-mode", true);
    expect(newChatBornDefaults("claude")).toMatchObject({ model: models.claude, effort: "medium", fast: false });
    expect(getModelPreference("claude", "claude-opus-5[1m]")).toEqual({ effort: "max", fast: true });
    expect(getModelPreference("codex", "gpt-5.6-sol")).toEqual({ effort: "low" });
    expect(getModelPreference("claude", models.claude)).toBeNull();
  });

  it("preserves durable legacy effort and Fast without assigning them to new defaults", () => {
    hydrateModelsFromSettings({
      claude_code: { default_effort_level: "max" },
      codex: { default_thinking_level: "low" },
      default_fast_mode: true,
    }, true);
    expect(getFavoriteSelection()).toBeNull();
    expect(getModelPreference("claude", "claude-opus-5[1m]")).toEqual({ effort: "max", fast: true });
    expect(getModelPreference("codex", "gpt-5.6-sol")).toEqual({ effort: "low" });
    expect(newChatBornDefaults("claude")).toMatchObject({ model: models.claude, effort: "medium", fast: false });
  });
});
