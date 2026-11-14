import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

type RuntimeWindow = Window & {
  __zerosDesignSourceVersion: string;
  runtimeRequest: (method: string, args: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;
};

const BODY = `<div data-oid="root" style="display: flex; position: relative">
<div data-oid="flowing">in flow</div>
<div data-oid="placed" style="position: absolute; left: 4px; top: 4px">placed</div>
<div data-oid="free" style="display: block; position: relative"><span data-oid="loose" style="position: absolute">loose</span></div>
</div>`;

async function fixture(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluate(
    async ({ source, body }) => {
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
        sourceVersion: runtimeWindow.__zerosDesignSourceVersion, features: [] }, "*", [channel.port2]);
      await ready;
    },
    { source: DESIGN_RUNTIME_SOURCE, body: BODY },
  );
  return page;
}

interface LayerTree { oid: string; absolute?: true; children: LayerTree[] }
const flags = (nodes: LayerTree[]): Record<string, boolean> =>
  Object.assign({}, ...nodes.map((node) => ({ [node.oid]: node.absolute === true, ...flags(node.children) })));

describe("the Layers tree marks absolute layers of an auto layout", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await fixture(browser);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("flags only a layer taken out of its parent's auto layout", async () => {
    const reply = await page.evaluate(() => (window as unknown as RuntimeWindow).runtimeRequest("getSnapshot", {}));
    const tree = (reply.result as { tree: LayerTree[] }).tree;
    expect(flags(tree)).toEqual({ root: false, flowing: false, placed: true, free: false, loose: false });
  });
});
