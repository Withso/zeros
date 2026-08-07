import { describe, expect, it } from "vitest";

import {
  assertSafeDesignHtmlDocument,
  assertSafeDesignHtmlFragment,
  healDesignHtmlIdentities,
  mutateDesignNodeAttributeSource,
  mutateDesignNodeHtmlSource,
  mutateDesignNodeTextSource,
  parseDesignWebProjection,
} from "../html";
import { FRAME_HTML, webState } from "./fixtures";

describe("HTML source adapter", () => {
  it("projects stable hierarchy and exact authored spans", () => {
    const state = webState();
    const projection = parseDesignWebProjection({
      documentId: state.documentId,
      revision: state.revision,
      entryFile: state.entryFile,
      source: FRAME_HTML,
    });
    expect(projection.rootIds).toEqual(["root"]);
    expect(projection.nodes.map((node) => [node.id, node.parentId])).toEqual([
      ["root", null],
      ["card", "root"],
      ["label", "card"],
    ]);
    const label = projection.nodes.find((node) => node.id === "label")!;
    expect(
      FRAME_HTML.slice(label.startTag.startOffset, label.startTag.endOffset),
    ).toBe('<span data-oid="label">');
    expect(label.directText).toBe("Hello");
    expect(projection.diagnostics).toEqual([]);
  });

  it("heals missing and duplicate identities once with minimal source edits", () => {
    const source =
      '<html><body><main data-oid="same"><div></div><p data-oid="same">Text</p></main></body></html>';
    const first = healDesignHtmlIdentities(source);
    const second = healDesignHtmlIdentities(first.source);
    expect(first.healed).toBe(2);
    expect(first.source.replace(/ data-oid="[^"]+"/g, "")).toBe(
      source.replace(/ data-oid="[^"]+"/g, ""),
    );
    expect(second).toEqual({ source: first.source, changed: false, healed: 0 });
  });

  it("keeps identity when formatting and hierarchy change externally", () => {
    const moved = `<!doctype html><html><body>
      <main data-oid="root">
        <span data-oid="label">Hello</span>
        <article class="card" data-oid="card"></article>
      </main>
    </body></html>`;
    const projection = parseDesignWebProjection({
      documentId: "document-1",
      revision: "external-revision",
      entryFile: "index.html",
      source: moved,
    });

    expect(projection.nodes.map((node) => node.id)).toEqual([
      "root",
      "label",
      "card",
    ]);
    expect(projection.nodes.find((node) => node.id === "label")).toMatchObject({
      parentId: "root",
      directText: "Hello",
    });
  });

  it("mutates only the requested text or attribute bytes", () => {
    const text = mutateDesignNodeTextSource(FRAME_HTML, "label", "A & B");
    expect(text).toBe(FRAME_HTML.replace("Hello", "A &amp; B"));
    const attributed = mutateDesignNodeAttributeSource(
      text,
      "card",
      "aria-label",
      "Card & details",
    );
    expect(attributed).toContain(
      'class="card" aria-label="Card &amp; details"',
    );
    expect(
      mutateDesignNodeAttributeSource(attributed, "card", "aria-label", null),
    ).toBe(text);
  });

  it("rejects active HTML and heals inserted visual nodes", () => {
    expect(() =>
      mutateDesignNodeHtmlSource(FRAME_HTML, "card", "<script>bad()</script>"),
    ).toThrow("Active design element");
    const inserted = mutateDesignNodeHtmlSource(
      FRAME_HTML,
      "card",
      "<strong>New</strong>",
      "append",
    );
    const healed = healDesignHtmlIdentities(inserted);
    expect(healed.source).toMatch(
      /<strong data-oid="o-[a-f0-9]{8}">New<\/strong>/,
    );
  });

  it("allows only local contained URL references in HTML and CSS", () => {
    expect(() =>
      assertSafeDesignHtmlFragment(
        '<img src="assets/photo.png"><a href="#details" style="background:url(./assets/bg.png)">Details</a>',
      ),
    ).not.toThrow();
    for (const fragment of [
      '<img src="https://example.com/tracker.png">',
      '<img src="../outside.png">',
      '<img srcset="assets/local.png 1x, //example.com/remote.png 2x">',
      '<div style="background:url(../outside.png)"></div>',
      '<style>@import "https://example.com/theme.css";</style>',
      '<iframe srcdoc="<p>active</p>"></iframe>',
    ]) {
      expect(() => assertSafeDesignHtmlFragment(fragment)).toThrow();
    }
  });

  it("validates component files as complete documents", () => {
    expect(() =>
      assertSafeDesignHtmlDocument(
        '<!doctype html><html><head><style>zd-card{display:block}</style></head><body><article data-zid="root">Card</article></body></html>',
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeDesignHtmlDocument(
        "<!doctype html><html><body><script>alert(1)</script></body></html>",
      ),
    ).toThrow("Active design element");
  });
});
