import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { designLiveDocumentRetirement } from "../design-frame-retirement";

const read = (file: string) => readFileSync(path.resolve("apps/desktop/src/renderer/features/design-workspace", file), "utf8");

describe("retiring a live frame document", () => {
  it("keeps a document that stops being live mounted, undrawn, until its replacement has been presented", () => {
    const live = designLiveDocumentRetirement({ live: false, retiring: false }, true, true);
    expect(live).toEqual({ live: true, retiring: false });
    // The frame goes passive: the document is still mounted, but retiring.
    const passive = designLiveDocumentRetirement(live, false, true);
    expect(passive).toEqual({ live: false, retiring: true });
    // Unrelated renders while it retires change nothing.
    expect(designLiveDocumentRetirement(passive, false, true)).toEqual(passive);
    // Selected again before it left: the same document simply carries on.
    expect(designLiveDocumentRetirement(passive, true, true)).toEqual({ live: true, retiring: false });
  });

  it("removes the document at once on a hidden canvas, where nothing is presented", () => {
    expect(designLiveDocumentRetirement({ live: true, retiring: false }, false, false)).toEqual({ live: false, retiring: false });
  });

  it("stops drawing the retiring document without hiding it from the browser, and no longer counts it as ready", () => {
    const surface = read("design-frame-render-surface.tsx");
    const runtime = read("design-frame-runtime-iframe.tsx");
    expect(surface).toContain("const retiring = useDesignLiveDocumentRetirement(live, active);");
    expect(surface).toContain("if (live || retiring) {");
    expect(surface).toContain("retiring={!live}");
    // Opacity keeps the frame visible to Chromium, which frees a hidden
    // frame's tiles while the canvas still shows them; visibility would not.
    expect(runtime).toContain('style={retiring ? { opacity: 0 } : undefined}');
    expect(runtime).toContain('data-design-document-ready={ready && !retiring ? "" : undefined}');
    expect(runtime).toContain("active={props.active && !props.retiring}");
  });
});
