import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  DESIGN_RUNTIME_SOURCE,
  isDesignRuntimeNodeDetails,
  type DesignRuntimeNodeDetails,
} from "../design-runtime";

type RuntimeWindow = Window & {
  __zerosDesignSourceVersion: string;
  runtimeRequest: (method: string, args: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;
};

// A plain value that differs by theme, one that reads a token, and layers
// hidden by themselves or by an ancestor.
const HEAD = `<style>
  :root { --surface: rgb(250, 250, 250); }
  [data-zd-theme="dark"] { --surface: rgb(20, 20, 20); }
  .card { background-color: rgb(255, 255, 255); color: var(--surface); }
  [data-zd-theme="dark"] .card { background-color: rgb(28, 28, 28); }
</style>`;
const BODY = `
<div data-oid="card" class="card">Card</div>
<div data-oid="hidden-self" style="display: none">Hidden</div>
<div data-oid="hidden-attribute" hidden>Hidden</div>
<div data-oid="hidden-parent" style="visibility: hidden"><span data-oid="hidden-child">Child</span></div>
<div data-oid="shown">Shown</div>`;

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
      const pending = new Map<string, (value: { result?: unknown; error?: unknown }) => void>();
      let count = 0;
      const ready = new Promise<void>((resolve) => {
        channel.port1.onmessage = (event) => {
          if (event.data.type === "event" && event.data.event === "ready") resolve();
          if (event.data.type === "response") {
            pending.get(event.data.requestId)?.({ result: event.data.result, error: event.data.error });
            pending.delete(event.data.requestId);
          }
        };
      });
      runtimeWindow.runtimeRequest = (method, args) =>
        new Promise((resolve) => {
          const requestId = String(++count);
          pending.set(requestId, resolve);
          channel.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request",
            sourceVersion: runtimeWindow.__zerosDesignSourceVersion, requestId, method, args });
        });
      channel.port1.start();
      window.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake",
        sourceVersion: runtimeWindow.__zerosDesignSourceVersion }, "*", [channel.port2]);
      await ready;
    },
    { source: DESIGN_RUNTIME_SOURCE, head: HEAD, body: BODY },
  );
  return page;
}

const request = (page: Page, method: string, args: Record<string, unknown>) =>
  page.evaluate(({ method, args }) => (window as unknown as RuntimeWindow).runtimeRequest(method, args), { method, args });
const details = async (page: Page, nodeId: string) =>
  (await request(page, "getNodeDetails", { nodeId })).result as DesignRuntimeNodeDetails;

describe("what a field's marks read from a layer's details", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await fixture(browser);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("says whether a hidden layer is hidden by itself or by a layer around it", async () => {
    for (const [nodeId, hiddenBy] of [
      ["hidden-self", "self"],
      ["hidden-attribute", "self"],
      ["hidden-parent", "self"],
      ["hidden-child", "ancestor"],
    ] as const) {
      const node = await details(page, nodeId);
      expect(node.hiddenBy, nodeId).toBe(hiddenBy);
      expect(node.visible, nodeId).toBe(false);
      expect(isDesignRuntimeNodeDetails(node)).toBe(true);
    }
    const shown = await details(page, "shown");
    expect(shown.visible).toBe(true);
    expect("hiddenBy" in shown).toBe(false);
    expect(isDesignRuntimeNodeDetails({ ...shown, hiddenBy: "parent" })).toBe(false);
    expect(isDesignRuntimeNodeDetails({ ...shown, visible: false, hiddenBy: "ancestor" })).toBe(true);
  });

  it("lists the default theme's value once the host names the default theme", async () => {
    // Before any theme is applied there is no other theme to name.
    expect((await details(page, "card")).authoredStyles?.["background-color"]?.themeValues).toEqual({ dark: "rgb(28, 28, 28)" });
    await request(page, "setTheme", { theme: "dark" });
    // Without the default theme's name the layer has nothing to compare with.
    expect((await details(page, "card")).authoredStyles?.["background-color"]?.themeValues).toBeUndefined();
    await request(page, "setTheme", { theme: "dark", baseTheme: "light" });
    const dark = await details(page, "card");
    expect(dark.authoredStyles?.["background-color"]?.themeValues).toEqual({ light: "rgb(255, 255, 255)" });
    // A token differs by theme by itself: no theme values.
    expect(dark.authoredStyles?.color?.themeValues).toBeUndefined();
    expect(isDesignRuntimeNodeDetails(dark)).toBe(true);
    await request(page, "setTheme", { theme: "light", baseTheme: "light" });
    expect((await details(page, "card")).authoredStyles?.["background-color"]?.themeValues).toEqual({ dark: "rgb(28, 28, 28)" });
  });

  it("refuses a default theme that is not a portable theme name", async () => {
    expect((await request(page, "setTheme", { theme: "light", baseTheme: "Not a name" })).error).toBeDefined();
    expect((await request(page, "setTheme", { theme: "light", baseTheme: 7 })).error).toBeDefined();
    expect((await request(page, "setTheme", { theme: "light", baseTheme: null })).error).toBeUndefined();
  });
});
