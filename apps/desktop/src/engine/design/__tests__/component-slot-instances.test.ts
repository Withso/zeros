import { describe, expect, it } from "vitest";

import { DESIGN_COMPONENT_RECORD_LIMITS } from "@zeros/protocol/design-catalog";
import { expandDesignComponents, expandDesignComponentsForRender } from "../components";

const doc = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const CARD = doc(
  '<article class="card" data-zid="card">' +
    '<p class="eyebrow" data-zid="card-meta"><slot data-zd-attr="meta">Card</slot></p>' +
    '<h3 data-zid="card-title"><slot data-zd-attr="heading">Untitled <b>card</b></slot></h3>' +
    '<p data-zid="card-note"><slot data-zd-attr="title">No title</slot></p>' +
    '<div data-zid="card-body"><slot>Nothing here yet.</slot></div></article>',
  "<style>zd-card { display: block; }</style>",
);
const sources = { "components/card.html": CARD };
const render = (frame: string) => expandDesignComponentsForRender("/work/slots", frame, sources, "start/welcome.html", { registry: new Map() }, false);

const FALLBACK_HOSTS = doc([
  '<zd-card data-oid="comment"><!--keep--></zd-card>',
  '<zd-card data-oid="whitespace"> \n\t </zd-card>',
  '<zd-card data-oid="text">Actual text</zd-card>',
  '<zd-card data-oid="element"><span>Nested content</span></zd-card>',
  '<zd-card data-oid="named"><b slot="actions">Named content</b><!--named-comment--></zd-card>',
].join(""));
const FALLBACK_CASES: Array<{
  kind: string;
  components: Readonly<Record<string, string>>;
  registry: Map<string, string>;
  fallback: string;
  fallbackCount: number;
}> = [
  {
    kind: "plain",
    components: { "components/card.html": doc('<article data-zid="card"><slot>plain-fallback</slot></article>') },
    registry: new Map<string, string>(),
    fallback: "plain-fallback",
    fallbackCount: 2,
  },
  {
    kind: "templated",
    components: {
      "parts/card.html": doc(
        '<article data-zid="card"><slot>templated-fallback</slot><section data-zd-slot="actions"><slot name="actions"></slot></section></article>',
        '<template data-zd-options><zd-option name="label" type="text" default="Card"></zd-option></template>',
      ),
    },
    registry: new Map([["card", "parts/card.html"]]),
    fallback: "templated-fallback",
    fallbackCount: 3,
  },
];

