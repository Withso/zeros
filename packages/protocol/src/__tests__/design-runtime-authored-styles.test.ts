import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  DESIGN_RUNTIME_SOURCE,
  isDesignRuntimeAuthoredStyles,
  type DesignRuntimeNodeDetails,
} from "../design-runtime";

type RuntimeWindow = Window & {
  __zerosDesignSourceVersion: string;
  detailsRequest: (nodeId: string) => Promise<DesignRuntimeNodeDetails>;
};

// The head mirrors a composed frame document: the reset layer-order prelude,
// an imported Tailwind-like source and a plain CSS source, the linked
// tokens.css, then the frame's own <style>.
const HEAD = `
<style data-zeros-layer-order="">@layer reset;</style>
<style data-zeros-style-source="app">
  @layer theme, base, components, utilities;
  @layer theme { :root { --primary-button-bg: rgb(44, 40, 38); --spacing: 4px; } }
  @layer base { button { color: inherit; } }
  @layer utilities {
    .bg-primary-button-bg { background-color: var(--primary-button-bg); }
    .text-white { color: white; }
    .p-3 { padding: calc(var(--spacing) * 3); }
    .pt-1 { padding-top: 4px; }
    .rounded-md { border-radius: 6px; }
  }
</style>
<style data-zeros-style-source="semantic">:root { --brand: rebeccapurple; }</style>
<style data-zeros-source="tokens.css">
  @layer reset { button { font: inherit; color: inherit; } h1 { margin: 0; } }
  .card { border-color: var(--brand) !important; }
</style>
<style>
  #hero.card { border-color: red; border-style: solid; }
  main .title { color: var(--brand); }
  .title { color: blue; }
  .stack { gap: 8px; }
  :where(.stack) { gap: 2px; }
</style>`;
const BODY = `
<main data-oid="main">
  <button data-oid="button" class="bg-primary-button-bg text-white p-3 rounded-md">Go</button>
  <h1 data-oid="title" class="title">Title</h1>
  <div data-oid="card" id="hero" class="card" style="color: green">Card</div>
  <div data-oid="mixed" class="p-3 pt-1 stack">Mixed</div>
</main>`;

async function fixture(browser: Browser, head = HEAD, body = BODY): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluate(
    async ({ source, head, body }) => {
      document.head.innerHTML = head;
      document.body.innerHTML = body;
      const runtimeWindow = window as unknown as RuntimeWindow;
      runtimeWindow.__zerosDesignSourceVersion = "a".repeat(24);
      new Function(source)();
      const channel = new MessageChannel();
      const pending = new Map<string, (value: DesignRuntimeNodeDetails) => void>();
      let count = 0;
      const ready = new Promise<void>((resolve) => {
        channel.port1.onmessage = (event) => {
          if (event.data.type === "event" && event.data.event === "ready") resolve();
          if (event.data.type === "response") {
            pending.get(event.data.requestId)?.(event.data.result);
            pending.delete(event.data.requestId);
          }
        };
      });
      runtimeWindow.detailsRequest = (nodeId) =>
        new Promise((resolve) => {
          const requestId = String(++count);
          pending.set(requestId, resolve);
          channel.port1.postMessage({
            protocol: "zeros-design-runtime",
            version: 2,
            type: "request",
            sourceVersion: runtimeWindow.__zerosDesignSourceVersion,
            requestId,
            method: "getNodeDetails",
            args: { nodeId },
          });
        });
      channel.port1.start();
      window.postMessage(
        {
          protocol: "zeros-design-runtime",
          version: 2,
          type: "handshake",
          sourceVersion: runtimeWindow.__zerosDesignSourceVersion,
        },
        "*",
        [channel.port2],
      );
      await ready;
    },
    { source: DESIGN_RUNTIME_SOURCE, head, body },
  );
  return page;
}

const details = (page: Page, nodeId: string) =>
  page.evaluate(
    (nodeId) => (window as unknown as RuntimeWindow).detailsRequest(nodeId),
    nodeId,
  );

