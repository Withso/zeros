import { describe, expect, it } from "vitest";

import { expandDesignComponents, expandDesignComponentsForRender } from "../components";

const doc = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const CARD = doc('<article class="card" data-oid="card" style="padding: 2px"><h3 data-oid="card-title">{{ heading }}</h3></article>',
  '<template data-zd-options>\n<zd-option name="heading" type="text" default="Plans"></zd-option>\n</template><style>zd-card { display: block; }</style>');
const PAIR = doc('<b data-oid="one">1</b><i data-oid="two">2</i>');
const registry = new Map([["card", "parts/card.html"], ["pair", "parts/pair.html"]]);
const sources = { "parts/card.html": CARD, "parts/pair.html": PAIR };
const expand = (frame: string) => expandDesignComponents("/work/one-box", frame, sources, "home/index.html", { registry });

describe("an instance is one box", () => {
  it("lays out as its main's root layer: the host renders no box, and its own style and classes go on the root after its overrides", async () => {
    const result = await expand(doc('<main data-oid="m"><zd-card data-oid="c1" class="mt-4" style="width: 300px; position: absolute; left: 8px" zd-style-card="padding: 4px; width: 10px"></zd-card></main>'));
    expect(result.errors).toEqual([]);
    expect(result.html).toContain('<zd-card data-oid="c1" zd-style-card="padding: 4px; width: 10px" style="display: contents" data-zd-instance="1">');
    expect(result.html).toContain('<article class="card mt-4" data-zd-part="card" style="padding: 2px; padding: 4px; width: 10px; width: 300px; position: absolute; left: 8px" data-zd-root="">');
  });

  it("marks the root of an instance with no style of its own", async () => {
    const result = await expand(doc('<zd-card data-oid="c1"></zd-card>'));
    expect(result.html).toContain('<zd-card data-oid="c1" style="display: contents" data-zd-instance="1"><article class="card" data-zd-part="card" style="padding: 2px" data-zd-root="">');
  });

  it("keeps the host's box for a main of several layers", async () => {
    const result = await expand(doc('<zd-pair data-oid="p1" style="width: 300px"></zd-pair>'));
    expect(result.html).toContain('<zd-pair data-oid="p1" style="width: 300px" data-zd-instance="1"><b data-zd-part="one">1</b><i data-zd-part="two">2</i></zd-pair>');
  });

  it("keeps the host's box for a plain components/ file, which expands as it always has", async () => {
    const result = await expandDesignComponents("/work/one-box", doc('<zd-tag data-oid="t1" style="width: 3px"></zd-tag>'),
      { "components/tag.html": doc('<span data-zid="tag">T</span>') }, "home/index.html", { registry: new Map() });
    expect(result.html).toContain('<zd-tag data-oid="t1" style="width: 3px" data-zd-instance="1"><span data-zd-part="tag">T</span></zd-tag>');
  });

  it("reports the host's own style on its record, as an override of its root", async () => {
    const { instances } = await expandDesignComponentsForRender("/work/one-box",
      doc('<zd-card data-oid="c1" style="width: 300px"></zd-card><zd-pair data-oid="p1" style="width: 1px"></zd-pair>'), sources, "home/index.html", { registry }, false);
    expect(instances?.hosts.c1).toMatchObject({ component: "card", style: "width: 300px" });
    expect(instances?.hosts.p1?.style).toBeUndefined();
  });
});
