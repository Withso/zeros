import { describe, expect, it } from "vitest";
import { loadCloudRuntimeConfig } from "./runtime-config.js";
import { cloudRuntimeStagingEnabled } from "./runtime-staging.js";

describe("runtime staging rollout boundary", () => {
  it("defaults off and requires the explicit flag, Alpha, hosted Boat, and artifacts", () => {
    expect(loadCloudRuntimeConfig({}).stagingEnabled).toBe(false);
    expect(loadCloudRuntimeConfig({ CLOUD_RUNTIME_STAGING_ENABLED: "true" }).stagingEnabled).toBe(true);
    const supported = { deploymentChannel: "alpha", enabled: true, provider: "boat", hosted: true, artifacts: true };
    expect(cloudRuntimeStagingEnabled(supported)).toBe(true);
    for (const unsupported of [{ deploymentChannel: "beta" }, { deploymentChannel: "production" }, { enabled: false },
      { provider: "unsupported" }, { hosted: false }, { artifacts: false }])
      expect(cloudRuntimeStagingEnabled({ ...supported, ...unsupported })).toBe(false);
  });
});
