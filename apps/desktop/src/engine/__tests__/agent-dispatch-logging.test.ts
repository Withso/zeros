import { describe, expect, it } from "vitest";

import { shouldLogAgentDispatch } from "../agent-dispatch-logging";

describe("agent dispatch logging", () => {
  it("keeps lifecycle and user actions visible", () => {
    expect(shouldLogAgentDispatch("AGENT_INIT_AGENT")).toBe(true);
    expect(shouldLogAgentDispatch("AGENT_LOAD_SESSION")).toBe(true);
    expect(shouldLogAgentDispatch("AGENT_PROMPT")).toBe(true);
    expect(shouldLogAgentDispatch("AGENT_MEMORY_SETTINGS_UPDATE")).toBe(true);
  });

  it("does not emit one info line for every routine read", () => {
    expect(shouldLogAgentDispatch("AGENT_LIST_AGENTS")).toBe(false);
    expect(shouldLogAgentDispatch("AGENT_LIST_SESSIONS")).toBe(false);
    expect(shouldLogAgentDispatch("AGENT_MEMORY_SETTINGS_READ")).toBe(false);
    expect(shouldLogAgentDispatch("AGENT_CONFIGURATION_PROVENANCE_READ")).toBe(
      false,
    );
    expect(shouldLogAgentDispatch("AGENT_PROVIDER_QUOTA_READ")).toBe(false);
  });
});
