import { describe, expect, it } from "vitest";
import type {
  CloudWorkspaceBackendConfig,
  CloudWorkspaceProvisioningProfile,
} from "../config.js";
import {
  cloudWorkspaceProvisioningProfile,
  configuredCloudWorkspaceProviders,
} from "./provisioning-profile.js";

const boat: CloudWorkspaceProvisioningProfile = {
  provider: "boat", imageRef: "qualified-template", architecture: "linux/amd64",
  cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480, sourceCommit: "a".repeat(40),
};
const config = (profiles?: CloudWorkspaceBackendConfig["providerProfiles"]) =>
  ({
    ...boat,
    apiKey: "must-never-be-in-a-generation-profile",
    providerProfiles: profiles,
  }) as CloudWorkspaceBackendConfig;

describe("cloud provisioning profiles", () => {
  it("returns only the qualified Boat profile without copying credentials", () => {
    expect(configuredCloudWorkspaceProviders(config())).toEqual(["boat"]);
    expect(cloudWorkspaceProvisioningProfile(config(), "boat")).toEqual(boat);
  });

  it.each(["retired-provider", "unknown", "__proto__", null])(
    "does not fall back for an unconfigured provider (%s)",
    (name) => {
      expect(() => cloudWorkspaceProvisioningProfile(config(), name)).toThrow(
        "no valid provisioning profile",
      );
    },
  );

  it.each([
    { provider: "unknown" },
    { architecture: "windows/amd64" },
    { cpuMillicores: 0 },
    { memoryMiB: 0.5 },
    { storageMiB: 2147483648 },
    { sourceCommit: "unqualified" },
    { imageRef: "bad\nimage" },
    { imageRef: "" },
  ])("rejects an invalid qualified target %j", (invalid) => {
    const configured = config({
      boat: { ...boat, ...invalid } as CloudWorkspaceProvisioningProfile,
    });
    expect(() =>
      cloudWorkspaceProvisioningProfile(configured, "boat"),
    ).toThrow("no valid provisioning profile");
  });
});