describe("winning authored declarations in Chromium", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await fixture(browser);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("reports a Tailwind utility's token reference and the source that declares it", async () => {
    const button = await details(page, "button");
    expect(button.authoredStyles?.["background-color"]).toEqual({
      origin: "source",
      sourceId: "app",
      selector: ".bg-primary-button-bg",
      scope: "element",
      subjectClasses: ["bg-primary-button-bg"],
      value: "var(--primary-button-bg)",
      tokens: [
        {
          name: "--primary-button-bg",
          value: "rgb(44, 40, 38)",
          origin: "source",
          sourceId: "app",
        },
      ],
    });
    // The utilities layer outranks both the base layer and the earlier reset.
    expect(button.authoredStyles?.color).toMatchObject({
      origin: "source",
      sourceId: "app",
      value: "white",
    });
    expect(button.authoredStyles?.padding).toMatchObject({
      value: "calc(var(--spacing) * 3)",
      tokens: [{ name: "--spacing", value: "4px", origin: "source", sourceId: "app" }],
    });
    expect(isDesignRuntimeAuthoredStyles(button.authoredStyles)).toBe(true);
  });

  it("separates rules that target a layer from shared resets", async () => {
    const button = await details(page, "button");
    // The reset layer's type selector reaches every button; the utility
    // classes name this one.
    expect(button.authoredStyles?.font).toMatchObject({ selector: "button", scope: "base" });
    expect(button.authoredStyles?.color).toMatchObject({ selector: ".text-white", scope: "element" });
    const card = await details(page, "card");
    expect(card.authoredStyles?.color).toMatchObject({ scope: "inline" });
    expect(card.authoredStyles?.color?.selector).toBeUndefined();
  });

  it("chooses by specificity before order, and !important before specificity", async () => {
    const title = await details(page, "title");
    expect(title.authoredStyles?.color).toEqual({
      origin: "frame",
      selector: "main .title",
      scope: "element",
      subjectClasses: ["title"],
      value: "var(--brand)",
      tokens: [
        { name: "--brand", value: "rebeccapurple", origin: "source", sourceId: "semantic" },
      ],
    });
    const card = await details(page, "card");
    expect(card.authoredStyles?.["border-color"]).toMatchObject({
      origin: "linked",
      file: "tokens.css",
      value: "var(--brand)",
      important: true,
    });
    // The style attribute wins at the same importance.
    expect(card.authoredStyles?.color).toEqual({ origin: "inline", scope: "inline", value: "green" });
  });

  it("omits a shorthand partly overridden by a longhand, and :where() has no specificity", async () => {
    const mixed = await details(page, "mixed");
    expect(mixed.authoredStyles?.padding).toBeUndefined();
    expect(mixed.authoredStyles?.["padding-top"]).toMatchObject({ value: "4px" });
    expect(mixed.authoredStyles?.gap).toMatchObject({ origin: "frame", value: "8px" });
  });

  it.each([false, true])("does not assign an inline var shorthand's longhand to a losing rule (important: %s)", async (important) => {
    const scoped = await fixture(browser, `<style>
      :root { --old: red; --new: blue; }
      .card { background-color: var(--old)${important ? " !important" : ""}; }
    </style>`, `<div data-oid="card" class="card" style="background:var(--new)${important ? " !important" : ""}">Card</div>`);
    try {
      expect(await scoped.locator(".card").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(0, 0, 255)");
      const card = await details(scoped, "card");
      expect(card.authoredStyles?.["background-color"]).toBeUndefined();
      expect(card.authoredStyles?.background).toMatchObject({ origin: "inline", value: "var(--new)" });
    } finally {
      await scoped.close();
    }
  });

  it("still reports an important rule that beats a normal inline variable shorthand", async () => {
    const scoped = await fixture(browser, `<style>
      :root { --old: red; --new: blue; }
      .card { background-color: var(--old) !important; }
    </style>`, '<div data-oid="card" class="card" style="background:var(--new)">Card</div>');
    try {
      expect(await scoped.locator(".card").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 0, 0)");
      const card = await details(scoped, "card");
      expect(card.authoredStyles?.["background-color"]).toMatchObject({ value: "var(--old)", important: true });
      expect(card.authoredStyles?.background).toBeUndefined();
    } finally {
      await scoped.close();
    }
  });

  // One level of nesting under a simple parent resolves the way Tailwind v4
  // emits its variants; anything deeper is left to the computed value.
  it.each([
    [".card { color: var(--outer); & { color: var(--inner); } }", ".card"],
    [".wrapper { .card { color: var(--inner); } }", ".wrapper .card"],
    [".card { @media (min-width: 1px) { color: var(--inner); } }", ".card"],
  ])("resolves one level of nesting to the rule that wins: %s", async (nested, selector) => {
    const scoped = await fixture(browser, `<style>
      :root { --outer: red; --inner: blue; }
      .card { color: var(--outer); padding: 4px; }
      ${nested}
    </style>`, '<div class="wrapper"><div data-oid="card" class="card">Card</div></div>');
    try {
      expect(await scoped.locator(".card").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(0, 0, 255)");
      const card = await details(scoped, "card");
      expect(card.authoredStyles?.color).toMatchObject({ selector, value: "var(--inner)" });
      expect(card.authoredStyles?.padding).toMatchObject({ value: "4px" });
    } finally {
      await scoped.close();
    }
  });

  it.each([
    ".wrapper { .inner { .card { color: var(--inner); } } }",
    ".wrapper, .other { .card { color: var(--inner); } }",
  ])("uses computed values when deeper nesting can override a declaration: %s", async (nested) => {
    const scoped = await fixture(browser, `<style>
      :root { --outer: red; --inner: blue; }
      .card { color: var(--outer); padding: 4px; }
      ${nested}
    </style>`, '<div class="wrapper"><div class="inner"><div data-oid="card" class="card">Card</div></div></div>');
    try {
      expect(await scoped.locator(".card").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(0, 0, 255)");
      const card = await details(scoped, "card");
      expect(card.authoredStyles?.color).toBeUndefined();
      expect(card.authoredStyles?.padding).toMatchObject({ value: "4px" });
    } finally {
      await scoped.close();
    }
  });

  it.each([100, 600])("does not claim a winner from an element-dependent container query at %s px", async (width) => {
    const scoped = await fixture(browser, `<style>
      :root { --small: red; --large: blue; }
      .container { container-type: inline-size; width: ${width}px; }
      .card, .outside { color: var(--small); padding: 4px; }
      @container (min-width: 500px) { .card { color: var(--large); } }
    </style>`, '<div class="container"><div data-oid="card" class="card">Card</div></div><div data-oid="outside" class="outside">Outside</div>');
    try {
      expect(await scoped.locator(".card").evaluate((element) => getComputedStyle(element).color)).toBe(width < 500 ? "rgb(255, 0, 0)" : "rgb(0, 0, 255)");
      const card = await details(scoped, "card");
      expect(card.authoredStyles?.color).toBeUndefined();
      expect(card.authoredStyles?.padding).toMatchObject({ value: "4px" });
      expect((await details(scoped, "outside")).authoredStyles?.color).toMatchObject({ value: "var(--small)" });
    } finally {
      await scoped.close();
    }
  });

  it("attributes a nested token override to the nested rule, not an ancestor's declaration", async () => {
    const scoped = await fixture(browser, `<style data-zeros-source="tokens.css">
      :root { --brand: red; }
      .card { color: var(--brand); & { --brand: blue; } }
    </style>`, '<div data-oid="card" class="card">Card</div>');
    const deep = await fixture(browser, `<style data-zeros-source="tokens.css">
      :root { --brand: red; }
      .card { color: var(--brand); & { & { --brand: green; } } }
    </style>`, '<div data-oid="deep" class="card">Deep</div>');
    try {
      expect((await details(scoped, "card")).authoredStyles?.color).toMatchObject({
        value: "var(--brand)", tokens: [{ name: "--brand", value: "blue", origin: "linked", file: "tokens.css" }],
      });
      // Two levels down stays uncertain: the value is reported, the origin is not.
      expect((await details(deep, "deep")).authoredStyles?.color).toMatchObject({
        value: "var(--brand)", tokens: [{ name: "--brand", value: "green" }],
      });
      expect((await details(deep, "deep")).authoredStyles?.color?.tokens?.[0]?.origin).toBeUndefined();
    } finally {
      await scoped.close();
      await deep.close();
    }
  });
});

/** Measured on the previous runtime with the fixture below. */
const BASELINE_COST = {
  drawn: { matches: 11, queries: 0 },
  oneOverride: { matches: 11, queries: 0 },
  card: { matches: 11, queries: 0 },
};

// Where a value comes from: a class, a utility, a component, this layer's own
// declaration and what it replaced, and a declaration that differs by theme.
const ORIGINS_HEAD = `
<style data-zeros-style-source="app">
  @layer theme, utilities;
  @layer theme { :root { --radius-md: 6px; --bg: white; } }
  @layer utilities { .p-2\\.5 { padding: 10px; } .rounded-md { border-radius: 6px; } }
</style>
<style data-zeros-component="chip">.chip { gap: 4px; --chip-inset: 3px; text-indent: var(--chip-inset); }</style>
<style>
  .btn { border-radius: var(--radius-md); padding: 8px 12px; color: navy; }
  .btn.btn--primary { background-color: var(--bg); }
  [data-oid="own-rule"] { color: maroon; }
  .legacy { border-radius: 4px !important; }
  .card { background-color: white; }
  [data-zd-theme="dark"] .card { background-color: black; }
  .themed-token { background-color: var(--bg); }
</style>`;
const ORIGINS_BODY = `
<button data-oid="changed" class="btn btn--primary" style="border-radius: 8px; padding: 2px">Send</button>
<button data-oid="one-override" class="btn" style="border-radius: 8px">One override</button>
<button data-oid="own-rule" class="btn">Own rule</button>
<button data-oid="other" class="btn">Other</button>
<div data-oid="drawn" style="border-radius: 3px; width: 40px">Drawn</div>
<div data-oid="forced" class="legacy" style="border-radius: 9px">Forced</div>
<div data-oid="chip" class="chip">Chip</div>
<div data-oid="card" class="card">Card</div>
<div data-oid="themed-token" class="themed-token">Token</div>
<div data-oid="utility" class="p-2.5 rounded-md">Utility</div>`;

describe("where a value comes from, in Chromium", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await fixture(browser, ORIGINS_HEAD, ORIGINS_BODY);
    await page.evaluate(() => document.documentElement.setAttribute("data-zd-theme", "light"));
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("says what this layer's own declaration replaced, and how it was written", async () => {
    const changed = await details(page, "changed");
    expect(changed.authoredStyles?.["border-radius"]).toEqual({
      origin: "inline",
      scope: "inline",
      value: "8px",
      declared: "border-radius",
      replaced: {
        origin: "frame",
        selector: ".btn",
        scope: "element",
        subjectClasses: ["btn"],
        value: "var(--radius-md)",
        tokens: [{ name: "--radius-md", value: "6px" }],
        others: 3,
      },
    });
    // A shorthand written on the layer is reported as written.
    expect(changed.authoredStyles?.padding).toMatchObject({
      declared: "padding",
      replaced: { selector: ".btn", value: "8px 12px", others: 3 },
    });
    // A class value nothing overrides has nothing replaced.
    expect(changed.authoredStyles?.["background-color"]).toEqual({
      origin: "frame",
      selector: ".btn.btn--primary",
      scope: "element",
      subjectClasses: ["btn", "btn--primary"],
      value: "var(--bg)",
      tokens: [{ name: "--bg", value: "white", origin: "source", sourceId: "app" }],
    });
    expect(isDesignRuntimeAuthoredStyles(changed.authoredStyles)).toBe(true);
  });

  it("treats a rule written for exactly this layer as its own", async () => {
    const own = await details(page, "own-rule");
    expect(own.authoredStyles?.color).toMatchObject({
      selector: '[data-oid="own-rule"]',
      value: "maroon",
      declared: "color",
      replaced: { selector: ".btn", value: "navy", others: 3 },
    });
    expect(own.authoredStyles?.color?.subjectClasses).toBeUndefined();
  });

  it("reports nothing replaced for a layer drawn by hand, or a value forced over it", async () => {
    const drawn = await details(page, "drawn");
    expect(drawn.authoredStyles?.["border-radius"]).toEqual({ origin: "inline", scope: "inline", value: "3px" });
    const forced = await details(page, "forced");
    expect(forced.authoredStyles?.["border-radius"]).toEqual({
      origin: "frame",
      selector: ".legacy",
      scope: "element",
      subjectClasses: ["legacy"],
      value: "4px",
      important: true,
    });
  });

  it("names the component that declares a token a value reads", async () => {
    expect((await details(page, "chip")).authoredStyles?.["text-indent"]?.tokens).toEqual([
      { name: "--chip-inset", value: "3px", origin: "frame", component: "chip" },
    ]);
  });

  it("names a component's styles and a utility's escaped class", async () => {
    expect((await details(page, "chip")).authoredStyles?.gap).toMatchObject({
      origin: "frame",
      component: "chip",
      subjectClasses: ["chip"],
    });
    expect((await details(page, "utility")).authoredStyles?.padding).toMatchObject({
      origin: "source",
      sourceId: "app",
      selector: ".p-2\\.5",
      subjectClasses: ["p-2.5"],
    });
  });

  it("gives another theme's value only where the declaration itself differs", async () => {
    expect((await details(page, "card")).authoredStyles?.["background-color"]).toMatchObject({
      value: "white",
      themeValues: { dark: "black" },
    });
    expect((await details(page, "themed-token")).authoredStyles?.["background-color"]?.themeValues).toBeUndefined();
  });

  it("reports the root font size for rem", async () => {
    expect((await details(page, "drawn")).rootFontSize).toBe(16);
  });
});

describe("review fixes for where a value comes from, in Chromium", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // The engine removes a layer's own declaration only from an unconditional
  // [data-oid] rule (packages/design-web/src/css.ts, mutateDesignNodeStyles);
  // one inside @media, @supports or @layer is not the layer's to reset.
  it("does not report a conditional rule written for the layer as its own change", async () => {
    const page = await fixture(browser, `<style>
      .btn { color: navy; padding: 4px; }
      @media (min-width: 1px) { [data-oid="cond"] { color: maroon; } }
      @supports (display: grid) { [data-oid="cond"] { padding: 2px; } }
      [data-oid="plain"] { color: maroon; }
    </style>`, '<button data-oid="cond" class="btn">Cond</button><button data-oid="plain" class="btn">Plain</button>');
    try {
      const cond = await details(page, "cond");
      expect(cond.authoredStyles?.color).toMatchObject({ selector: '[data-oid="cond"]', value: "maroon", conditional: true });
      expect(cond.authoredStyles?.color?.replaced).toBeUndefined();
      expect(cond.authoredStyles?.padding).toMatchObject({ value: "2px", conditional: true });
      expect(cond.authoredStyles?.padding?.replaced).toBeUndefined();
      expect(isDesignRuntimeAuthoredStyles(cond.authoredStyles)).toBe(true);
      const plain = await details(page, "plain");
      expect(plain.authoredStyles?.color).toMatchObject({ value: "maroon", replaced: { selector: ".btn" } });
      expect(plain.authoredStyles?.color?.conditional).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  // Regression: the layer's own custom property reported declared "--gap",
  // the validator refused it and the bridge dropped every origin.
  it("reports what a layer's own custom property replaced in a form its validator accepts", async () => {
    const page = await fixture(browser, `<style>
      .card { --gap: 8px; gap: var(--gap); }
    </style>`, '<div data-oid="card" class="card" style="--gap: 12px">Card</div>');
    try {
      const card = await details(page, "card");
      expect(card.authoredStyles?.["--gap"]).toMatchObject({ scope: "inline", value: "12px", declared: "--gap", replaced: { selector: ".card", value: "8px" } });
      expect(isDesignRuntimeAuthoredStyles(card.authoredStyles)).toBe(true);
    } finally {
      await page.close();
    }
  });

  // Reset removes the style attribute's declaration when there is one, and
  // the layer's own rule only when there is none (mutateDesignNodeStyles);
  // what it replaced is what shows after Reset.
  it("reports as replaced what shows once Reset removes the declaration it targets", async () => {
    const page = await fixture(browser, `<style>
      .btn { color: navy; }
      [data-oid="both"] { color: maroon; }
      [data-oid="twice"] { color: maroon; }
      [data-oid="twice"] { color: teal; }
    </style>`, '<button data-oid="both" class="btn" style="color: red">Both</button><button data-oid="twice" class="btn">Twice</button>');
    try {
      expect((await details(page, "both")).authoredStyles?.color).toMatchObject({
        scope: "inline", value: "red", replaced: { selector: '[data-oid="both"]', value: "maroon" },
      });
      // Two rules for the layer: Reset cannot pick one, so it is not offered.
      expect((await details(page, "twice")).authoredStyles?.color?.replaced).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  // The engine reads a nested rule's selector as written (&), so one level
  // of nesting resolved for provenance is still not the layer's to reset.
  it("does not report a nested rule that resolves to the layer as its own change", async () => {
    const page = await fixture(browser, `<style>
      .btn { color: navy; }
      [data-oid="nested"] { & { color: maroon; } }
    </style>`, '<button data-oid="nested" class="btn">Nested</button>');
    try {
      const nested = await details(page, "nested");
      expect(nested.authoredStyles?.color).toMatchObject({ selector: '[data-oid="nested"]', value: "maroon", conditional: true });
      expect(nested.authoredStyles?.color?.replaced).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  // CSSOM writes a class that starts with a digit (2xl:) as \32 xl…; the
  // space ends the escape, not the compound.
  it("names a class that starts with a digit", async () => {
    const page = await fixture(browser, `<style>
      .\\32xl\\:p-4 { padding: 4px; }
      .wrap .\\31 23 { gap: 2px; }
    </style>`, '<div class="wrap"><div data-oid="digit" class="2xl:p-4 123">Digit</div></div>');
    try {
      const digit = await details(page, "digit");
      expect(digit.authoredStyles?.padding?.subjectClasses).toEqual(["2xl:p-4"]);
      expect(digit.authoredStyles?.gap?.subjectClasses).toEqual(["123"]);
    } finally {
      await page.close();
    }
  });

  it("names only the classes of the selector branches that match the layer", async () => {
    const page = await fixture(browser, `<style>
      .enabled .foo, .disabled .bar { color: red; }
      .solo { padding: 1px; }
    </style>`, '<div class="enabled"><div data-oid="both" class="foo bar solo">Both</div></div>');
    try {
      const both = await details(page, "both");
      expect(both.authoredStyles?.color).toMatchObject({ selector: ".enabled .foo, .disabled .bar", subjectClasses: ["foo"] });
      expect(both.authoredStyles?.padding?.subjectClasses).toEqual(["solo"]);
    } finally {
      await page.close();
    }
  });

  it("gives another theme's value for a longhand its rule sets through a shorthand", async () => {
    const page = await fixture(browser, `<style>
      .card { background-color: white; }
      [data-zd-theme="dark"] .card { background: black; }
    </style>`, '<div data-oid="card" class="card">Card</div>');
    try {
      await page.evaluate(() => document.documentElement.setAttribute("data-zd-theme", "light"));
      expect((await details(page, "card")).authoredStyles?.["background-color"]).toMatchObject({
        value: "white",
        themeValues: { dark: "black" },
      });
    } finally {
      await page.close();
    }
  });

  it("ranks a theme rule by the branch that matches, not an unrelated one", async () => {
    const page = await fixture(browser, `<style>
      [data-zd-theme="dark"] .card, #unrelated { background-color: black; }
      .card.card-x.card-y { background-color: white; }
    </style>`, '<div data-oid="card" class="card card-x card-y">Card</div>');
    try {
      await page.evaluate(() => document.documentElement.setAttribute("data-zd-theme", "light"));
      const light = await details(page, "card");
      expect(light.authoredStyles?.["background-color"]).toMatchObject({ value: "white" });
      expect(light.authoredStyles?.["background-color"]?.themeValues).toBeUndefined();
      // The real dark theme agrees: the class rule still wins there.
      await page.evaluate(() => document.documentElement.setAttribute("data-zd-theme", "dark"));
      expect(await page.locator(".card").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
    } finally {
      await page.close();
    }
  });

  it("costs a rule with one selector nothing more, and one match per extra branch", async () => {
    const page = await fixture(browser, `<style>
      .enabled .foo, .disabled .bar { color: red; }
      .solo { padding: 1px; }
      [data-zd-theme="dark"] .card, #unrelated { background-color: black; }
      .card.card-x.card-y { background-color: white; }
    </style>`, '<div class="enabled"><div data-oid="both" class="foo bar solo">Both</div></div><div data-oid="card" class="card card-x card-y">Card</div><div data-oid="warm" class="solo">Warm</div>');
    try {
      const counts = await page.evaluate(async () => {
        document.documentElement.setAttribute("data-zd-theme", "light");
        const runtime = window as unknown as RuntimeWindow;
        await runtime.detailsRequest("warm");
        const seen: string[] = [];
        const matches = Element.prototype.matches;
        Element.prototype.matches = function (this: Element, selector: string) {
          seen.push(selector);
          return matches.call(this, selector);
        };
        await runtime.detailsRequest("both");
        const both = seen.splice(0);
        await runtime.detailsRequest("card");
        const card = seen.splice(0);
        Element.prototype.matches = matches;
        return { both, card };
      });
      // The two-branch rule costs each branch once more than the whole list;
      // the one-selector rule costs no more than any rule's own match.
      expect(counts.both.filter((selector) => selector === ".enabled .foo" || selector === ".disabled .bar")).toEqual([".enabled .foo", ".disabled .bar"]);
      expect(counts.both.filter((selector) => selector === ".solo").length).toBe(
        counts.both.filter((selector) => selector === ".enabled .foo, .disabled .bar").length,
      );
      // The theme pass tests each rewritten branch once, in place of the list.
      expect(counts.card.filter((selector) => selector === ":root .card" || selector === "#unrelated")).toEqual([":root .card", "#unrelated"]);
      expect(counts.card.filter((selector) => selector.includes(":root .card,"))).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

// Selection cost: element.matches and querySelectorAll calls one
// getNodeDetails makes on a cold element, against the counts measured before
// this provenance existed (scratchpad probe on the previous runtime).
describe("provenance cost per selection", () => {
  const counted = async (nodeId: string) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await fixture(browser, ORIGINS_HEAD, ORIGINS_BODY);
      return await page.evaluate(async (nodeId) => {
        const runtime = window as unknown as RuntimeWindow;
        document.documentElement.setAttribute("data-zd-theme", "light");
        // Build the rule index on another element first.
        await runtime.detailsRequest("other");
        const counts = { matches: 0, queries: 0 };
        const matches = Element.prototype.matches;
        Element.prototype.matches = function (this: Element, selector: string) {
          counts.matches += 1;
          return matches.call(this, selector);
        };
        for (const prototype of [Document.prototype, Element.prototype, DocumentFragment.prototype]) {
          const query = prototype.querySelectorAll;
          prototype.querySelectorAll = function (this: ParentNode, selector: string) {
            counts.queries += 1;
            return query.call(this, selector);
          } as typeof query;
        }
        await runtime.detailsRequest(nodeId);
        return counts;
      }, nodeId);
    } finally {
      await browser.close();
    }
  };

  it("costs a layer drawn by hand nothing more", async () => {
    const cost = await counted("drawn");
    expect(cost.matches).toBeLessThanOrEqual(BASELINE_COST.drawn.matches);
    expect(cost.queries).toBe(BASELINE_COST.drawn.queries);
  });

  it("costs a class-styled layer with one override one in-frame count", async () => {
    const cost = await counted("one-override");
    expect(cost.matches).toBeLessThanOrEqual(BASELINE_COST.oneOverride.matches);
    expect(cost.queries).toBe(BASELINE_COST.oneOverride.queries + 1);
  });

  it("costs a themed class one match per theme rule naming its classes", async () => {
    const cost = await counted("card");
    expect(cost.matches).toBeLessThanOrEqual(BASELINE_COST.card.matches + 1);
    expect(cost.queries).toBe(BASELINE_COST.card.queries);
  });
});

describe("authored style wire validation", () => {
  it("accepts bounded origins, replacements and theme values", () => {
    const replaced = { origin: "frame", selector: ".btn", value: "var(--radius-md)", tokens: [{ name: "--radius-md", value: "6px" }], others: 3 };
    expect(
      isDesignRuntimeAuthoredStyles({
        "border-radius": { origin: "inline", scope: "inline", value: "8px", declared: "border-radius", replaced },
        gap: { origin: "frame", component: "chip", subjectClasses: ["chip"], value: "4px", themeValues: { dark: "2px" } },
      }),
    ).toBe(true);
    const bad = (style: Record<string, unknown>) =>
      isDesignRuntimeAuthoredStyles({ color: { origin: "frame", value: "red", ...style } });
    expect(bad({ component: "x".repeat(65) })).toBe(false);
    expect(bad({ subjectClasses: Array.from({ length: 17 }, (_, index) => `c${index}`) })).toBe(false);
    expect(bad({ subjectClasses: [""] })).toBe(false);
    expect(bad({ declared: "Bad Name" })).toBe(false);
    expect(bad({ replaced: { ...replaced, value: "x".repeat(1025) } })).toBe(false);
    expect(bad({ replaced: { ...replaced, others: -1 } })).toBe(false);
    expect(bad({ replaced: { ...replaced, others: 10000 } })).toBe(false);
    expect(bad({ replaced: { ...replaced, origin: "cdn" } })).toBe(false);
    expect(bad({ themeValues: { "Not A Theme": "red" } })).toBe(false);
    expect(bad({ themeValues: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`t${index}`, "red"])) })).toBe(false);
  });

  it("accepts bounded provenance and refuses oversized or unknown fields", () => {
    expect(
      isDesignRuntimeAuthoredStyles({
        color: { origin: "linked", file: "tokens.css", value: "var(--fg1)", tokens: [{ name: "--fg1", value: "black" }] },
      }),
    ).toBe(true);
    expect(isDesignRuntimeAuthoredStyles({ color: { origin: "cdn", value: "red" } })).toBe(false);
    expect(isDesignRuntimeAuthoredStyles({ color: { origin: "frame", value: "x".repeat(1025) } })).toBe(false);
    expect(isDesignRuntimeAuthoredStyles({ "Bad Name": { origin: "frame", value: "red" } })).toBe(false);
    expect(
      isDesignRuntimeAuthoredStyles({
        color: { origin: "frame", value: "red", tokens: Array.from({ length: 9 }, (_, index) => ({ name: `--t${index}`, value: "1" })) },
      }),
    ).toBe(false);
    expect(
      isDesignRuntimeAuthoredStyles(
        Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`--p${index}`, { origin: "frame", value: "1" }])),
      ),
    ).toBe(false);
  });
});
