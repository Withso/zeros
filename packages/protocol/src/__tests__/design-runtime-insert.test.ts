import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

declare global {
  interface Window {
    layoutRequest: (
      method: string,
      args: Record<string, unknown>,
    ) => Promise<any>;
  }
}

let browser: Browser;
let page: Page;
beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.evaluate(async (source) => {
    document.head.innerHTML = "<style>body{margin:0}</style>";
    document.body.innerHTML = `<main data-oid="root" style="display:block;width:600px;height:400px">\n  <div data-oid="a" style="width:300px;height:200px"></div>\n</main>`;
    let sourceVersion = "b".repeat(24);
    Object.assign(window, { __zerosDesignSourceVersion: sourceVersion });
    const channel = new MessageChannel();
    let sequence = 0;
    const pending = new Map<
      string,
      { resolve: (value: any) => void; reject: (error: Error) => void }
    >();
    const ready = new Promise<void>((resolve) => {
      channel.port1.onmessage = ({ data }) => {
        if (data.type === "event" && data.event === "ready") resolve();
        if (data.type !== "response") return;
        const task = pending.get(data.requestId);
        pending.delete(data.requestId);
        if (data.ok) {
          if (data.result?.sourceVersion)
            sourceVersion = data.result.sourceVersion;
          task?.resolve(data.result);
        } else task?.reject(new Error(data.error?.message ?? "Runtime failed"));
      };
    });
    window.layoutRequest = (method, args) =>
      new Promise((resolve, reject) => {
        const requestId = String(++sequence);
        pending.set(requestId, { resolve, reject });
        channel.port1.postMessage({
          protocol: "zeros-design-runtime",
          version: 2,
          type: "request",
          sourceVersion,
          requestId,
          method,
          args,
        });
      });
    const script = document.createElement("script");
    script.textContent = source;
    document.head.appendChild(script);
    window.postMessage(
      {
        protocol: "zeros-design-runtime",
        version: 2,
        type: "handshake",
        sourceVersion,
        features: ["previewInsert", "clearPreviewInserts"],
      },
      "*",
      [channel.port2],
    );
    await ready;
  }, DESIGN_RUNTIME_SOURCE);
});
afterEach(async () => {
  await browser?.close();
});

const CHILD_STYLE = "display:block;position:absolute;left:40px;top:30px;width:120px;height:90px;box-sizing:border-box;flex-shrink:0;background-color:#ffffff;opacity:1;";
const insert = { nodeId: "frame-child", parentId: "root", beforeId: null, tag: "div", style: CHILD_STYLE };
const parentStyles = [{ nodeId: "root", styles: { position: "relative" } }];

