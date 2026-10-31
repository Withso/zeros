import { describe, expect, it } from "vitest";

import { CLOUD_WORKSPACE_CHANNELS, cloudWorkspaceChannelEnabled } from "../../../../shared/cloud-workspace-channel";

describe("checked-in cloud channel policy", () => {
  it("allows cloud workspaces on every release channel", () => {
    expect(CLOUD_WORKSPACE_CHANNELS).toEqual(["dev", "alpha", "beta", "stable"]);
    for (const channel of CLOUD_WORKSPACE_CHANNELS) expect(cloudWorkspaceChannelEnabled(channel)).toBe(true);
    expect(cloudWorkspaceChannelEnabled("unknown")).toBe(false);
  });
});
