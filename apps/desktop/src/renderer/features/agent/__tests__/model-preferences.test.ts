import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_MODEL_PREFERENCES,
  defaultEffortForLevels,
  getModelPreference,
  replaceModelPreferences,
  resolveModelConfiguration,
  serializeModelPreferences,
  setModelPreference,
} from "../model-preferences";
import { setFavoriteModel } from "../model-favorites";

function installLocalStorage(): void {
  const store = new Map<string, string>();
  const fake = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  (globalThis as { localStorage?: Storage }).localStorage =
    fake as unknown as Storage;
}

describe("per-model effort and fast preferences", () => {
  beforeEach(() => installLocalStorage());
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("defaults every model to High (or its equivalent) with Fast off", () => {
    expect(defaultEffortForLevels(["max", "low"])).toBe("max");
    expect(defaultEffortForLevels([])).toBe("high");
    expect(
      resolveModelConfiguration("claude", "claude-opus-5[1m]", null),
    ).toEqual({
      effort: "high",
      fast: false,
    });
    expect(resolveModelConfiguration("codex", "gpt-5.6-sol", null)).toEqual({
      effort: "high",
      fast: false,
    });
    expect(resolveModelConfiguration("cursor", "composer-2.5", null)).toEqual({
      effort: "high",
      fast: false,
    });
  });

  it("isolates settings by exact agent family and model across A -> B -> A", () => {
    setModelPreference("codex", "gpt-5.6-sol", {
      effort: "max",
      fast: true,
    });
    setModelPreference("codex", "gpt-5.6-terra", {
      effort: "medium",
      fast: false,
    });
    setModelPreference("claude", "claude-opus-5[1m]", {
      effort: "ultracode",
      fast: true,
    });
    setModelPreference("cursor", "grok-4.5", {
      effort: "low",
      fast: true,
    });

    expect(resolveModelConfiguration("codex", "gpt-5.6-sol", null)).toEqual({
      effort: "max",
      fast: true,
    });
    expect(resolveModelConfiguration("codex", "gpt-5.6-terra", null)).toEqual({
      effort: "medium",
      fast: false,
    });
    expect(
      resolveModelConfiguration("claude", "claude-opus-5[1m]", null),
    ).toEqual({
      effort: "ultracode",
      fast: true,
    });
    expect(resolveModelConfiguration("cursor", "grok-4.5", null)).toEqual({
      effort: "low",
      fast: true,
    });
  });

  it("resolves a legacy null model to the effective default, not catalog row zero", () => {
    setFavoriteModel("claude", "claude-opus-5[1m]");
    setModelPreference("claude", null, { effort: "max", fast: true });

    expect(getModelPreference("claude", "claude-opus-5[1m]")).toEqual({
      effort: "max",
      fast: true,
    });
    expect(getModelPreference("claude", "claude-fable-5[1m]")).toBeNull();
    expect(resolveModelConfiguration("claude", null, null)).toEqual({
      effort: "max",
      fast: true,
    });
  });

  it("clamps corrupt or retired capabilities without leaking them to another model", () => {
    replaceModelPreferences([
      {
        agent: "claude",
        model: "claude-haiku-4-5",
        effort: "ultracode",
        fast: true,
      },
      {
        agent: "codex",
        model: "gpt-5.6-luna",
        effort: "not-real",
        fast: "yes",
      },
      { agent: "codex", model: "no-op-record" },
      { agent: "codex", model: "gpt-5.6-sol", effort: "max", fast: true },
    ]);

    expect(
      resolveModelConfiguration("claude", "claude-haiku-4-5", null),
    ).toEqual({
      effort: "high",
      fast: false,
    });
    expect(resolveModelConfiguration("codex", "gpt-5.6-luna", null)).toEqual({
      effort: "high",
      fast: false,
    });
    expect(resolveModelConfiguration("codex", "gpt-5.6-sol", null)).toEqual({
      effort: "max",
      fast: true,
    });
    expect(getModelPreference("codex", "no-op-record")).toBeNull();
  });

  it("round-trips a bounded, deduplicated settings payload", () => {
    const records = Array.from(
      { length: MAX_MODEL_PREFERENCES + 12 },
      (_, index) => ({
        agent: "codex",
        model: `future-model-${index}`,
        effort: index % 2 === 0 ? "high" : "medium",
        fast: index % 3 === 0,
      }),
    );
    records.push({
      agent: "codex",
      model: `future-model-${MAX_MODEL_PREFERENCES + 11}`,
      effort: "max",
      fast: true,
    });
    replaceModelPreferences(records);

    const serialized = serializeModelPreferences();
    expect(serialized).toHaveLength(MAX_MODEL_PREFERENCES);
    expect(
      getModelPreference("codex", `future-model-${MAX_MODEL_PREFERENCES + 11}`),
    ).toEqual({
      effort: "max",
      fast: true,
    });
  });
});
