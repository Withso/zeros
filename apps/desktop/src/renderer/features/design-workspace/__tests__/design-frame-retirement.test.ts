import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { designLiveDocumentRetirement } from "../design-frame-retirement";

const read = (file: string) => readFileSync(path.resolve("apps/desktop/src/renderer/features/design-workspace", file), "utf8");

describe("retiring a live frame document", () => {
  const start = { live: true, document: 0, retiring: null };

  it("keeps a document that stops being live mounted, undrawn, until its replacement has been presented", () => {
    const passive = designLiveDocumentRetirement(start, false, true);
    expect(passive).toEqual({ live: false, document: 0, retiring: 0 });
    // Unrelated renders while it retires change nothing.
    expect(designLiveDocumentRetirement(passive, false, true)).toBe(passive);
  });

  it("never brings a retiring document back: a frame that is live again starts a new one", () => {
    // A document that left can hold previews of the gesture that ended with it.
    const passive = designLiveDocumentRetirement(start, false, true);
    const again = designLiveDocumentRetirement(passive, true, true);
    expect(again).toEqual({ live: true, document: 1, retiring: 0 });
    // The new document retires under its own identity later.
    expect(designLiveDocumentRetirement({ ...again, retiring: null }, false, true)).toEqual({ live: false, document: 1, retiring: 1 });
  });

  it("removes the document at once on a hidden canvas, where nothing is presented", () => {
    expect(designLiveDocumentRetirement(start, false, false)).toEqual({ live: false, document: 0, retiring: null });
    const passive = designLiveDocumentRetirement(start, false, true);
    expect(designLiveDocumentRetirement(passive, false, false)).toEqual({ live: false, document: 0, retiring: null });
  });

  it("stops drawing the retiring document without hiding it from the browser, and no longer counts it as ready", () => {
    const surface = read("design-frame-render-surface.tsx");
    const runtime = read("design-frame-runtime-iframe.tsx");
    expect(surface).toContain("const retirement = useDesignLiveDocumentRetirement(live, active);");
    expect(surface).toContain("retirement.retiring !== null ? runtimeDocument(retirement.retiring, true) : null,");
    expect(surface).toContain("live ? runtimeDocument(retirement.document, false) : null,");
    // Opacity keeps the frame visible to Chromium, which frees a hidden
    // frame's tiles while the canvas still shows them; visibility would not.
    expect(runtime).toContain('style={retiring ? { opacity: 0 } : undefined}');
    // It lies over the frame, out of the way of the document that follows it.
    expect(runtime).toContain('retiring ? "absolute inset-0 size-full overflow-hidden" : "relative size-full overflow-hidden"');
    expect(runtime).toContain('data-design-document-ready={ready && !retiring ? "" : undefined}');
    expect(runtime).toContain("active={props.active && !props.retiring}");
  });
});
