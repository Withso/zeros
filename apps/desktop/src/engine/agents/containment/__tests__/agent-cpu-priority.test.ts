import { describe, expect, it } from "vitest";

import {
  AGENT_CPU_PRIORITY_ENV,
  localAgentCpuPriority,
} from "../agent-cpu-priority";

describe("localAgentCpuPriority", () => {
  it("defaults local agent hosts to below-normal priority with an explicit opt-out", () => {
    expect(localAgentCpuPriority({})).toBe("below-normal");
    expect(localAgentCpuPriority({ [AGENT_CPU_PRIORITY_ENV]: "low" })).toBe("below-normal");
    expect(localAgentCpuPriority({ [AGENT_CPU_PRIORITY_ENV]: " Normal " })).toBeUndefined();
  });
});
