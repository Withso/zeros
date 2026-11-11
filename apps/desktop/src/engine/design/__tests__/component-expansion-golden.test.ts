import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { expandDesignComponents, expandDesignComponentsHtml } from "../components";

// Generated once by the expander before options existed; never regenerate it
// to make a change pass.
const golden = JSON.parse(readFileSync(new URL("./fixtures/component-expansion-golden.json", import.meta.url), "utf8")) as Record<string, unknown>;
const matchesGolden = (name: string, value: unknown) => expect(value).toEqual(golden[name]);

// The expander's output for components that declare no options, frozen from
// the build before options existed. Options must not change a byte of it.
const doc = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const CASES: Record<string, { frame: string; sources: Record<string, string>; entry?: string }> = {
  "slot children and fallback": {
    frame: doc('<zd-card data-oid="c1"><b data-oid="b">Hi</b></zd-card><zd-card data-oid="c2"></zd-card>'),
    sources: { "components/card.html": doc('<div class="card" data-zid="card"><slot>Empty</slot></div>', "<style>.card { padding: 8px; }</style>") },
  },
  "attribute slot, escaped, with fallback": {
    frame: doc('<zd-pill data-oid="p1" label="A &amp; <b>"></zd-pill><zd-pill data-oid="p2"></zd-pill>'),
    sources: { "components/pill.html": doc('<span data-zid="pill"><slot data-zd-attr="label">Default</slot></span>') },
  },
  "nested components and styles once each": {
    frame: doc('<zd-outer data-oid="o"></zd-outer><zd-outer data-oid="o2"></zd-outer>', "<title>t</title>"),
    sources: {
      "components/outer.html": doc('<section data-zid="s"><zd-inner></zd-inner></section>', "<style>.o { color: red; }</style>"),
      "components/inner.html": doc('<i data-zid="i">inner</i>', "<style>.i { color: blue; }</style>"),
    },
  },
  "a cycle stops with a diagnostic": {
    frame: doc('<zd-a data-oid="a"></zd-a>'),
    sources: { "components/a.html": doc("<div><zd-b></zd-b></div>"), "components/b.html": doc("<div><zd-a></zd-a></div>") },
  },
  "data-oid in a definition is reported and stripped": {
    frame: doc('<zd-bad data-oid="x"></zd-bad>'),
    sources: { "components/bad.html": doc('<div data-oid="inner" class="k">K</div>') },
  },
  "scripts, handlers and external URLs are reported": {
    frame: doc('<zd-unsafe data-oid="u"></zd-unsafe>'),
    sources: { "components/unsafe.html": doc('<div onclick="x()"><img src="https://example.com/a.png"></div><script>1</script>') },
  },
  "invalid HTML and a missing body": {
    frame: doc('<zd-broken data-oid="b"></zd-broken><zd-nobody data-oid="n"></zd-nobody>'),
    sources: { "components/broken.html": doc("<div><p>unclosed</div></span>"), "components/nobody.html": "<template>x</template>" },
  },
  "an instance with no definition stays as written": {
    frame: doc('<zd-missing data-oid="m">child</zd-missing>'),
    sources: {},
  },
  "a self-closing instance": {
    frame: doc('<p data-oid="p">a</p><zd-dot data-oid="d" /><p data-oid="q">b</p>'),
    sources: { "components/dot.html": doc('<span data-zid="dot">.</span>') },
  },
  "URLs are rebased into a page folder": {
    frame: doc('<zd-media data-oid="m"><img data-oid="slot" src="./local.png"></zd-media>'),
    sources: { "components/media.html": doc('<figure data-zid="f"><img data-zid="i" src="assets/a.png"><slot></slot></figure>', '<style>.f { background: url("assets/b.png"); }</style>') },
    entry: "page-1/home.html",
  },
  "double braces are plain text without a declaration": {
    frame: doc('<p data-oid="t">{{ width }}</p><zd-braces data-oid="b" label="{{ x }}"></zd-braces>'),
    sources: { "components/braces.html": doc('<span data-zid="s" title="{{ y }}">{{ label }}<slot data-zd-attr="label"></slot></span>') },
  },
  "partial definition identity is reported": {
    frame: doc('<zd-half data-oid="h"></zd-half>'),
    sources: { "components/half.html": doc('<div data-zid="a"><span>no id</span></div>') },
  },
};

describe("components without options expand exactly as before", () => {
  for (const [name, { frame, sources, entry = "" }] of Object.entries(CASES)) {
    it(name, async () => {
      const expanded = await expandDesignComponents("/work/golden", frame, sources, entry);
      matchesGolden(name, expanded);
      expect(await expandDesignComponentsHtml("/work/golden", frame, sources, entry)).toBe(expanded.html);
    });
  }

  it("leaves a frame with no instance untouched", async () => {
    const frame = doc('<p data-oid="p">{{ not a hole }}</p>');
    expect(await expandDesignComponentsHtml("/work/golden", frame, {})).toBe(frame);
  });

  it("stops at the shared instance budget as before", async () => {
    const source = "<zd-card></zd-card>".repeat(2200);
    const expanded = await expandDesignComponents("/work/golden", source, { "components/card.html": doc("<div>Content</div>") });
    matchesGolden("instance budget", expanded);
  });
});