describe("a slot component's instances", () => {
  it("mark the host as an instance and each definition layer as its part", async () => {
    const result = await expandDesignComponents("/work/slots", doc('<zd-card data-oid="tour-1" meta="Page 1" heading="Start here">How to move.</zd-card>'), sources);
    expect(result.html).toContain(
      '<zd-card data-oid="tour-1" meta="Page 1" heading="Start here" data-zd-instance="1"><article class="card" data-zd-part="card">' +
        '<p class="eyebrow" data-zd-part="card-meta">Page 1</p><h3 data-zd-part="card-title">Start here</h3>' +
        '<p data-zd-part="card-note">No title</p><div data-zd-part="card-body">How to move.</div></article></zd-card>',
    );
    expect(result.html).not.toContain("data-zid");
  });

  it("mark a self-closing host as an instance too", async () => {
    const result = await expandDesignComponents("/work/slots", doc('<zd-card data-oid="solo" heading="Solo" />'), sources);
    // The host keeps the unclosed shape it always had; the browser nests the parts in it.
    expect(result.html).toContain('<zd-card data-oid="solo" heading="Solo" data-zd-instance="1" />');
  });

  it("report each attribute slot as a text option, and the host's text", async () => {
    const { instances } = await render(doc(
      '<zd-card data-oid="tour-1" meta="Page 1" heading="Start &amp; go" class="wide">How to <i>move</i>.</zd-card>' +
        '<zd-card data-oid="tour-2" title="Kept">Tokens &amp; themes</zd-card><zd-card data-oid="tour-3"></zd-card>',
    ));
    expect(instances?.components).toEqual({
      card: {
        elements: [
          { tag: "zd-option", attributes: [{ name: "name", value: "meta" }, { name: "type", value: "text" }, { name: "default", value: "Card" }] },
          { tag: "zd-option", attributes: [{ name: "name", value: "heading" }, { name: "type", value: "text" }, { name: "default", value: "Untitled card" }] },
        ],
        reach: {},
        file: "components/card.html",
        frame: false,
      },
    });
    // An attribute slot whose name no option may take (title) is not offered.
    expect(instances?.hosts).toEqual({
      "tour-1": { component: "card", attributes: { meta: "Page 1", heading: "Start & go" }, text: "How to .", mixedText: true },
      "tour-2": { component: "card", attributes: {}, text: "Tokens & themes" },
      "tour-3": { component: "card", attributes: {}, text: "" },
    });
  });

  it("reports bounded direct text for templated instances with a default slot", async () => {
    const component = doc(
      '<article data-zid="card"><slot></slot><div data-zd-slot="actions"><slot name="actions"></slot></div></article>',
      '<template data-zd-options><zd-option name="label" type="text" default="Card"></zd-option></template>',
    );
    const frame = doc(
      '<zd-card data-oid="mixed">Before &amp;<!--keep--><span data-oid="default-layer">Nested</span><b data-oid="named-layer" slot="actions">Action</b>after &amp;</zd-card>' +
        '<zd-card data-oid="text-only">Only &amp; text</zd-card>' +
        `<zd-card data-oid="too-long">${"x".repeat(DESIGN_COMPONENT_RECORD_LIMITS.attributeValue + 1)}</zd-card>`,
    );
    const result = await expandDesignComponentsForRender(
      "/work/slots",
      frame,
      { "parts/card.html": component },
      "start/welcome.html",
      { registry: new Map([["card", "parts/card.html"]]) },
      false,
    );

    expect(result.instances?.hosts.mixed).toMatchObject({
      text: "Before &after &",
      slotted: { "": ["default-layer"], actions: ["named-layer"] },
    });
    expect(result.instances?.hosts["text-only"]?.text).toBe("Only & text");
    expect(result.instances?.hosts["too-long"]).not.toHaveProperty("text");
  });

  it.each(FALLBACK_CASES)("uses $kind fallback for whitespace/comment-only children but not supplied text or elements", async ({ components, registry, fallback, fallbackCount, kind }) => {
    const result = await expandDesignComponentsForRender(
      "/work/slots",
      FALLBACK_HOSTS,
      components,
      "start/welcome.html",
      { registry },
      false,
    );
    expect(result.html.split(fallback).length - 1).toBe(fallbackCount);
    expect(result.html).toContain("Actual text");
    expect(result.html).toContain("Nested content");
    expect(result.html).toContain("Named content");
    if (kind === "templated") expect(result.html).toContain('<section data-zd-slot="actions"><b slot="actions">Named content</b></section>');
  });

  it("record an instance the frame places in another's slot, and none the definition places", async () => {
    const pill = doc('<span data-zid="pill"><slot data-zd-attr="label">Off</slot></span>');
    const badge = doc('<b data-zid="badge">{{ tone }}</b>', '<template data-zd-options><zd-option name="tone" type="choice" choices="info warn" default="info"></zd-option></template>');
    const panel = doc('<section data-zid="panel"><zd-pill data-zid="own" label="Inside"></zd-pill><slot></slot></section>');
    const { instances, html } = await expandDesignComponentsForRender("/work/slots",
      doc('<zd-panel data-oid="outer"><zd-pill data-oid="slotted" label="On"></zd-pill><zd-badge data-oid="tone" tone="warn"></zd-badge></zd-panel>'),
      { "components/pill.html": pill, "components/badge.html": badge, "components/panel.html": panel }, "start/welcome.html", { registry: new Map() }, false);
    expect(html).toContain('<b data-zd-part="badge" data-zd-root="">warn</b>');
    expect(Object.keys(instances?.hosts ?? {}).sort()).toEqual(["outer", "slotted", "tone"]);
    expect(instances?.hosts.slotted).toEqual({ component: "pill", attributes: { label: "On" } });
    expect(instances?.hosts.tone).toEqual({ component: "badge", attributes: { tone: "warn" } });
  });

  it("offer no text for a component without a default slot", async () => {
    const { instances } = await expandDesignComponentsForRender("/work/slots", doc('<zd-pill data-oid="p" label="On">x</zd-pill>'),
      { "components/pill.html": doc('<span data-zid="pill"><slot data-zd-attr="label">Off</slot></span>') }, "start/welcome.html", { registry: new Map() }, false);
    expect(instances?.hosts).toEqual({ p: { component: "pill", attributes: { label: "On" } } });
  });

  it("offers no text for a templated component without a default slot", async () => {
    const component = doc(
      '<span data-zid="pill"><slot data-zd-attr="label">Off</slot></span>',
      '<template data-zd-options><zd-option name="label" type="text" default="Off"></zd-option></template>',
    );
    const { instances } = await expandDesignComponentsForRender(
      "/work/slots",
      doc('<zd-pill data-oid="p">x</zd-pill>'),
      { "parts/pill.html": component },
      "start/welcome.html",
      { registry: new Map([["pill", "parts/pill.html"]]) },
      false,
    );
    expect(instances?.hosts.p).toMatchObject({ component: "pill" });
    expect(instances?.hosts.p).not.toHaveProperty("text");
  });
});
