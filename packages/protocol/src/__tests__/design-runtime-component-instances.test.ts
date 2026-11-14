import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  DESIGN_RUNTIME_SOURCE,
  designComponentPartNodeId,
  designComponentPartOf,
  isDesignRuntimeComponentOptionsPreview,
} from "../design-runtime";

type RuntimeWindow = Window & {
  __zerosDesignSourceVersion: string;
  runtimeRequest: (method: string, args: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;
};

const HEAD = `<style data-zeros-options>:where([data-zd-instance="1"]) { --zd-width: 300px; }
:where([data-zd-instance="2"]) { --zd-width: 200px; }
:where([data-zd-instance="3"]) { --zd-width: 50px; }</style>
<style>body { margin: 0; } .c { display: block; width: var(--zd-width); } zd-chat, zd-inner { display: block; }
button, span, b { display: inline-block; width: 40px; height: 20px; }</style>`;
const BODY = `<div data-oid="root">
<zd-chat data-oid="i1" data-zd-instance="1" width="300"><div class="c" data-zd-part="c"><button data-zd-part="send">S</button><span data-zd-part="chip">A</span><span data-zd-part="chip#1">B</span><zd-inner data-zd-part="inner" data-zd-instance="3"><b class="c" data-zd-part="send">x</b></zd-inner></div></zd-chat>
<zd-chat data-oid="i2" data-zd-instance="2"><div class="c" data-zd-part="c">two <em data-oid="slotted">here</em></div></zd-chat>
<zd-old data-oid="i3" data-zd-instance="4"><section><i data-oid="kept">k</i></section></zd-old>
<ul data-oid="list"><li data-oid="item">1</li><li data-zd-copy="item#1">2</li></ul>
<p data-oid="plain">plain</p>
</div>`;

const ALL = ["previewComponentOptions", "previewComponentInstanceOptions", "getComponentPartAtLoc"];

async function fixture(browser: Browser, features = ALL): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluate(
    async ({ source, head, body, features }) => {
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
        sourceVersion: runtimeWindow.__zerosDesignSourceVersion, features }, "*", [channel.port2]);
      await ready;
    },
    { source: DESIGN_RUNTIME_SOURCE, head: HEAD, body: BODY, features },
  );
  return page;
}

const request = (page: Page, method: string, args: Record<string, unknown> = {}) =>
  page.evaluate(({ method, args }) => (window as unknown as RuntimeWindow).runtimeRequest(method, args), { method, args });
const widthOf = (page: Page, selector: string) =>
  page.evaluate((selector) => getComputedStyle(document.querySelector(selector)!).width, selector);
const centre = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, selector);
const oidOf = (reply: { result?: unknown }) => (reply.result as { oid?: string } | null)?.oid ?? null;
interface LayerTree { oid: string; children: LayerTree[] }
const outline = (node: LayerTree): Record<string, unknown[]> => ({ [node.oid]: node.children.map(outline) });

