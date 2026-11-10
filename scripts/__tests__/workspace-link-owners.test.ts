import { describe, expect, it } from "vitest";
import {
  RESERVED_WORKSPACE_LINK_OWNERS,
  isCloudWorkspacePageOwner,
  parseCloudWorkspacePagePath,
} from "@zeros/protocol/cloud-workspace-link";
import { RESERVED_ORGANIZATION_SLUGS } from "../../apps/control-plane/src/organization-slugs";

// The control plane deploys without @zeros/protocol, so it keeps its own copy
// of the owner segments no organization's workspace page may use.
describe("workspace link owners", () => {
  it("reserves the same slugs on the control plane and in desktop links", () => {
    expect([...RESERVED_ORGANIZATION_SLUGS].sort()).toEqual([...RESERVED_WORKSPACE_LINK_OWNERS].sort());
  });

  it("never treats a reserved slug as an organization's page", () => {
    for (const owner of RESERVED_WORKSPACE_LINK_OWNERS) {
      expect(isCloudWorkspacePageOwner(owner)).toBe(false);
      expect(parseCloudWorkspacePagePath(`/${owner}/w/3`)).toBeNull();
    }
    expect(isCloudWorkspacePageOwner("acme")).toBe(true);
  });
});
