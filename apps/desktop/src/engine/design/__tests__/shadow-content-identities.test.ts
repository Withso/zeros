import { parse } from "parse5";
import { describe, expect, it } from "vitest";
import { parseDesignWebProjection } from "@zeros/design-web";

import {
  designNodeRecords,
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
});
