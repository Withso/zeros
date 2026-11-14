import { describe, expect, it } from "vitest";

import { designComponentSummaryOf, expandDesignComponents, expandDesignComponentsForRender } from "../components";

const doc = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const options = (lines: string) => `<template data-zd-options>\n${lines}\n</template>`;
const CARD = doc(
  '<article data-oid="card"><h3 data-oid="title">{{ heading }}</h3>' +
    '<div data-oid="body" data-zd-slot="content" style="display: flex"><p data-oid="placeholder">Empty</p></div>' +
    '<footer data-oid="foot"><slot>No footer</slot></footer></article>',
  options('<zd-option name="heading" type="text" default="Plans"></zd-option>'),
);
const PLAIN = doc('<section data-zid="panel"><div data-zid="top" data-zd-slot="top">Top</div><slot></slot></section>');
const registry = new Map([["card", "parts/card.html"]]);
const sources = { "parts/card.html": CARD, "components/panel.html": PLAIN };
const expand = (body: string) => expandDesignComponents("/work/slots", doc(body), sources, "home/index.html", { registry });
const render = (body: string) => expandDesignComponentsForRender("/work/slots", doc(body), sources, "home/index.html", { registry }, false);

describe("a main component's slots", () => {
  it("take the instance's layers named for them, and the rest go to the default slot", async () => {
    const result = await expand('<zd-card data-oid="c1"><p data-oid="mine" slot="content">x</p><em data-oid="rest">y</em></zd-card>');
    expect(result.errors).toEqual([]);
    expect(result.html).toContain('<div data-zd-part="body" data-zd-slot="content" style="display: flex"><p data-oid="mine" slot="content">x</p></div>');
    expect(result.html).toContain('<footer data-zd-part="foot"><em data-oid="rest">y</em></footer>');
  });

  it("show what the main puts in them until the instance fills them, whitespace aside", async () => {
    const empty = await expand('<zd-card data-oid="c2"></zd-card>');
    expect(empty.html).toContain('<div data-zd-part="body" data-zd-slot="content" style="display: flex"><p data-zd-part="placeholder">Empty</p></div>');
    expect(empty.html).toContain('<footer data-zd-part="foot">No footer</footer>');
    const named = await expand('<zd-card data-oid="c3">\n  <b data-oid="only" slot="content">b</b>\n</zd-card>');
    expect(named.html).toContain('<b data-oid="only" slot="content">b</b></div>');
    expect(named.html).toContain('<footer data-zd-part="foot">No footer</footer>');
  });

  it("are options of the component, which an attribute cannot set", async () => {
    const declared = designComponentSummaryOf(CARD)!;
    expect(declared.elements).toContainEqual({ tag: "zd-option", attributes: [{ name: "name", value: "content" }, { name: "type", value: "slot" }] });
    const result = await render('<zd-card data-oid="c1" content="x"></zd-card>');
    expect(result.componentOptions).toBeUndefined();
    expect(result.instances?.components.card?.elements).toContainEqual(
      { tag: "zd-option", attributes: [{ name: "name", value: "content" }, { name: "type", value: "slot" }] });
    const warned = await expand('<zd-card data-oid="c1" content="x"></zd-card>');
    expect(warned.errors.map((error) => error.severity)).toEqual(["warning"]);
  });

  it("report the layers each slot holds on the host's record", async () => {
    const { instances } = await render('<zd-card data-oid="c1"><p data-oid="mine" slot="content">x</p>text<em data-oid="rest">y</em><i>no id</i></zd-card><zd-card data-oid="c2"></zd-card>');
    expect(instances?.hosts.c1?.slotted).toEqual({ content: ["mine"], "": ["rest"] });
    expect(instances?.hosts.c2?.slotted).toBeUndefined();
  });

  it("work in a components/ file too", async () => {
    const result = await expand('<zd-panel data-oid="p1"><b data-oid="t" slot="top">T</b><i data-oid="r">R</i></zd-panel>');
    expect(result.html).toContain('<section data-zd-part="panel"><div data-zd-part="top" data-zd-slot="top"><b data-oid="t" slot="top">T</b></div><i data-oid="r">R</i></section>');
    const { instances } = await render('<zd-panel data-oid="p1"><b data-oid="t" slot="top">T</b></zd-panel>');
    expect(instances?.components.panel?.elements).toContainEqual({ tag: "zd-option", attributes: [{ name: "name", value: "top" }, { name: "type", value: "slot" }] });
    expect(instances?.hosts.p1?.slotted).toEqual({ top: ["t"] });
  });
});