describe("component instances in the frame runtime", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("previews one instance's options over its generated values, leaving the others alone, and clears them", async () => {
    const page = await fixture(browser);
    try {
      expect(await widthOf(page, '[data-zd-instance="1"] > .c')).toBe("300px");
      const reply = await request(page, "previewComponentInstanceOptions", { target: "i1", properties: { "--zd-width": "420px" } });
      expect(reply.error).toBeUndefined();
      expect(isDesignRuntimeComponentOptionsPreview(reply.result)).toBe(true);
      expect(await widthOf(page, '[data-zd-instance="1"] > .c')).toBe("420px");
      expect(await widthOf(page, '[data-zd-instance="2"] > .c')).toBe("200px");
      // An inner instance keeps its own value: its own rule sets it.
      expect(await widthOf(page, '[data-zd-instance="3"] > .c')).toBe("50px");
      await request(page, "previewComponentInstanceOptions", { target: "i1", properties: { "--zd-width": "500px" } });
      expect(await widthOf(page, '[data-zd-instance="1"] > .c')).toBe("500px");
      expect(await page.evaluate(() => document.querySelectorAll("style[data-zeros-runtime-instance-options]").length)).toBe(1);
      await request(page, "previewComponentInstanceOptions", { target: "i1", clear: true });
      expect(await widthOf(page, '[data-zd-instance="1"] > .c')).toBe("300px");
      expect(await page.evaluate(() => document.querySelectorAll("style[data-zeros-runtime-instance-options]").length)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("refuses a target that is not one instance's host named as strictly as its values", async () => {
    const page = await fixture(browser);
    try {
      for (const target of ["plain", "missing", "", "i1\"]", "i1 i2", "i1,[data-oid]", "x".repeat(200), 4, null]) {
        const reply = await request(page, "previewComponentInstanceOptions", { target, properties: { "--zd-width": "1px" } });
        expect(reply.error, String(target)).toBeDefined();
      }
      for (const properties of [{ width: "1px" }, { "--zd-w": "1px; color: red" }, { "--zd-w": "url(x)" }])
        expect((await request(page, "previewComponentInstanceOptions", { target: "i1", properties })).error).toBeDefined();
      expect(await widthOf(page, '[data-zd-instance="1"] > .c')).toBe("300px");
    } finally {
      await page.close();
    }
  });

  it("finds the part under a point inside an instance, by its part and copy, and reads it like a layer", async () => {
    const page = await fixture(browser);
    try {
      const send = await centre(page, '[data-zd-part="send"]');
      const reply = await request(page, "getComponentPartAtLoc", { ...send, hostNodeId: "i1" });
      expect(oidOf(reply)).toBe(designComponentPartNodeId("i1", "send"));
      const copy = await centre(page, '[data-zd-part="chip#1"]');
      const copied = oidOf(await request(page, "getComponentPartAtLoc", { ...copy, hostNodeId: "i1" }));
      expect(copied).toBe(designComponentPartNodeId("i1", "chip#1"));
      expect(designComponentPartOf(copied!)).toEqual({ host: "i1", part: "chip#1" });
      // A nested instance is one part of the outer one; its insides are its own.
      const inner = await centre(page, "b");
      expect(oidOf(await request(page, "getComponentPartAtLoc", { ...inner, hostNodeId: "i1" }))).toBe(designComponentPartNodeId("i1", "inner"));
      // Outside the host there is no part.
      const outside = await centre(page, '[data-oid="plain"]');
      expect((await request(page, "getComponentPartAtLoc", { ...outside, hostNodeId: "i1" })).result).toBeNull();
      // A part's id reads its details, as a layer's does.
      const details = await request(page, "getNodeDetails", { nodeId: designComponentPartNodeId("i1", "chip#1") });
      expect(details.error).toBeUndefined();
      expect((details.result as { text: string }).text).toBe("B");
      expect((await request(page, "getNodeDetails", { nodeId: designComponentPartNodeId("i2", "send") })).error).toBeDefined();
    } finally {
      await page.close();
    }
  });

  it("lists an instance's parts under it in Layers, with the layers the frame slots into them, and selects a repeated copy's source", async () => {
    const page = await fixture(browser);
    try {
      const snapshot = (await request(page, "getSnapshot")).result as { tree: LayerTree[] };
      const hosts = snapshot.tree[0]!.children;
      const part = (host: string, id: string) => designComponentPartNodeId(host, id);
      expect(outline(hosts.find((child) => child.oid === "i1")!)).toEqual({ i1: [{ [part("i1", "c")]: [
        { [part("i1", "send")]: [] }, { [part("i1", "chip")]: [] }, { [part("i1", "chip#1")]: [] },
        // A nested instance is one part; its insides are its own.
        { [part("i1", "inner")]: [] },
      ] }] });
      expect(outline(hosts.find((child) => child.oid === "i2")!)).toEqual({ i2: [{ [part("i2", "c")]: [{ slotted: [] }] }] });
      // A definition without data-zid has no parts; the frame's own layers in it still show.
      expect(outline(hosts.find((child) => child.oid === "i3")!)).toEqual({ i3: [{ kept: [] }] });
      const copy = await centre(page, '[data-zd-copy="item#1"]');
      expect(oidOf(await request(page, "getElementAtLoc", { ...copy, mode: "deepest" }))).toBe("item");
    } finally {
      await page.close();
    }
  });

  it("answers only a host that asked, and resolves no part id or copy for one that did not", async () => {
    const page = await fixture(browser, ["previewComponentOptions"]);
    try {
      expect((await request(page, "previewComponentInstanceOptions", { target: "i1", properties: { "--zd-width": "1px" } })).error).toBeDefined();
      const send = await centre(page, '[data-zd-part="send"]');
      expect((await request(page, "getComponentPartAtLoc", { ...send, hostNodeId: "i1" })).error).toBeDefined();
      expect((await request(page, "getNodeDetails", { nodeId: designComponentPartNodeId("i1", "send") })).error).toBeDefined();
      const copy = await centre(page, '[data-zd-copy="item#1"]');
      expect(oidOf(await request(page, "getElementAtLoc", { ...copy, mode: "deepest" }))).toBe("list");
      const snapshot = (await request(page, "getSnapshot")).result as { tree: LayerTree[] };
      expect(outline(snapshot.tree[0]!.children.find((child) => child.oid === "i1")!)).toEqual({ i1: [] });
    } finally {
      await page.close();
    }
  });

  it("names a part unambiguously", () => {
    const id = designComponentPartNodeId("a:b", "c#1.2");
    expect(id.startsWith("::zeros-part:")).toBe(true);
    expect(designComponentPartOf(id)).toEqual({ host: "a:b", part: "c#1.2" });
    expect(designComponentPartOf("cc-send")).toBeNull();
    expect(designComponentPartOf("::zeros-document-body")).toBeNull();
    expect(designComponentPartOf("::zeros-part:only")).toBeNull();
  });
});
