import { describe, expect, it } from "vitest";
import { LEGACY_TOOL_NAME_ALIASES as sdk } from "@anthropic-ai/claude-agent-sdk";
import { LEGACY_TOOL_NAME_ALIASES as local } from "../translator";

describe("Claude SDK aliases kept by the worker", () => {
  it("match the pinned SDK's table, so the worker can start without loading the SDK", () => {
    expect(local).toEqual(sdk);
  });
});
