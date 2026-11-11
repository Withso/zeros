import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  DESIGN_RUNTIME_SOURCE,
  isDesignRuntimeNodeDetails,
  type DesignRuntimeNodeDetails,
} from "../design-runtime";

type RuntimeWindow = Window & {
  __zerosDesignSourceVersion: string;
  detailsRequest: (nodeId: string) => Promise<DesignRuntimeNodeDetails>;
};

const BODY = `
<div data-oid="parent" style="position: relative; width: 400px; height: 300px; padding: 10px 20px; border: 2px solid; box-sizing: content-box">
  <div data-oid="flow" style="width: 50px; height: 20px">Flow</div>
  <div data-oid="absolute" style="position: absolute; left: 0; top: 0; width: 10px; height: 10px">Abs</div>
</div>
<div data-oid="grid" style="display: grid; grid-template-columns: 100px 300px; width: 400px">
  <div data-oid="cell">Cell</div>
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
          channel.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request",
            sourceVersion: runtimeWindow.__zerosDesignSourceVersion, requestId, method: "getNodeDetails", args: { nodeId } });
        });
      channel.port1.start();
      window.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake",
        sourceVersion: runtimeWindow.__zerosDesignSourceVersion }, "*", [channel.port2]);
      await ready;
    },
    { source: DESIGN_RUNTIME_SOURCE, body: BODY },
  );
  return page;
}

const details = (page: Page, nodeId: string) =>
  page.evaluate((nodeId) => (window as unknown as RuntimeWindow).detailsRequest(nodeId), nodeId);

describe("what a percentage resolves against", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await fixture(browser);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("is the parent's content box for a layer in flow, width only", async () => {
    const flow = await details(page, "flow");
    expect(flow.layout?.percentBasis).toEqual({ width: 400 });
    expect(isDesignRuntimeNodeDetails(flow)).toBe(true);
  });

  it("is the positioned parent's padding box for an absolute layer, both axes", async () => {
    expect((await details(page, "absolute")).layout?.percentBasis).toEqual({ width: 440, height: 320 });
  });

  it("is not reported in a grid, where a percentage resolves against its area", async () => {
    expect((await details(page, "cell")).layout?.percentBasis).toBeUndefined();
  });

  it("costs no style read beyond what the layout already makes", async () => {
    const reads = await page.evaluate(async () => {
      const runtime = window as unknown as RuntimeWindow;
      await runtime.detailsRequest("flow");
      const original = window.getComputedStyle;
      let count = 0;
      window.getComputedStyle = function (this: Window, ...args: Parameters<typeof getComputedStyle>) {
        count += 1;
        return original.apply(this, args);
      } as typeof getComputedStyle;
      try {
        await runtime.detailsRequest("absolute");
      } finally {
        window.getComputedStyle = original;
      }
      return count;
    });
    // Measured on the runtime before percentBasis existed.
    expect(reads).toBeLessThanOrEqual(BASELINE_STYLE_READS);
  });
});

const BASELINE_STYLE_READS = 28;
