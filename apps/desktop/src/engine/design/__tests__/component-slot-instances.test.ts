import { describe, expect, it } from "vitest";

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
      "tour-1": { component: "card", attributes: { meta: "Page 1", heading: "Start & go" } },
      "tour-2": { component: "card", attributes: {}, text: "Tokens & themes" },
      "tour-3": { component: "card", attributes: {}, text: "" },
    });
  });

  it("record an instance the frame places in another's slot, and none the definition places", async () => {
    const pill = doc('<span data-zid="pill"><slot data-zd-attr="label">Off</slot></span>');
    const badge = doc('<b data-zid="badge">{{ tone }}</b>', '<template data-zd-options><zd-option name="tone" type="choice" choices="info warn" default="info"></zd-option></template>');
    const panel = doc('<section data-zid="panel"><zd-pill data-zid="own" label="Inside"></zd-pill><slot></slot></section>');
    const { instances, html } = await expandDesignComponentsForRender("/work/slots",
      doc('<zd-panel data-oid="outer"><zd-pill data-oid="slotted" label="On"></zd-pill><zd-badge data-oid="tone" tone="warn"></zd-badge></zd-panel>'),
      { "components/pill.html": pill, "components/badge.html": badge, "components/panel.html": panel }, "start/welcome.html", { registry: new Map() }, false);
    expect(html).toContain('<b data-zd-part="badge">warn</b>');
    expect(Object.keys(instances?.hosts ?? {}).sort()).toEqual(["outer", "slotted", "tone"]);
    expect(instances?.hosts.slotted).toEqual({ component: "pill", attributes: { label: "On" } });
    expect(instances?.hosts.tone).toEqual({ component: "badge", attributes: { tone: "warn" } });
  });

  it("offer no text for a component without a default slot", async () => {
    const { instances } = await expandDesignComponentsForRender("/work/slots", doc('<zd-pill data-oid="p" label="On">x</zd-pill>'),
      { "components/pill.html": doc('<span data-zid="pill"><slot data-zd-attr="label">Off</slot></span>') }, "start/welcome.html", { registry: new Map() }, false);
    expect(instances?.hosts).toEqual({ p: { component: "pill", attributes: { label: "On" } } });
  });
});
