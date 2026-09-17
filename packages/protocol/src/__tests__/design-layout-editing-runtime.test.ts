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
    document.body.innerHTML = `<main data-oid="root" style="display:flex;position:relative;width:600px;height:400px;gap:10px"><div data-oid="a" style="width:100px;height:80px"></div><div data-oid="b" style="width:100px;height:80px"></div><section data-oid="nested" style="display:grid;width:200px;height:160px"></section></main>`;
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

describe("layout runtime editing", () => {
  it("bounds inline gap measurement when a container has thousands of hidden children", async () => {
    const reads = await page.evaluate(async () => {
      const root = document.querySelector('[data-oid="root"]')!;
      root.innerHTML = Array.from(
        { length: 6000 },
        (_, i) => `<div data-oid="hidden-${i}" style="display:none"></div>`,
      ).join("");
      await window.layoutRequest("getSnapshot", {});
      const original = window.getComputedStyle;
      let count = 0;
      window.getComputedStyle = (...args) => {
        count++;
        return original(...args);
      };
      await window.layoutRequest("previewGeometry", {
        nodeId: "root",
        styles: { gap: "24px" },
        children: true,
      });
      window.getComputedStyle = original;
      return count;
    });
    expect(reads).toBeLessThan(300);
  });

  it("treats a positional drag with unchanged sibling order as a style-only commit", async () => {
    const result = await page.evaluate(async () => {
      let walks = 0;
      const original = document.createTreeWalker.bind(document);
      document.createTreeWalker = (...args) => {
        walks++;
        return original(...args);
      };
      const committed = await window.layoutRequest("commitStyles", {
        updates: [{ nodeId: "a", styles: { left: "20px" } }],
        patch: { moves: [{ nodeId: "a", parentId: "root", beforeId: "b" }] },
        nextSourceVersion: "c".repeat(24),
      });
      document.createTreeWalker = original;
      return { walks, unchanged: committed.treeUnchanged };
    });
    expect(result).toEqual({ walks: 0, unchanged: true });
  });

  it("keeps the dragged layer and its parent addressable after thousands of SVG paths", async () => {
    const result = await page.evaluate(async () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("data-oid", "art");
      svg.innerHTML = Array.from(
        { length: 4000 },
        (_, i) => `<path data-oid="path-${i}" d="M0 0 L1 1"/>`,
      ).join("");
      document.body.prepend(svg);
      await window.layoutRequest("getSnapshot", {});
      let reads = 0;
      const original = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        reads++;
        return original.call(this);
      };
      const targets = await window.layoutRequest("getLayoutTargets", {
        nodeId: "a",
      });
      Element.prototype.getBoundingClientRect = original;
      return { ids: targets.map((node: { oid: string }) => node.oid), reads };
    });
    expect(result.ids).toEqual(expect.arrayContaining(["a", "root", "nested"]));
    expect(result.ids.some((id: string) => id.startsWith("path-"))).toBe(false);
    expect(result.reads).toBeLessThan(40);
  });

  it("does not walk the document or rebuild the layer tree for a size commit and its inverse", async () => {
    const result = await page.evaluate(async () => {
      let walks = 0;
      const original = document.createTreeWalker.bind(document);
      document.createTreeWalker = (...args) => {
        walks++;
        return original(...args);
      };
      const committed = await window.layoutRequest("commitStyles", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nextSourceVersion: "c".repeat(24),
      });
      const undone = await window.layoutRequest("restoreGeneration", {
        targetSourceVersion: "b".repeat(24),
        commit: false,
      });
      const confirmed = await window.layoutRequest("restoreGeneration", {
        targetSourceVersion: "b".repeat(24),
        commit: true,
      });
      document.createTreeWalker = original;
      return {
        walks,
        committed: committed.treeUnchanged,
        undone: undone.treeUnchanged,
        width: confirmed.details[0]?.styles.width,
      };
    });
    expect(result).toEqual({
      walks: 0,
      committed: true,
      undone: true,
      width: "100px",
    });
  });

  it("suppresses transferred pixels without changing authored styles or measuring descendants", async () => {
    const result = await page.evaluate(async () => {
      const root = document.querySelector<HTMLElement>('[data-oid="root"]')!;
      const authored = root.style.cssText;
      const geometry = await window.layoutRequest("previewLayout", {
        updates: [],
        nodeIds: ["root"],
        suppressNodeId: "root",
        children: false,
      });
      const hidden = getComputedStyle(root).opacity;
      await window.layoutRequest("previewLayout", {
        updates: [],
        nodeIds: [],
        cancelMoves: true,
        suppressNodeId: null,
      });
      return {
        hidden,
        restored: getComputedStyle(root).opacity,
        unchanged: root.style.cssText === authored,
        children: geometry[0].children,
      };
    });
    expect(result).toEqual({
      hidden: "0",
      restored: "1",
      unchanged: true,
      children: [],
    });
  });

  it("keeps a newer preview painted when an earlier commit arrives", async () => {
    const values = await page.evaluate(async () => {
      await window.layoutRequest("previewGeometry", {
        nodeId: "a",
        styles: { width: "140px" },
      });
      await window.layoutRequest("previewGeometry", {
        nodeId: "a",
        styles: { width: "180px" },
      });
      await window.layoutRequest("commitStyles", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nextSourceVersion: "c".repeat(24),
      });
      const painted = getComputedStyle(
        document.querySelector('[data-oid="a"]')!,
      ).width;
      await window.layoutRequest("clearPreviewStyles", { nodeId: "a" });
      return [
        painted,
        getComputedStyle(document.querySelector('[data-oid="a"]')!).width,
      ];
    });
    expect(values).toEqual(["180px", "140px"]);
  });

  it("previews all layout writes together and measures final child positions", async () => {
    const result = await page.evaluate(() =>
      window.layoutRequest("previewLayout", {
        updates: [
          { nodeId: "root", styles: { "justify-content": "flex-end" } },
          { nodeId: "a", styles: { width: "120px" } },
        ],
        nodeIds: ["root"],
      }),
    );
    expect(result[0].children[0].rect.x).toBe(160);
    expect(result[0].children[0].rect.width).toBe(120);
  });

  it("reparents the existing element, cancels cleanly, and restores committed history in place", async () => {
    const result = await page.evaluate(async () => {
      const a = document.querySelector('[data-oid="a"]')!;
      await window.layoutRequest("previewLayout", {
        updates: [],
        moves: [{ nodeId: "a", parentId: "nested", beforeId: null }],
        nodeIds: ["a"],
      });
      const nested = a.parentElement?.getAttribute("data-oid");
      await window.layoutRequest("previewLayout", {
        updates: [],
        moves: [],
        cancelMoves: true,
        nodeIds: ["a"],
      });
      const cancelled = a.parentElement?.getAttribute("data-oid");
      await window.layoutRequest("commitStyles", {
        updates: [{ nodeId: "a", styles: { width: "120px" } }],
        patch: { moves: [{ nodeId: "a", parentId: "nested", beforeId: null }] },
        nextSourceVersion: "c".repeat(24),
      });
      await window.layoutRequest("restoreGeneration", {
        targetSourceVersion: "b".repeat(24),
        commit: true,
      });
      return {
        nested,
        cancelled,
        restored: a.parentElement?.getAttribute("data-oid"),
        width: getComputedStyle(a).width,
        same: document.querySelector('[data-oid="a"]') === a,
      };
    });
    expect(result).toEqual({
      nested: "nested",
      cancelled: "root",
      restored: "root",
      width: "100px",
      same: true,
    });
  });

  it("keeps a newer structural preview when an earlier move commits", async () => {
    const result = await page.evaluate(async () => {
      const a = document.querySelector('[data-oid="a"]')!;
      await window.layoutRequest("previewLayout", {
        updates: [],
        moves: [{ nodeId: "a", parentId: "nested", beforeId: null }],
        nodeIds: [],
      });
      await window.layoutRequest("previewLayout", {
        updates: [],
        moves: [{ nodeId: "a", parentId: "root", beforeId: "nested" }],
        nodeIds: [],
      });
      await window.layoutRequest("commitStyles", {
        updates: [],
        patch: { moves: [{ nodeId: "a", parentId: "nested", beforeId: null }] },
        nextSourceVersion: "c".repeat(24),
      });
      const painted = a.parentElement?.getAttribute("data-oid");
      await window.layoutRequest("previewLayout", {
        updates: [],
        cancelMoves: true,
        nodeIds: [],
      });
      return [painted, a.parentElement?.getAttribute("data-oid")];
    });
    expect(result).toEqual(["root", "nested"]);
  });

  it("rejects a cyclic move before changing any node", async () => {
    await expect(
      page.evaluate(() =>
        window.layoutRequest("previewLayout", {
          updates: [],
          moves: [{ nodeId: "root", parentId: "nested", beforeId: null }],
          nodeIds: [],
        }),
      ),
    ).rejects.toThrow();
    expect(
      await page
        .locator('[data-oid="nested"]')
        .evaluate((el) => el.parentElement?.getAttribute("data-oid")),
    ).toBe("root");
  });
});
