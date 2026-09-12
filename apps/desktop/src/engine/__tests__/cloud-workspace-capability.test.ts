import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV,
  cloudWorkspaceDesktopCapabilityEnabled,
  createCloudWorkspaceDesktopPipelines,
  seedCloudWorkspaceDesktopCapabilityEnvironment,
} from "../cloud-workspace-capability";

describe("desktop cloud-workspace release capability", () => {
  it("defaults off and accepts only the exact literal true", () => {
    expect(cloudWorkspaceDesktopCapabilityEnabled({ environment: {} })).toBe(
      false,
    );
    expect(
      cloudWorkspaceDesktopCapabilityEnabled({
        environment: { [CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV]: "true" },
      }),
    ).toBe(true);

    for (const value of ["1", "TRUE", " true", "true ", "yes", "false"]) {
      expect(
        cloudWorkspaceDesktopCapabilityEnabled({
          environment: {
            [CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV]: value,
          },
        }),
      ).toBe(false);
    }
  });

  it("lets the baked release decision override an arbitrary runtime environment", () => {
    expect(
      cloudWorkspaceDesktopCapabilityEnabled({
        bakedCapability: false,
        environment: { [CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV]: "true" },
      }),
    ).toBe(false);
    expect(
      cloudWorkspaceDesktopCapabilityEnabled({
        bakedCapability: true,
        environment: { [CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV]: "false" },
      }),
    ).toBe(true);
  });

  it("seeds the child environment from the baked decision", () => {
    const environment = {
      [CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV]: "true",
    };

    expect(
      seedCloudWorkspaceDesktopCapabilityEnvironment({
        bakedCapability: false,
        environment,
      }),
    ).toBe(false);
    expect(environment[CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV]).toBe("false");
  });

  it("does not construct replica or fork pipelines while disabled", () => {
    const createReplica = vi.fn(() => ({ kind: "replica" }));
    const createFork = vi.fn(() => ({ kind: "fork" }));

    expect(
      createCloudWorkspaceDesktopPipelines({
        cloudWorker: false,
        capabilityEnabled: () => false,
        createReplica,
        createFork,
      }),
    ).toEqual({ replica: null, fork: null });
    expect(createReplica).not.toHaveBeenCalled();
    expect(createFork).not.toHaveBeenCalled();
  });

  it("keeps explicit desktop construction available only when enabled", () => {
    const replica = { kind: "replica" };
    const fork = { kind: "fork" };
    const createReplica = vi.fn(() => replica);
    const createFork = vi.fn((received: typeof replica) => {
      expect(received).toBe(replica);
      return fork;
    });

    expect(
      createCloudWorkspaceDesktopPipelines({
        cloudWorker: false,
        capabilityEnabled: () => true,
        createReplica,
        createFork,
      }),
    ).toEqual({ replica, fork });
    expect(createReplica).toHaveBeenCalledOnce();
    expect(createFork).toHaveBeenCalledOnce();
  });
});
