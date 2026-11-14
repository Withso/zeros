import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expandDesignComponents, scopeDesignComponentStyle } from "../components";

const doc = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

describe("a component's own style element in a frame that places it", () => {
  it("styles only the component's instances, its host included, and the rest of the frame keeps its own look", async () => {
    const pill = doc('<span class="badge" data-zid="badge"><slot></slot></span>', `<style>
zd-pill { display: inline-block; }
:root { --pill-gap: 3px; }
.badge { color: rgb(1, 2, 3); margin-left: var(--pill-gap); } /* check:ui ignore-line -- authored frame colour fixture. */
.badge::after { content: "!"; }
:where(.stage, zd-pill) > .badge { font-weight: 700; }
@media (min-width: 1px) { .badge { text-decoration: underline; } }
@keyframes pill-in { from { opacity: 0; } }
body { background: rgb(200, 0, 0); } /* check:ui ignore-line -- authored frame colour fixture. */
</style>`);
    const frame = doc('<main data-oid="m"><span class="badge" data-oid="plain">Plain</span><zd-pill data-oid="pill">New</zd-pill></main>');
    const result = await expandDesignComponents("/work/scoped", frame, { "components/pill.html": pill }, "home/index.html", {});
    expect(result.errors).toEqual([]);
    const page = await browser.newPage();
    try {
      await page.setContent(result.html);
      const read = (selector: string) => page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, margin: style.marginLeft, weight: style.fontWeight, line: style.textDecorationLine, display: style.display,
          after: getComputedStyle(element, "::after").content, background: getComputedStyle(document.body).backgroundColor };
      });
      const plain = await read('[data-oid="plain"]');
      const inside = await read("zd-pill .badge");
      const host = await read("zd-pill");
      expect(plain).toMatchObject({ color: "rgb(0, 0, 0)", margin: "0px", weight: "400", line: "none", after: "none", background: "rgba(0, 0, 0, 0)" }); // check:ui ignore-line -- authored frame colour fixture.
      expect(inside).toMatchObject({ color: "rgb(1, 2, 3)", margin: "3px", weight: "700", line: "underline", after: '"!"' }); // check:ui ignore-line -- authored frame colour fixture.
      expect(host.display).toBe("inline-block");
    } finally {
      await page.close();
    }
  });

  it("limits an @scope rule's root to the component's instances", async () => {
    expect(scopeDesignComponentStyle("card", "@scope (.card) to (.slot) { .title { color: red; } }"))
      .toBe("@scope (:is(.card):where(zd-card, zd-card *)) to (.slot) { .title { color: red; } }");
    expect(scopeDesignComponentStyle("card", "@scope (.a, :is(.b, .c)) { p { color: red; } }"))
      .toBe("@scope (:is(.a):where(zd-card, zd-card *), :is(:is(.b, .c)):where(zd-card, zd-card *)) { p { color: red; } }");
    expect(scopeDesignComponentStyle("card", "@scope { p { color: red; } }")).toBe("@scope (zd-card) { p { color: red; } }");
    expect(scopeDesignComponentStyle("card", "@scope to (.slot) { p { color: red; } }")).toBe("@scope (zd-card) to (.slot) { p { color: red; } }");
    expect(scopeDesignComponentStyle("card", "@media (min-width: 1px) { @scope (.card) { p { color: red; } } }"))
      .toBe("@media (min-width: 1px) { @scope (:is(.card):where(zd-card, zd-card *)) { p { color: red; } } }");
    expect(scopeDesignComponentStyle("card", '@scope ([title="a)b"]) to ([title=\'(\']) { p { color: red; } }'))
      .toBe('@scope (:is([title="a)b"]):where(zd-card, zd-card *)) to ([title=\'(\']) { p { color: red; } }');
    const card = doc('<article class="card" data-zid="card"><h3 class="title" data-zid="title">T</h3></article>',
      "<style>@scope (.card) { .title { color: rgb(1, 2, 3); } }</style>"); // check:ui ignore-line -- authored frame colour fixture.
    const frame = doc('<main data-oid="m"><article class="card" data-oid="plain-card"><h3 class="title" data-oid="plain">Plain</h3></article><zd-card data-oid="c"></zd-card></main>');
    const result = await expandDesignComponents("/work/scoped-at-scope", frame, { "components/card.html": card }, "home/index.html", {});
    expect(result.errors).toEqual([]);
    const page = await browser.newPage();
    try {
      await page.setContent(result.html);
      const color = (selector: string) => page.locator(selector).evaluate((element) => getComputedStyle(element).color);
      expect(await color("zd-card .title")).toBe("rgb(1, 2, 3)"); // check:ui ignore-line -- authored frame colour fixture.
      expect(await color('[data-oid="plain"]')).toBe("rgb(0, 0, 0)"); // check:ui ignore-line -- authored frame colour fixture.
    } finally {
      await page.close();
    }
  });

  it("keeps a pseudo-element written after a combinator on the descendants it names", async () => {
    expect(scopeDesignComponentStyle("field", ".field ::placeholder { color: red; }"))
      .toBe(":is(.field :where(*)):where(zd-field, zd-field *)::placeholder { color: red; }");
    expect(scopeDesignComponentStyle("field", ".list > ::marker, .a :before { color: red; }"))
      .toBe(":is(.list > :where(*)):where(zd-field, zd-field *)::marker, :is(.a :where(*)):where(zd-field, zd-field *):before { color: red; }");
    const field = doc('<label class="field" data-zid="field"><input data-zid="input" placeholder="Name"><ul class="list" data-zid="list"><li data-zid="item">A</li></ul></label>',
      "<style>.field ::placeholder { color: rgb(1, 2, 3); } .list > ::marker { color: rgb(4, 5, 6); }</style>"); // check:ui ignore-line -- authored frame colour fixture.
    const frame = doc('<main data-oid="m"><input data-oid="plain" placeholder="x"><zd-field data-oid="f"></zd-field></main>');
    const result = await expandDesignComponents("/work/scoped-pseudo", frame, { "components/field.html": field }, "home/index.html", {});
    expect(result.errors).toEqual([]);
    const page = await browser.newPage();
    try {
      await page.setContent(result.html);
      const pseudo = (selector: string, pseudoElement: string) =>
        page.locator(selector).evaluate((element, which) => getComputedStyle(element, which).color, pseudoElement);
      expect(await pseudo("zd-field input", "::placeholder")).toBe("rgb(1, 2, 3)"); // check:ui ignore-line -- authored frame colour fixture.
      expect(await pseudo("zd-field li", "::marker")).toBe("rgb(4, 5, 6)"); // check:ui ignore-line -- authored frame colour fixture.
      expect(await pseudo('[data-oid="plain"]', "::placeholder")).not.toBe("rgb(1, 2, 3)"); // check:ui ignore-line -- authored frame colour fixture.
    } finally {
      await page.close();
    }
  });
});
