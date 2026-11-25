import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { designLiveDocumentRetirement, designSourceStaysPainted } from "../design-frame-retirement";

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

  it("drops the pixels beneath a revealed document only after the canvas itself has presented the reveal", () => {
    // A child's own report can precede the canvas frame that shows it: the
    // child runs ahead while the canvas main thread is busy.
    const runtime = read("design-frame-runtime-iframe.tsx");
    const source = read("design-frame-source-surface.tsx");
    expect(runtime).toContain('const revealed = useDesignRevealPresented(ready && buffer === "displayed" && !retiring);');
    expect(runtime).toContain("data-design-document-presented={ready && !retiring && revealed && presentedRuntime !== null && presentedRuntime === connectedRuntime ? \"\" : undefined}");
    // The cached vector stays under the source document the same way.
    expect(source).toContain("const revealed = useDesignRevealPresented(ready && !incoming && visible);");
    expect(source).toContain("if (revealed && childPainted) callbacks.current.onPainted();");
  });
});

describe("a source that leaves its surface budget", () => {
  const base = { confirmed: true, enabled: false, failed: false, pictureOwner: true, pictureCurrent: false };

  it("stays painted until the frame's exact-generation picture has decoded", () => {
    expect(designSourceStaysPainted(base)).toBe(true);
    expect(designSourceStaysPainted({ ...base, pictureCurrent: true })).toBe(false);
    expect(designSourceStaysPainted({ ...base, enabled: true, pictureCurrent: true })).toBe(true);
    expect(designSourceStaysPainted({ ...base, confirmed: false })).toBe(false);
  });

  it("keeps a rejected generation's last pixels even without a picture owner, and nothing else", () => {
    expect(designSourceStaysPainted({ ...base, pictureOwner: false })).toBe(false);
    expect(designSourceStaysPainted({ ...base, pictureOwner: false, failed: true })).toBe(true);
  });

  it("is what the render surface paints", () => {
    const surface = read("design-frame-render-surface.tsx");
    expect(surface).toContain("const sourcePainted = designSourceStaysPainted({ confirmed: hasSourcePixels, enabled: sourceEnabled,");
  });
});
