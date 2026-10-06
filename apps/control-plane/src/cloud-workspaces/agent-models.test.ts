import { CLOUD_AGENT_ADMISSION_CODES as protocolCodes } from "../../../../packages/protocol/src/cloud-agent-execution.js";
import { CLOUD_AGENT_ADMISSION_CODES } from "./agent-admission-errors.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cloudAgentModels, cloudAgentModelAllowed } from "./agent-models.js";

describe("standalone control-plane provider catalog", () => {
  it("keeps closed admission codes compatible with the desktop", () => {
    expect(CLOUD_AGENT_ADMISSION_CODES).toEqual(protocolCodes);
  });
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
});
