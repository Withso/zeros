import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV,
  cloudWorkspaceDesktopCapabilityEnabled,
  createCloudWorkspaceDesktopPipelines,
  seedCloudWorkspaceDesktopCapabilityEnvironment,
} from "../cloud-workspace-capability";

// The checked-in policy allows every channel; these cases exercise its pause.
vi.mock("../../../../control-plane/src/cloud/channels.json", () => ({
  default: { development: true, alpha: true, beta: false, production: false },
}));

beforeEach(() => vi.stubEnv("ZEROS_CHANNEL", "alpha"));
afterEach(() => vi.unstubAllEnvs());

describe("desktop cloud-workspace release capability", () => {
  it("never consults the desktop channel policy inside a VM engine with no channel", () => {
    vi.stubEnv("ZEROS_CHANNEL", undefined);
    vi.stubEnv("ZEROS_DEV", undefined);
    vi.stubEnv("ZEROS_RUNTIME_MODE", undefined);
    const capabilityEnabled = vi.fn(() => { throw new Error("VM engines have no desktop release channel"); });
    const createReplica = vi.fn(), createFork = vi.fn();
    // zeros-engine supplies cloudWorker from its validated execution boundary,
    // independently of channel(). These desktop pipelines were always absent
    // in a VM; its native cloud transport and agents do not consume this gate.
    expect(createCloudWorkspaceDesktopPipelines({ cloudWorker: true, capabilityEnabled, createReplica, createFork }))
      .toEqual({ replica: null, fork: null });
    expect(capabilityEnabled).not.toHaveBeenCalled();
    expect(createReplica).not.toHaveBeenCalled();
    expect(createFork).not.toHaveBeenCalled();
  });

  it.each(["beta", "stable"])("keeps %s cloud off while its channel is paused, even with baked and inherited opt-ins", releaseChannel => {
    vi.stubEnv("ZEROS_CHANNEL", releaseChannel);
    const environment = { [CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV]: "true" };
    expect(cloudWorkspaceDesktopCapabilityEnabled({ bakedCapability: true, environment })).toBe(false);
    expect(seedCloudWorkspaceDesktopCapabilityEnvironment({ bakedCapability: true, environment })).toBe(false);
    expect(environment[CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV]).toBe("false");
    const createReplica = vi.fn(), createFork = vi.fn();
    expect(createCloudWorkspaceDesktopPipelines({ cloudWorker: false, createReplica, createFork,
      capabilityEnabled: () => cloudWorkspaceDesktopCapabilityEnabled({ bakedCapability: true }) })).toEqual({ replica: null, fork: null });
    expect(createReplica).not.toHaveBeenCalled();
    expect(createFork).not.toHaveBeenCalled();
  });

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
