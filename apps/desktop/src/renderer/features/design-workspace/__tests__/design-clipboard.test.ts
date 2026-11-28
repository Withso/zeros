import { describe, expect, it } from "vitest";
import { designClipboardFollowedFrame, designClipboardPasteAllowed } from "../design-clipboard";

describe("design canvas clipboard", () => {
  it("pastes on any page of the directory it was copied in, and nowhere else", () => {
    const copied = { workspaceId: "local", directoryId: "design", directoryRevision: 2 };
    expect(designClipboardPasteAllowed(copied, { ...copied })).toBe(true);
    expect(designClipboardPasteAllowed(copied, { ...copied, workspaceId: "other" })).toBe(false);
    expect(designClipboardPasteAllowed(copied, { ...copied, directoryId: "other" })).toBe(false);
    expect(designClipboardPasteAllowed(copied, { ...copied, directoryRevision: 3 })).toBe(false);
  });

  it("follows its own frame after a paste there, so a second paste is not refused as stale", () => {
    const frames = [{ file: "home.html", sourceVersion: "v2" }, { file: "card.html", sourceVersion: "v1" }];
    const copied = { frame: "home.html", nodeId: "label" };
    expect(designClipboardFollowedFrame(copied, "home.html", true, frames)).toEqual(frames[0]);
    expect(designClipboardFollowedFrame(copied, "card.html", true, frames)).toBeNull();
    expect(designClipboardFollowedFrame(copied, "home.html", false, frames)).toBeNull();
    expect(designClipboardFollowedFrame({ frame: "home.html", nodeId: null }, "home.html", true, frames)).toBeNull();
  });
});
