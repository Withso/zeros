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
