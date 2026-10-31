import { parse } from "parse5";
import { describe, expect, it } from "vitest";
import { parseDesignWebProjection } from "@zeros/design-web";

import {
  designNodeRecords,
  designRenderedChildElements,
  healDesignOids,
  isShadowDesignNodeElement,
  stripNonDesignOidsForRender,
} from "../node-identities";

// Markup serialized from a web component keeps its rendered content in a
// declarative shadow root. The browser renders that content as the host's
// children, so it must be identifiable like any other layer.
const SOURCE = `<!doctype html><html><head><title>Diff</title></head><body>
<main data-oid="sheet"><diffs-container data-oid="host"><template shadowrootmode="open" data-oid="root-template"><style>pre { margin: 0; }</style><pre data-diff=""><code><div data-line="1"><span>const value = 1;</span></div></code></pre></template></diffs-container>
<template><p>inert</p></template></main>
</body></html>`;

describe("declarative shadow content identities", () => {
  it("derives stable ids for rendered shadow content and leaves inert templates alone", () => {
    const healed = healDesignOids(SOURCE).html;
    const document = parse(healed, { sourceCodeLocationInfo: true });
    const records = designNodeRecords(document);
    const tags = records.map(({ element }) => element.tagName);
    expect(tags).toEqual(["main", "diffs-container", "pre", "code", "div", "span"]);
    for (const record of records) expect(record.oid).toMatch(/^(sheet|host|o-[a-f0-9]{9})$/);
    expect(records.filter(({ element }) => isShadowDesignNodeElement(element)).map(({ element }) => element.tagName))
      .toEqual(["pre", "code", "div", "span"]);
    // The inert template's paragraph is not a layer and gains no id.
    expect(healed).toContain("<template><p>inert</p></template>");
    expect(healDesignOids(healed)).toMatchObject({ changed: false });
  });

  it("keeps shadow ids in the render and strips only document plumbing", () => {
    const rendered = stripNonDesignOidsForRender(healDesignOids(SOURCE).html);
    expect(rendered).not.toContain('data-oid="root-template"');
    expect(rendered).toMatch(/<pre data-diff="" data-oid="o-[a-f0-9]{9}">/);
    expect(rendered).toMatch(/<span data-oid="o-[a-f0-9]{9}">const value = 1;<\/span>/);
  });

  it("matches the design-web projection's ids and parents for the same source", () => {
    const engineIds = designNodeRecords(parse(healDesignOids(SOURCE).html)).map(({ oid }) => oid);
    const projection = parseDesignWebProjection({
      documentId: "doc",
      revision: "r1",
      entryFile: "page/diff.html",
      source: SOURCE,
    });
    expect(projection.nodes.map((node) => node.id)).toEqual(engineIds);
    const pre = projection.nodes.find((node) => node.tag === "pre");
    expect(pre?.parentId).toBe("host");
  });

  it("renders slotted light children under their slot and fallback only when nothing is assigned", () => {
    const source = `<!doctype html><html><body><main data-oid="sheet">
<my-card data-oid="host"><template shadowrootmode="open"><div data-oid="frame"><slot name="header" data-oid="header-slot"></slot><slot data-oid="slot"><i data-oid="unused">fallback</i></slot></div></template><h2 slot="header" data-oid="title">Light</h2><p data-oid="body">Body</p></my-card>
<x-bare data-oid="bare"><template shadowrootmode="open"><slot data-oid="bare-slot"><span data-oid="fallback">Fallback</span></slot></template></x-bare>
<x-spaced data-oid="spaced">
  <template shadowrootmode="open"><slot data-oid="spaced-slot"><span data-oid="hidden">Fallback</span></slot></template>
</x-spaced>
</main></body></html>`;
    const records = designNodeRecords(parse(source, { sourceCodeLocationInfo: true }));
    const children = (oid: string) =>
      designRenderedChildElements(records.find((record) => record.oid === oid)!.element).map((child) =>
        child.attrs.find((attribute) => attribute.name === "data-oid")?.value,
      );
    expect(children("host")).toEqual(["frame"]);
    expect(children("header-slot")).toEqual(["title"]);
    expect(children("slot")).toEqual(["body"]);
    expect(children("bare-slot")).toEqual(["fallback"]);
    // Whitespace around the template is assigned to the default slot.
    expect(children("spaced-slot")).toEqual([]);
  });

  it("follows only the open shadow roots the HTML parser attaches", () => {
    const source = `<!doctype html><html><body><main data-oid="sheet"><ul><li data-oid="row"><template shadowrootmode="open"><span>inert</span></template><a data-oid="link">Link</a></li></ul><div data-oid="twice"><template shadowrootmode="open"><b>first</b></template><template shadowrootmode="open"><i>second</i></template></div><x-closed data-oid="closed"><template shadowrootmode="closed"><button>Buy</button></template><em data-oid="unrendered">light</em></x-closed></main></body></html>`;
    const document = parse(source, { sourceCodeLocationInfo: true });
    const records = designNodeRecords(document);
    expect(records.map(({ element }) => element.tagName)).toEqual(["main", "ul", "li", "a", "div", "b", "x-closed", "em"]);
    const row = records.find(({ oid }) => oid === "row")!.element;
    expect(designRenderedChildElements(row).map((child) => child.tagName)).toEqual(["a"]);
    const healed = healDesignOids(source).html;
    expect(healed).toContain("<span>inert</span>");
    expect(healed).toContain("<i>second</i>");
    expect(healed).toContain("<button>Buy</button>");
  });

  it("gives a host its shadow root's children, as the browser renders them", () => {
    const document = parse(healDesignOids(SOURCE).html, { sourceCodeLocationInfo: true });
    const host = designNodeRecords(document).find(({ oid }) => oid === "host")!.element;
    expect(designRenderedChildElements(host).map((child) => child.tagName)).toEqual(["pre"]);
    const main = designNodeRecords(document).find(({ oid }) => oid === "sheet")!.element;
    // An inert template renders nothing and is not a layer.
    expect(designRenderedChildElements(main).map((child) => child.tagName)).toEqual(["diffs-container"]);
  });
});
