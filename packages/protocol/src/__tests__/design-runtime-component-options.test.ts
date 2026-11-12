import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { DESIGN_RUNTIME_SOURCE, isDesignRuntimeComponentOptionsPreview } from "../design-runtime";

type RuntimeWindow = Window & {
  __zerosDesignSourceVersion: string;
  runtimeRequest: (method: string, args: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;
  computedReads: number;
};

const HEAD = `<style data-zeros-options>:root { --zd-width: 300px; --zd-accent: rgb(1, 2, 3); }</style>
<style>.c { width: var(--zd-width); color: var(--zd-accent); }</style>`;
const BODY = `<div data-oid="c" class="c">Composer</div>`;

async function fixture(browser: Browser, body = BODY, features = ["previewComponentOptions"]): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluate(
    async ({ source, head, body, features }) => {
      document.head.innerHTML = head;
      document.body.innerHTML = body;
      const runtimeWindow = window as unknown as RuntimeWindow;
      runtimeWindow.__zerosDesignSourceVersion = "a".repeat(24);
      runtimeWindow.computedReads = 0;
      const read = window.getComputedStyle.bind(window);
      window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
        runtimeWindow.computedReads += 1;
        return read(element, pseudo);
      }) as typeof window.getComputedStyle;
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
        sourceVersion: runtimeWindow.__zerosDesignSourceVersion, features }, "*", [channel.port2]);
      await ready;
    },
    { source: DESIGN_RUNTIME_SOURCE, head: HEAD, body, features },
  );
  return page;
}

const request = (page: Page, method: string, args: Record<string, unknown> = {}) =>
  page.evaluate(({ method, args }) => (window as unknown as RuntimeWindow).runtimeRequest(method, args), { method, args });


const width = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector(".c")!).width);
const color = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector(".c")!).color);
const runtimeStyles = (page: Page) => page.evaluate(() => document.querySelectorAll("style[data-zeros-runtime-options]").length);

describe("previewing a component's options", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("sets the custom properties over the frame's own values in one runtime-owned style, and clears them", async () => {
    const page = await fixture(browser);
    try {
      expect(await width(page)).toBe("300px");
      const reply = await request(page, "previewComponentOptions", { properties: { "--zd-width": "420px", "--zd-accent": "var(--zd-none, rgb(4, 5, 6))" } });
      expect(reply.error).toBeUndefined();
      expect(isDesignRuntimeComponentOptionsPreview(reply.result)).toBe(true);
      expect(await width(page)).toBe("420px");
      await request(page, "previewComponentOptions", { properties: { "--zd-width": "500px" } });
      expect(await width(page)).toBe("500px");
      // The latest preview replaces the last; the accent goes back.
      expect(await color(page)).toBe("rgb(1, 2, 3)");
      expect(await runtimeStyles(page)).toBe(1);
      await request(page, "previewComponentOptions", { clear: true });
      expect(await width(page)).toBe("300px");
      expect(await runtimeStyles(page)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("refuses anything that is not a component custom property with a plain value", async () => {
    const page = await fixture(browser);
    try {
      for (const properties of [
        { width: "1px" }, { "--other": "1px" }, { "--zd-Width": "1px" }, { "--zd-w": "1px; color: red" }, { "--zd-w": "1px }" },
        { "--zd-w": "url(x)" }, { "--zd-w": "/* x */" }, { "--zd-w": "a\nb" }, { "--zd-w": "x".repeat(600) },
        Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`--zd-p${index}`, "1"])),
      ]) {
        expect((await request(page, "previewComponentOptions", { properties })).error, JSON.stringify(properties).slice(0, 40)).toBeDefined();
      }
      expect(await runtimeStyles(page)).toBe(0);
      expect(await width(page)).toBe("300px");
    } finally {
      await page.close();
    }
  });

  it("answers only a host that asked for it", async () => {
    const page = await fixture(browser, BODY, []);
    try {
      expect((await request(page, "previewComponentOptions", { properties: { "--zd-width": "1px" } })).error).toBeDefined();
    } finally {
      await page.close();
    }
  });

  it("refuses malformed replies", () => {
    expect(isDesignRuntimeComponentOptionsPreview({ sourceVersion: "a".repeat(24), applied: 2 })).toBe(true);
    expect(isDesignRuntimeComponentOptionsPreview({ sourceVersion: "a".repeat(24), applied: -1 })).toBe(false);
    expect(isDesignRuntimeComponentOptionsPreview({ applied: 1 })).toBe(false);
  });
});
