import { describe, expect, it } from "vitest";

import { expandDesignComponents, expandDesignComponentsForRender } from "../components";

const doc = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const options = (lines: string) => `<template data-zd-options>\n${lines}\n</template>`;
const CARD = doc(
  '<article class="card" data-oid="card" style="padding: 2px">' +
    '<h3 data-oid="card-title">{{ heading }}</h3>' +
    '<span class="chip" data-oid="chip" data-zd-for="i in range(2)">{{ i }}</span>' +
    '<zd-badge data-oid="inner"></zd-badge></article>',
  options([
    '<zd-option name="heading" type="text" default="Plans"></zd-option>',
    '<zd-option name="tone" type="color" default="#fff"></zd-option>', // check:ui ignore-line -- fixture colour
  ].join("\n")) + "<style>.card { background: var(--zd-tone); }</style>",
);
const BADGE = doc('<b data-oid="badge">B</b>');
const registry = new Map([["card", "parts/card.html"], ["badge", "parts/badge.html"]]);
const sources = { "parts/card.html": CARD, "parts/badge.html": BADGE };
const expand = (frame: string) => expandDesignComponents("/work/overrides", frame, sources, "home/index.html", { registry });

describe("an instance's part overrides", () => {
  it("add the host's zd-style-<part> after the part's own inline style, so the override wins over its rules and options", async () => {
    const result = await expand(doc('<zd-card data-oid="c1" tone="#eee" zd-style-card="background: #fde; padding: 4px" zd-style-card-title="color: red"></zd-card>')); // check:ui ignore-line -- fixture colour
    expect(result.errors).toEqual([]);
    expect(result.html).toContain('<article class="card" data-zd-part="card" style="padding: 2px; background: #fde; padding: 4px">'); // check:ui ignore-line -- fixture colour
    expect(result.html).toContain('<h3 data-zd-part="card-title" style="color: red">Plans</h3>');
  });

  it("style every repeated copy of a part, and a nested instance's host, but not the nested instance's own parts", async () => {
    const result = await expand(doc('<zd-card data-oid="c1" zd-style-chip="color: blue" zd-style-inner="display: block" zd-style-badge="color: green"></zd-card>'));
    expect(result.html).toContain('<span class="chip" data-zd-part="chip" style="color: blue">0</span><span class="chip" data-zd-part="chip#1" style="color: blue">1</span>');
    expect(result.html).toContain('<zd-badge data-zd-part="inner" style="display: block" data-zd-instance="2"><b data-zd-part="badge">B</b></zd-badge>');
  });

  it("leave the instance's slotted layers alone", async () => {
    const slotted = doc('<section data-zid="panel"><slot></slot></section>');
    const result = await expandDesignComponents("/work/overrides", doc('<zd-panel data-oid="p" zd-style-panel="gap: 8px"><p data-oid="mine" data-zd-part="panel">x</p></zd-panel>'),
      { "components/panel.html": slotted }, "home/index.html", { registry: new Map() });
    expect(result.html).toContain('<section data-zd-part="panel" style="gap: 8px"><p data-oid="mine" data-zd-part="panel">x</p></section>');
  });

  it("are reported on the host's record, apart from its options", async () => {
    const { instances } = await expandDesignComponentsForRender("/work/overrides",
      doc('<zd-card data-oid="c1" heading="Hi" zd-style-card="padding: 4px"></zd-card>'), sources, "home/index.html", { registry }, false);
    expect(instances?.hosts.c1).toEqual({ component: "card", attributes: { heading: "Hi" }, overrides: { card: "padding: 4px" } });
  });
});
