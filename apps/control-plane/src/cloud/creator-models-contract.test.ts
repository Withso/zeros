import { describe, expect, it } from "vitest";
import { CloudV2ControlFrameSchema } from "./contract.js";

const config = { t: "config", loginRevision: "1", actingUser: 1, agents: {},
  workspace: { id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
    repository: "fixture/repo", checkoutPath: "/home/user/fixture/repo", branch: "topic", baseBranch: "main" } };

describe("Creator model metadata", () => {
  it.each([{}, { claude: [] }, { claude: ["claude-opus-5-5[1m]"], codex: ["gpt-5.5"], cursor: ["default"] }])(
    "accepts sparse bounded model ids without credential fields: %j", agentModels => {
      expect(CloudV2ControlFrameSchema.parse({ ...config, agentModels })).toEqual({ ...config, agentModels });
    });

  it("keeps configuration without model metadata valid", () => {
    expect(CloudV2ControlFrameSchema.parse(config)).toEqual(config);
  });

  it.each([null, [], { unknown: [] }, { claude: "default" }, { claude: [""] }, { claude: ["x\n"] },
    { claude: ["x".repeat(257)] }, { claude: ["same", "same"] }, { claude: Array.from({ length: 129 }, (_, i) => `model-${i}`) },
    { claude: [{ id: "default", token: "synthetic" }] }, { claude: ["default"], apiKey: "synthetic" }])(
    "refuses malformed, duplicated, unbounded or secret-shaped metadata: %j", agentModels => {
      expect(CloudV2ControlFrameSchema.safeParse({ ...config, agentModels }).success).toBe(false);
    });
});
