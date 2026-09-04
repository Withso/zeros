import { afterEach, describe, expect, it, vi } from "vitest";

import { CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV } from "../../src/engine/cloud-workspace-capability";
import { getCloudWorkspaceAccessBroker } from "../cloud-workspace-access-runtime";

describe("cloud workspace access runtime release gate", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("rejects before constructing the native access pipeline while disabled", () => {
    vi.stubEnv(CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV, "false");

    expect(() => getCloudWorkspaceAccessBroker()).toThrow(/not enabled/i);
  });
});
