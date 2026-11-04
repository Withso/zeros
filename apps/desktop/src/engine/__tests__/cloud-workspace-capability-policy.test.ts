import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV,
  cloudWorkspaceDesktopCapabilityEnabled,
} from "../cloud-workspace-capability";

afterEach(() => vi.unstubAllEnvs());

describe("desktop cloud capability under the checked-in channel policy", () => {
  it.each(["beta", "stable"])("follows the %s release's baked decision", releaseChannel => {
    vi.stubEnv("ZEROS_CHANNEL", releaseChannel);
    expect(cloudWorkspaceDesktopCapabilityEnabled({ bakedCapability: true, environment: {} })).toBe(true);
    expect(cloudWorkspaceDesktopCapabilityEnabled({
      bakedCapability: false,
      environment: { [CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV]: "true" },
    })).toBe(false);
  });
});
