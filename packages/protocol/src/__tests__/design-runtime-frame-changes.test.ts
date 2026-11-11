import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  DESIGN_RUNTIME_SOURCE,
  isDesignRuntimeFrameChanges,
  type DesignRuntimeFrameChanges,
} from "../design-runtime";

type RuntimeWindow = Window & {
  __zerosDesignSourceVersion: string;
  runtimeRequest: (method: string, args: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;
  computedReads: number;
};

// Values set on layers over what a class or a rule for them gave, one
// set over nothing, a class value alone, and a rule written for one layer.
const HEAD = `<style>
  .btn { border-radius: 6px; padding: 8px; background-color: rgb(1, 1, 1); }
  .tag { color: rgb(2, 2, 2); }
  .row { display: flex; gap: 2px; }
  [data-oid="own"] { gap: 4px; }
  .forced { border-radius: 2px !important; }
</style>`;
const BODY = `
<div data-oid="a" class="btn" style="border-radius: 8px; background-color: rgb(3, 3, 3)">A</div>
<div data-oid="drawn" style="width: 10px">Drawn</div>
<span data-oid="t" class="tag" style="color: red">T</span>
<div data-oid="own" class="row">Row</div>
<div data-oid="plain" class="btn">Plain</div>
<div data-oid="loses" class="forced" style="border-radius: 9px">Loses</div>`;

async function fixture(browser: Browser, body = BODY, features = ["getFrameChanges"]): Promise<Page> {
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
const changes = async (page: Page, args: Record<string, unknown> = {}) =>
  (await request(page, "getFrameChanges", args)).result as DesignRuntimeFrameChanges;

describe("a frame's changes made by hand", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await fixture(browser);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("lists each value a layer sets over one a class or rule gave it, in one reply", async () => {
    const frame = await changes(page);
    expect(isDesignRuntimeFrameChanges(frame)).toBe(true);
    expect(frame.sourceVersion).toBe("a".repeat(24));
    expect(frame.truncated).toBe(false);
    const byLayer = Object.fromEntries(frame.layers.map((layer) => [layer.oid, layer.changes.map((change) => change.property)]));
    expect(byLayer).toEqual({ a: ["border-radius", "background-color"], t: ["color"], own: ["gap"] });
    const radius = frame.layers.find((layer) => layer.oid === "a")!.changes[0]!;
    expect(radius).toMatchObject({ property: "border-radius", value: "8px", replaced: { value: "6px", selector: ".btn", subjectClasses: ["btn"] } });
    expect(frame.layers.find((layer) => layer.oid === "own")!.changes[0]).toMatchObject({ value: "4px", replaced: { value: "2px", selector: ".row" } });
    // A value set over nothing is not a change from a source, and a value
    // !important beats is not the layer's.
    expect(byLayer.drawn).toBeUndefined();
    expect(byLayer.loses).toBeUndefined();
    expect(frame.layers.find((layer) => layer.oid === "t")!.name).toBe("T");
  });

  it("reads no computed style for it", async () => {
    await page.evaluate(() => { (window as unknown as RuntimeWindow).computedReads = 0; });
    await changes(page);
    expect(await page.evaluate(() => (window as unknown as RuntimeWindow).computedReads)).toBe(0);
  });

  it("says where a followed value comes from now", async () => {
    const frame = await changes(page, { follow: [
      { oid: "a", property: "border-radius" },
      { oid: "plain", property: "border-radius" },
      { oid: "drawn", property: "color" },
      { oid: "missing", property: "color" },
    ] });
    expect(frame.follow).toEqual([
      { oid: "a", property: "border-radius", own: true, value: "8px" },
      { oid: "plain", property: "border-radius", own: false, value: "6px" },
      { oid: "drawn", property: "color", own: false, value: null },
    ]);
    expect(isDesignRuntimeFrameChanges(frame)).toBe(true);
  });

  it("examines a bounded number of layers and says so", async () => {
    const many = Array.from({ length: 300 }, (_, index) => `<div data-oid="l${index}" class="btn" style="padding: 1px">L</div>`).join("");
    const scoped = await fixture(browser, many);
    try {
      const frame = await changes(scoped);
      expect(frame.truncated).toBe(true);
      expect(frame.examined).toBe(200);
      expect(frame.layers).toHaveLength(200);
      expect(isDesignRuntimeFrameChanges(frame)).toBe(true);
    } finally {
      await scoped.close();
    }
  });

  it("stops examining layers once its time budget is spent, says so, and still answers what it was asked to follow", async () => {
    const many = Array.from({ length: 300 }, (_, index) => `<div data-oid="l${index}" class="btn" style="padding: 1px">L</div>`).join("");
    const scoped = await fixture(browser, many);
    try {
      // Each clock read moves 5 ms, so the budget runs out after a few layers.
      await scoped.evaluate(() => {
        let now = 0;
        performance.now = () => (now += 5);
      });
      const frame = await changes(scoped, { follow: [{ oid: "l299", property: "padding-top" }] });
      expect(frame.truncated).toBe(true);
      expect(frame.examined).toBeGreaterThan(0);
      expect(frame.examined).toBeLessThan(10);
      expect(frame.layers).toHaveLength(frame.examined);
      expect(frame.follow).toEqual([{ oid: "l299", property: "padding-top", own: true, value: "1px" }]);
      expect(isDesignRuntimeFrameChanges(frame)).toBe(true);
    } finally {
      await scoped.close();
    }
  });

  it("answers only a host that asked for it", async () => {
    const scoped = await fixture(browser, BODY, []);
    try {
      expect((await request(scoped, "getFrameChanges")).error).toBeDefined();
    } finally {
      await scoped.close();
    }
  });

  it("refuses malformed replies", () => {
    const valid: DesignRuntimeFrameChanges = { sourceVersion: "a".repeat(24), examined: 1, truncated: false, layers: [] };
    expect(isDesignRuntimeFrameChanges(valid)).toBe(true);
    expect(isDesignRuntimeFrameChanges({ ...valid, layers: [{ oid: "a", name: "A", changes: [{ property: 4 }] }] })).toBe(false);
    expect(isDesignRuntimeFrameChanges({ ...valid, examined: -1 })).toBe(false);
    expect(isDesignRuntimeFrameChanges({ ...valid, follow: [{ oid: "a", property: "gap", own: "yes", value: null }] })).toBe(false);
  });
});
