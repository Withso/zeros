import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cloudAgentModels, cloudAgentModelAllowed } from "./agent-models.js";

describe("standalone control-plane provider catalog", () => {
  it("matches the curated model identities shipped to the desktop", () => {
    const catalog = JSON.parse(readFileSync(new URL("../../../../catalogs/models-v1.json", import.meta.url), "utf8"));
    for (const [provider, models] of Object.entries(catalog.families))
      expect(cloudAgentModels(provider)).toEqual((models as { value: string }[]).map(model => model.value));
  });
  it("bounds all-model consent to its provider and preserves explicit legacy lists", () => {
    expect(cloudAgentModelAllowed("cursor-api-key", "grok-4.7", ["grok-4.6"], true)).toBe(true);
    expect(cloudAgentModelAllowed("cursor-api-key", "gpt-6.1-sol", ["grok-4.6"], true)).toBe(false);
    expect(cloudAgentModelAllowed("cursor-api-key", "unqualified", ["unqualified"], true)).toBe(false);
    expect(cloudAgentModelAllowed("cursor-api-key", "legacy-model", ["legacy-model"], false)).toBe(true);
    expect(cloudAgentModels("unknown")).toEqual([]);
  });
  it("admits Haiku 5.5 under existing all-model consent without expanding explicit grants", () => {
    for (const kind of ["claude-api-key", "claude-setup-token"]) {
      expect(cloudAgentModelAllowed(kind, "claude-haiku-5-5", ["claude-haiku-4-5"], true)).toBe(true);
      expect(cloudAgentModelAllowed(kind, "claude-haiku-5-5", ["claude-haiku-4-5"], false)).toBe(false);
      expect(cloudAgentModelAllowed(kind, "claude-haiku-4-5", ["claude-haiku-4-5"], false)).toBe(true);
    }
  });
});
