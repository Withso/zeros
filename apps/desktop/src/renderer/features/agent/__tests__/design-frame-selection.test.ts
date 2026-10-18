import { describe, expect, it } from "vitest";
import { hasDesignFrameAttachmentSelection } from "../design-frame-selection";

const target = { workspaceId: "workspace", directoryId: "design", frame: "home.html", intent: "code" };

describe("Design reference payload presence", () => {
  it("accepts legacy and grouped stable references at the existing resource bound", () => {
    expect(hasDesignFrameAttachmentSelection(target)).toBe(true);
    expect(hasDesignFrameAttachmentSelection([target, { ...target, frame: "page-1/home.html", nodeId: "nested" }])).toBe(true);
    expect(hasDesignFrameAttachmentSelection(Array.from({ length: 32 }, (_, index) => ({ ...target, frame: `frame-${index}.html` })))).toBe(true);
    expect(hasDesignFrameAttachmentSelection(Array.from({ length: 33 }, (_, index) => ({ ...target, frame: `frame-${index}.html` })))).toBe(false);
  });

  it.each([
    { value: null }, { value: undefined }, { value: [] }, { value: Array(1) }, { value: {} }, { value: [{}] }, { value: [target, null] },
    { value: { ...target, frame: "../home.html" } }, { value: { ...target, workspaceId: " " } },
    { value: { ...target, nodeId: "" } }, { value: { ...target, nodeId: "bad\nnode" } }, { value: { ...target, intent: "invalid" } },
    { value: { ...target, includeScreenshot: 1 } }, { value: { ...target, selectionEvent: -1 } }, { value: { ...target, ownerRevision: Infinity } },
    { value: { ...target, frameId: "" } }, { value: { ...target, placement: "remote" } },
    { value: [target, { ...target, workspaceId: "foreign" }] }, { value: [target, { ...target, directoryId: "foreign" }] },
    { value: [target, { ...target, organizationId: "foreign" }] }, { value: [target, { ...target, pageId: "foreign" }] },
  ])("does not count removed, empty, malformed or mixed-owner references $value as payload", ({ value }) => {
    expect(hasDesignFrameAttachmentSelection(value)).toBe(false);
  });
});
