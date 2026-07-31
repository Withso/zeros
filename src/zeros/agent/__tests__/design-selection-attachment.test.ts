import { describe, expect, it } from "vitest";

import type { DesignSelectionContext } from "../../store/use-design-selection-context";
import {
  buildDesignSelectionAttachment,
  designSelectionMention,
  formatDesignSelectionContext,
} from "../design-selection-attachment";

const SELECTION: DesignSelectionContext = {
  workspaceId: "workspace-a",
  folder: "/design/a",
  frame: "home.html",
  sourceVersion: "aaaaaaaaaaaaaaaaaaaaaaaa",
  nodeId: "hero-heading",
  tag: "h1",
  name: "Hero heading",
  selector: '[data-oid="hero-heading"]',
  breadcrumb: ["main · Hero", "h1 · Hero heading"],
  rect: { x: 32, y: 48, width: 640, height: 72 },
  styles: { fontSize: "48px", lineHeight: "56px", display: "block" },
  screenshotDataUrl: `data:image/png;base64,${Buffer.from("pixels").toString("base64")}`,
  capturedAt: 123,
};

describe("design selection chat attachment", () => {
  it("freezes stable frame, oid, breadcrumb, geometry, and style context", () => {
    expect(formatDesignSelectionContext(SELECTION)).toContain(
      "data-oid: hero-heading",
    );
    expect(formatDesignSelectionContext(SELECTION)).toContain(
      "breadcrumb: main · Hero / h1 · Hero heading",
    );
    expect(formatDesignSelectionContext(SELECTION)).toContain("fontSize: 48px");
    expect(designSelectionMention(SELECTION)).toMatchObject({
      frame: "home.html",
      oid: "hero-heading",
      tag: "h1",
    });
  });

  it("sends text plus real screenshot content and visible chips", () => {
    const attachment = buildDesignSelectionAttachment(SELECTION);
    expect(attachment.blocks).toEqual([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    ]);
    expect(attachment.bubbleAttachments).toEqual([
      expect.objectContaining({ name: "Selection · Hero heading" }),
      expect.objectContaining({
        name: "home.html · Hero heading.png",
        thumbnailUri: SELECTION.screenshotDataUrl,
      }),
    ]);
  });

  it("keeps semantic selection context for an agent without image prompts", () => {
    const attachment = buildDesignSelectionAttachment(SELECTION, {
      includeImage: false,
    });

    expect(attachment.blocks).toEqual([
      expect.objectContaining({ type: "text" }),
    ]);
    expect(attachment.bubbleAttachments).toEqual([
      expect.objectContaining({ name: "Selection · Hero heading" }),
    ]);
  });
});
