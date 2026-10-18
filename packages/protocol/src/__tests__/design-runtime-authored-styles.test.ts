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

async function fixture(browser: Browser): Promise<Page> {
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
    { source: DESIGN_RUNTIME_SOURCE, head: HEAD, body: BODY },
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

  it("chooses by specificity before order, and !important before specificity", async () => {
    const title = await details(page, "title");
    expect(title.authoredStyles?.color).toEqual({
      origin: "frame",
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
    expect(card.authoredStyles?.color).toEqual({ origin: "inline", value: "green" });
  });

  it("omits a shorthand partly overridden by a longhand, and :where() has no specificity", async () => {
    const mixed = await details(page, "mixed");
    expect(mixed.authoredStyles?.padding).toBeUndefined();
    expect(mixed.authoredStyles?.["padding-top"]).toMatchObject({ value: "4px" });
    expect(mixed.authoredStyles?.gap).toMatchObject({ origin: "frame", value: "8px" });
  });
});

describe("authored style wire validation", () => {
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
