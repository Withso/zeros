import { describe, expect, it } from "vitest";
import type {
  CloudWorkspaceBackendConfig,
  CloudWorkspaceProvisioningProfile,
} from "../config.js";
import {
  cloudWorkspaceProvisioningProfile,
  configuredCloudWorkspaceProviders,
} from "./provisioning-profile.js";

const daytona: CloudWorkspaceProvisioningProfile = {
  provider: "daytona",
  imageRef: "qualified-snapshot",
  architecture: "linux/amd64",
  cpuMillicores: 2000,
  memoryMiB: 4096,
  storageMiB: 20480,
  sourceCommit: "a".repeat(40),
};
const boat: CloudWorkspaceProvisioningProfile = {
  ...daytona,
  provider: "boat",
  imageRef: "qualified-template",
  cpuMillicores: 4000,
  memoryMiB: 8192,
};
const config = (profiles?: CloudWorkspaceBackendConfig["providerProfiles"]) =>
  ({
    ...boat,
    apiKey: "must-never-be-in-a-generation-profile",
    providerProfiles: profiles,
  }) as CloudWorkspaceBackendConfig;

describe("cloud provisioning profiles", () => {
  it("preserves a qualified Daytona VM class without changing legacy profiles",()=>{
    const vm={...daytona,sandboxClass:"linux-vm" as const};
    expect(cloudWorkspaceProvisioningProfile(config({daytona:vm}),"daytona")).toEqual(vm);
  });
  it("selects the customer's provider independently of the managed default without copying credentials", () => {
    const configured = config({ daytona });
    expect(configuredCloudWorkspaceProviders(configured)).toEqual([
      "daytona",
      "boat",
    ]);
    expect(cloudWorkspaceProvisioningProfile(configured, "daytona")).toEqual(
      daytona,
    );
    expect(cloudWorkspaceProvisioningProfile(configured, "boat")).toEqual(boat);
  });

  it.each(["daytona", "unknown", "__proto__", null])(
    "does not fall back for an unconfigured provider (%s)",
    (name) => {
      expect(() => cloudWorkspaceProvisioningProfile(config(), name)).toThrow(
        "no valid provisioning profile",
      );
    },
  );

  it.each([
    { provider: "boat" },
    { architecture: "windows/amd64" },
    { cpuMillicores: 0 },
    { memoryMiB: 0.5 },
    { storageMiB: 2147483648 },
    { sourceCommit: "unqualified" },
    { imageRef: "bad\nimage" },
    { imageRef: "" },
  ])("rejects an invalid qualified target %j", (invalid) => {
    const configured = config({
      daytona: { ...daytona, ...invalid } as CloudWorkspaceProvisioningProfile,
    });
    expect(() =>
      cloudWorkspaceProvisioningProfile(configured, "daytona"),
    ).toThrow("no valid provisioning profile");
  });
});