describe("runtime child insertion", () => {
  it("paints a drawn child immediately and reports its layer and details", async () => {
    const result = await page.evaluate(async ({ insert, parentStyles }) => {
      let mutations = 0;
      window.addEventListener("message", () => {}, { once: true });
      const preview = await window.layoutRequest("previewInsert", { inserts: [insert], updates: parentStyles });
      const element = document.querySelector('[data-oid="frame-child"]') as HTMLElement | null;
      await new Promise((resolve) => setTimeout(resolve, 700));
      return {
        connected: !!element && element.parentElement?.getAttribute("data-oid") === "root" && element === element.parentElement.lastElementChild,
        styleAttribute: element?.getAttribute("style"),
        parentPosition: getComputedStyle(document.querySelector('[data-oid="root"]')!).position,
        tree: preview.snapshot.tree[0].children.map((node: { oid: string }) => node.oid),
        details: preview.details.map((details: { oid: string; rect: { x: number; y: number; width: number; height: number }; sourceVersion: string }) =>
          ({ oid: details.oid, rect: details.rect, sourceVersion: details.sourceVersion })),
        mutations,
      };
    }, { insert, parentStyles });
    expect(result.connected).toBe(true);
    expect(result.styleAttribute).toBe(CHILD_STYLE);
    expect(result.parentPosition).toBe("relative");
    expect(result.tree).toEqual(["a", "frame-child"]);
    expect(result.details).toEqual([{ oid: "frame-child", rect: { x: 40, y: 30, width: 120, height: 90 }, sourceVersion: "b".repeat(24) }]);
  });

  it("removes a cancelled preview and restores the parent exactly", async () => {
    const result = await page.evaluate(async ({ insert, parentStyles }) => {
      const root = document.querySelector('[data-oid="root"]') as HTMLElement;
      const before = { children: root.childNodes.length, css: root.style.cssText };
      await window.layoutRequest("previewInsert", { inserts: [insert], updates: parentStyles });
      const cleared = await window.layoutRequest("clearPreviewInserts", {});
      return {
        same: root.childNodes.length === before.children && root.style.cssText === before.css &&
          !document.querySelector('[data-oid="frame-child"]'),
        tree: cleared.snapshot.tree[0].children.map((node: { oid: string }) => node.oid),
      };
    }, { insert, parentStyles });
    expect(result).toEqual({ same: true, tree: ["a"] });
  });

  it("adopts the saved generation in place, keeping the previewed element", async () => {
    const result = await page.evaluate(async ({ insert, parentStyles }) => {
      await window.layoutRequest("previewInsert", { inserts: [insert], updates: parentStyles });
      const previewed = document.querySelector('[data-oid="frame-child"]');
      const committed = await window.layoutRequest("commitStyles", {
        updates: parentStyles,
        patch: { inserts: [insert] },
        nextSourceVersion: "c".repeat(24),
      });
      const element = document.querySelector('[data-oid="frame-child"]');
      return {
        same: previewed === element,
        count: document.querySelectorAll('[data-oid="frame-child"]').length,
        sourceVersion: committed.sourceVersion,
        treeUnchanged: committed.treeUnchanged,
        tree: committed.snapshot.tree[0].children.map((node: { oid: string }) => node.oid),
        rootInline: (document.querySelector('[data-oid="root"]') as HTMLElement).style.position,
        global: (window as unknown as { __zerosDesignSourceVersion: string }).__zerosDesignSourceVersion,
      };
    }, { insert, parentStyles });
    expect(result).toEqual({ same: true, count: 1, sourceVersion: "c".repeat(24), treeUnchanged: false,
      tree: ["a", "frame-child"], rootInline: "relative", global: "c".repeat(24) });
  });

  it("creates an insert that was never previewed and undoes it through generation history", async () => {
    const result = await page.evaluate(async ({ insert, parentStyles }) => {
      const root = document.querySelector('[data-oid="root"]') as HTMLElement;
      const before = { children: root.childNodes.length, css: root.style.cssText };
      await window.layoutRequest("commitStyles", {
        updates: parentStyles, patch: { inserts: [insert] }, nextSourceVersion: "c".repeat(24),
      });
      const created = document.querySelector('[data-oid="frame-child"]');
      const undone = await window.layoutRequest("restoreGeneration", { targetSourceVersion: "b".repeat(24), commit: true });
      const afterUndo = {
        html: root.childNodes.length === before.children && root.style.cssText === before.css && !created?.isConnected,
        tree: undone.snapshot.tree[0].children.map((node: { oid: string }) => node.oid),
      };
      const redone = await window.layoutRequest("restoreGeneration", { targetSourceVersion: "c".repeat(24), commit: true });
      return {
        created: !!created,
        afterUndo,
        sameElement: document.querySelector('[data-oid="frame-child"]') === created,
        redoTree: redone.snapshot.tree[0].children.map((node: { oid: string }) => node.oid),
      };
    }, { insert, parentStyles });
    expect(result).toEqual({ created: true, afterUndo: { html: true, tree: ["a"] }, sameElement: true, redoTree: ["a", "frame-child"] });
  });

  it("keeps a pending child across an earlier unrelated commit, then adopts it once", async () => {
    // A style write queued before the child's own transaction confirms first.
    // It must not erase the newer provisional child the inspector is showing.
    const result = await page.evaluate(async ({ insert, parentStyles }) => {
      await window.layoutRequest("previewInsert", { inserts: [insert], updates: parentStyles });
      const previewed = document.querySelector('[data-oid="frame-child"]');
      const unrelated = await window.layoutRequest("commitStyles", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nextSourceVersion: "c".repeat(24),
      });
      const survived = document.querySelector('[data-oid="frame-child"]') === previewed;
      const adopted = await window.layoutRequest("commitStyles", {
        updates: parentStyles, patch: { inserts: [insert] }, nextSourceVersion: "d".repeat(24),
      });
      return {
        survived,
        unrelatedTree: unrelated.snapshot.tree.length === 0 || unrelated.treeUnchanged,
        same: document.querySelector('[data-oid="frame-child"]') === previewed,
        count: document.querySelectorAll('[data-oid="frame-child"]').length,
        adoptedTree: adopted.snapshot.tree[0].children.map((node: { oid: string }) => node.oid),
      };
    }, { insert, parentStyles });
    expect(result).toEqual({ survived: true, unrelatedTree: true, same: true, count: 1, adoptedTree: ["a", "frame-child"] });
  });

  it("keeps concurrent pending children and cancels only the named one", async () => {
    const result = await page.evaluate(async ({ insert }) => {
      const second = { ...insert, nodeId: "frame-second", style: insert.style.replace("left:40px", "left:200px") };
      await window.layoutRequest("previewInsert", { inserts: [insert] });
      await window.layoutRequest("previewInsert", { inserts: [second] });
      const both = ["frame-child", "frame-second"].every((oid) => document.querySelector(`[data-oid="${oid}"]`));
      const cleared = await window.layoutRequest("clearPreviewInserts", { nodeIds: ["frame-child"] });
      return {
        both,
        remaining: Array.from(document.querySelectorAll('[data-oid^="frame-"]')).map((element) => element.getAttribute("data-oid")),
        tree: cleared.snapshot.tree[0].children.map((node: { oid: string }) => node.oid),
      };
    }, { insert });
    expect(result).toEqual({ both: true, remaining: ["frame-second"], tree: ["a", "frame-second"] });
  });

  it("advances the runtime revision when a nested preview or its cancellation changes the tree", async () => {
    // A child drawn inside a nested container leaves the root readback, the
    // root count and the warnings unchanged; only the revision can say so.
    const result = await page.evaluate(async ({ insert }) => {
      const before = await window.layoutRequest("getSnapshot", {});
      const nested = { ...insert, parentId: "a" };
      const preview = await window.layoutRequest("previewInsert", { inserts: [nested], updates: [{ nodeId: "a", styles: { position: "relative" } }] });
      const cleared = await window.layoutRequest("clearPreviewInserts", { nodeIds: ["frame-child"] });
      return { before: before.revision, preview: preview.snapshot.revision, cleared: cleared.snapshot.revision };
    }, { insert });
    expect(result.preview).toBeGreaterThan(result.before);
    expect(result.cleared).toBeGreaterThan(result.preview);
  });

  it("keeps a parent property another pending insert still needs when one is cancelled", async () => {
    const result = await page.evaluate(async ({ insert, parentStyles }) => {
      const second = { ...insert, nodeId: "frame-second" };
      await window.layoutRequest("previewInsert", { inserts: [insert], updates: parentStyles });
      await window.layoutRequest("previewInsert", { inserts: [second], updates: parentStyles });
      const root = document.querySelector('[data-oid="root"]') as HTMLElement;
      await window.layoutRequest("clearPreviewInserts", { nodeIds: ["frame-child"] });
      const whileSecond = getComputedStyle(root).position;
      await window.layoutRequest("clearPreviewInserts", { nodeIds: ["frame-second"] });
      return { whileSecond, after: getComputedStyle(root).position };
    }, { insert, parentStyles });
    expect(result).toEqual({ whileSecond: "relative", after: "static" });
  });

  it("bounds pending inserts to eight across batches", async () => {
    const result = await page.evaluate(async ({ insert }) => {
      const batch = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ ...insert, nodeId: `${prefix}-${index}` }));
      await window.layoutRequest("previewInsert", { inserts: batch("first", 7) });
      const second = await window.layoutRequest("previewInsert", { inserts: batch("second", 2) }).then(() => "ok", (error: Error) => error.message);
      return { second, pending: document.querySelectorAll('[data-oid^="first-"], [data-oid^="second-"]').length };
    }, { insert });
    expect(result.second).not.toBe("ok");
    expect(result.pending).toBe(7);
  });

  it("rejects inserts into void parents, duplicate ids and unbounded styles", async () => {
    const errors = await page.evaluate(async ({ insert }) => {
      const attempt = (args: Record<string, unknown>) => window.layoutRequest("previewInsert", args).then(() => "ok", (error: Error) => error.message);
      document.querySelector('[data-oid="root"]')!.insertAdjacentHTML("beforeend", '<img data-oid="picture">');
      await window.layoutRequest("getSnapshot", {});
      return [
        await attempt({ inserts: [{ ...insert, parentId: "picture" }] }),
        await attempt({ inserts: [{ ...insert, nodeId: "a" }] }),
        await attempt({ inserts: [{ ...insert, style: "x".repeat(5000) }] }),
        await attempt({ inserts: [{ ...insert, tag: "script" }] }),
      ];
    }, { insert });
    expect(errors.every((message: string) => message !== "ok")).toBe(true);
  });

  it("is advertised only to hosts that request it", async () => {
    const methods = await page.evaluate(async (source) => {
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      const child = frame.contentWindow!;
      child.document.body.innerHTML = '<main data-oid="root"></main>';
      const channel = new MessageChannel();
      const ready = new Promise<string[]>((resolve) => {
        channel.port1.onmessage = ({ data }) => {
          if (data.type === "event" && data.event === "ready") resolve(data.payload.capabilities.methods);
        };
      });
      (child as unknown as { __zerosDesignSourceVersion: string }).__zerosDesignSourceVersion = "b".repeat(24);
      const script = child.document.createElement("script");
      script.textContent = source;
      child.document.head.appendChild(script);
      child.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake", sourceVersion: "b".repeat(24) }, "*", [channel.port2]);
      return ready;
    }, DESIGN_RUNTIME_SOURCE);
    expect(methods).not.toContain("previewInsert");
    expect(methods).not.toContain("clearPreviewInserts");
  });
});
