import { describe, expect, it } from "vitest";
import { designStyleTargetNodeId } from "../design-inspector";

const frame = {
  selectedNodeId: null,
  frameSelected: true,
  explicitFrameIdentityNodeId: null,
  legacyExactInstanceNodeId: null,
  layoutRootId: "home-main",
};

describe("a selected frame's style target", () => {
  it("keeps its root while the root's details are a generation behind, so the inspector stays mounted", () => {
    expect(designStyleTargetNodeId({ ...frame, details: { oid: "home-main" } })).toBe("home-main");
  });

  it("has no target without the root's details or with another node's", () => {
    expect(designStyleTargetNodeId({ ...frame, details: null })).toBeNull();
    expect(designStyleTargetNodeId({ ...frame, details: { oid: "home-hero" } })).toBeNull();
  });

  it("prefers a selected layer, then the frame's component identity", () => {
    expect(designStyleTargetNodeId({ ...frame, selectedNodeId: "home-hero", details: null })).toBe("home-hero");
    expect(designStyleTargetNodeId({ ...frame, explicitFrameIdentityNodeId: "instance", details: { oid: "home-main" } })).toBe("instance");
    expect(designStyleTargetNodeId({ ...frame, frameSelected: false, details: { oid: "home-main" } })).toBeNull();
  });
});
