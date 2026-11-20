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
        features: [
          "measureLayout",
          "setPlayback",
          "holdNodeState",
          "releaseNodeState",
          "previewHistory",
          "previewInsert",
          "clearPreviewInserts",
          "commitStructure",
          "previewStructure",
          "clearPreviewStructure",
          "previewStylesheet",
          "previewComponentOptions",
        ],
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

  it("measures requested boxes in the history restore that moved them", async () => {
    const result = await page.evaluate(async () => {
      await window.layoutRequest("commitStyles", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nextSourceVersion: "c".repeat(24),
      });
      const restored = await window.layoutRequest("restoreGeneration", {
        targetSourceVersion: "b".repeat(24),
        commit: true,
        // Restoring a's width moves the untouched sibling b; unknown IDs are omitted.
        measure: ["b", "a", "missing"],
      });
      return restored.details.map(
        (details: { oid: string; rect: { x: number } }) =>
          `${details.oid}@${details.rect.x}`,
      );
    });
    expect(result).toEqual(["a@0", "b@110"]);
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

  it("measures proposed layout without disturbing a newer preview", async () => {
    const result = await page.evaluate(async () => {
      await window.layoutRequest("previewGeometry", {
        nodeId: "a",
        styles: { width: "180px" },
      });
      const measured = await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nodeIds: ["a", "root"],
      });
      const visible = getComputedStyle(document.querySelector('[data-oid="a"]')!).width;
      const confirmed = await window.layoutRequest("measureLayout", {
        updates: [],
        nodeIds: ["a"],
      });
      return {
        measured: measured.map((details: { oid: string; styles: { width: string } }) =>
          `${details.oid}:${details.styles.width}`,
        ),
        visible,
        confirmed: confirmed[0].styles.width,
      };
    });
    expect(result).toEqual({
      measured: ["a:140px", "root:600px"],
      visible: "180px",
      confirmed: "100px",
    });
  });

  it("preserves sibling preview bookkeeping and exact styles on failure", async () => {
    const result = await page.evaluate(async () => {
      const b = document.querySelector<HTMLElement>('[data-oid="b"]')!;
      await window.layoutRequest("previewGeometry", {
        nodeId: "b",
        styles: { width: "180px" },
      });
      const before = b.getAttribute("style");
      await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nodeIds: ["a", "root"],
      });
      const after = b.getAttribute("style");
      let error = "";
      try {
        await window.layoutRequest("measureLayout", {
          updates: [{ nodeId: "a", styles: { width: {} } }],
          nodeIds: ["a"],
        });
      } catch (caught) {
        error = String(caught);
      }
      return {
        before,
        after,
        error,
        stillPreviewed: b.getAttribute("style"),
      };
    });
    expect(result.before).toBe("width: 180px; height: 80px;");
    expect(result.after).toBe(result.before);
    expect(result.error).toMatch(/invalid layout measurement styles/i);
    expect(result.stillPreviewed).toBe(result.before);
  });

  it("restores confirmed DOM and a sibling preview after a details read throws", async () => {
    const result = await page.evaluate(async () => {
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      const b = document.querySelector<HTMLElement>('[data-oid="b"]')!;
      await window.layoutRequest("previewGeometry", {
        nodeId: "b",
        styles: { width: "180px" },
      });
      const beforeA = a.getAttribute("style");
      const beforeB = b.getAttribute("style");
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      let armed = true;
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (armed && this === a && a.style.width === "140px") {
          armed = false;
          throw new Error("proposed details read failed");
        }
        return originalRect.call(this);
      };
      let error = "";
      try {
        await window.layoutRequest("measureLayout", {
          updates: [{ nodeId: "a", styles: { width: "140px" } }],
          nodeIds: ["a", "root"],
        });
      } catch (caught) {
        error = String(caught);
      } finally {
        HTMLElement.prototype.getBoundingClientRect = originalRect;
      }
      const afterA = a.getAttribute("style");
      const afterB = b.getAttribute("style");
      await window.layoutRequest("clearPreviewStyles", { nodeId: "b" });
      return {
        error,
        beforeA,
        afterA,
        beforeB,
        afterB,
        clearedB: b.getAttribute("style"),
        confirmedA: getComputedStyle(a).width,
      };
    });
    expect(result).toEqual({
      error: expect.stringContaining("proposed details read failed"),
      beforeA: "width:100px;height:80px",
      afterA: "width:100px;height:80px",
      beforeB: "width: 180px; height: 80px;",
      afterB: "width: 180px; height: 80px;",
      clearedB: "width: 100px; height: 80px;",
      confirmedA: "100px",
    });
  });

  it("measures a Hug root against confirmed siblings, not a sibling preview", async () => {
    const result = await page.evaluate(async () => {
      const root = document.querySelector<HTMLElement>('[data-oid="root"]')!;
      root.style.cssText = "display:inline-flex;position:relative;gap:10px;width:max-content;height:max-content";
      await window.layoutRequest("previewGeometry", {
        nodeId: "b",
        styles: { width: "180px" },
      });
      const measured = await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nodeIds: ["a", "root"],
      });
      return {
        measuredRoot: measured.find((details: { oid: string }) => details.oid === "root")!.rect.width,
        visibleRoot: root.getBoundingClientRect().width,
      };
    });
    expect(result).toEqual({ measuredRoot: 460, visibleRoot: 500 });
  });

  it("restores exact state after a same-value proposal", async () => {
    const result = await page.evaluate(async () => {
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      await window.layoutRequest("previewGeometry", {
        nodeId: "a",
        styles: { width: "180px" },
      });
      const before = a.getAttribute("style");
      const measured = await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "a", styles: { width: "180px" } }],
        nodeIds: ["a"],
      });
      return { before, after: a.getAttribute("style"), width: measured[0].styles.width };
    });
    expect(result).toEqual({
      before: "width: 180px; height: 80px;",
      after: "width: 180px; height: 80px;",
      width: "180px",
    });
  });

  it("reads confirmed relocation details while preserving an active preview", async () => {
    const result = await page.evaluate(async () => {
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      await window.layoutRequest("previewGeometry", {
        nodeId: "a",
        styles: { left: "20px" },
      });
      const measured = await window.layoutRequest("measureLayout", {
        updates: [],
        nodeIds: ["a"],
        relocation: true,
      });
      return {
        layoutX: measured[0].layout.x,
        hasRelocation: Boolean(measured[0].relocationContext),
        visible: a.style.left,
      };
    });
    expect(result.layoutX).toBe(0);
    expect(result.hasRelocation).toBe(true);
    expect(result.visible).toBe("20px");
  });

  it("restores an absent inline style attribute after a proposal", async () => {
    const result = await page.evaluate(async () => {
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      a.removeAttribute("style");
      const measured = await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "a", styles: { width: "180px" } }],
        nodeIds: ["a"],
      });
      return {
        width: measured[0].styles.width,
        hasStyleAttribute: a.hasAttribute("style"),
      };
    });
    expect(result).toEqual({ width: "180px", hasStyleAttribute: false });
  });

  it("keeps a held marker and pending history presentation around measurement", async () => {
    const result = await page.evaluate(async () => {
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      document.head.insertAdjacentHTML("beforeend", "<style>[data-oid='a']{width:100px}[data-oid='a']:hover{height:220px}</style>");
      a.style.removeProperty("width");
      await window.layoutRequest("getSnapshot", {});
      const held = await window.layoutRequest("holdNodeState", {
        nodeId: "a",
        state: "hover",
        holdId: "measure-hold",
      });
      const heldMeasured = await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nodeIds: ["a"],
      });
      const marker = a.getAttribute("data-zd-state");
      await window.layoutRequest("releaseNodeState", {});
      await window.layoutRequest("commitStyles", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nextSourceVersion: "c".repeat(24),
      });
      await window.layoutRequest("previewHistory", {
        targetSourceVersion: "b".repeat(24),
      });
      const confirmed = await window.layoutRequest("measureLayout", {
        updates: [],
        nodeIds: ["a"],
      });
      const measured = await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "a", styles: { width: "160px" } }],
        nodeIds: ["a"],
      });
      const confirmedAfter = await window.layoutRequest("measureLayout", {
        updates: [],
        nodeIds: ["a"],
      });
      const authoredRule = Array.from(document.styleSheets)
        .flatMap((sheet) => Array.from(sheet.cssRules ?? []))
        .find((rule) => (rule as CSSStyleRule).selectorText?.includes("data-oid"));
      return {
        held: held.heldState,
        heldMeasured: heldMeasured[0].heldState,
        marker,
        confirmed: confirmed[0].styles.width,
        confirmedAuthored: confirmed[0].authoredStyles?.width?.value,
        measured: measured[0].styles.width,
        confirmedAfter: confirmedAfter[0].styles.width,
        confirmedAfterAuthored: confirmedAfter[0].authoredStyles?.width?.value,
        authoredRule: (authoredRule as CSSStyleRule | undefined)?.style.width,
        presented: getComputedStyle(a).width,
      };
    });
    expect(result).toEqual({
      held: "hover",
      heldMeasured: "hover",
      marker: "hover",
      confirmed: "140px",
      confirmedAuthored: "140px",
      measured: "160px",
      confirmedAfter: "140px",
      confirmedAfterAuthored: "140px",
      authoredRule: "100px",
      presented: "100px",
    });
  });

  it("sets aside mixed topology previews and restores exact identities after measurement", async () => {
    const result = await page.evaluate(async () => {
      const root = document.querySelector<HTMLElement>('[data-oid="root"]')!;
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      const originalOrder = Array.from(root.children).map((child) => child.getAttribute("data-oid"));
      await window.layoutRequest("previewLayout", {
        updates: [],
        moves: [{ nodeId: "a", parentId: "nested", beforeId: null }],
        nodeIds: [],
      });
      await window.layoutRequest("previewInsert", {
        inserts: [{ nodeId: "inserted", parentId: "root", beforeId: null, tag: "div", style: "width:30px;height:20px" }],
      });
      await window.layoutRequest("previewStructure", {
        previewId: "duplicate",
        operations: [{ type: "duplicate", nodeId: "b", duplicateNodeId: "copy" }],
      });
      const before = await window.layoutRequest("getSnapshot", {});
      const measured = await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nodeIds: ["a", "root"],
      });
      const after = await window.layoutRequest("getSnapshot", {});
      const during = {
        parent: a.parentElement?.getAttribute("data-oid"),
        ids: Array.from(root.children).map((child) => child.getAttribute("data-oid")),
        width: a.style.width,
        inserted: document.querySelector('[data-oid="inserted"]') !== null,
        copy: document.querySelector('[data-oid="copy"]') !== null,
        revision: after.revision,
        unchangedRevision: after.revision === before.revision,
      };
      await window.layoutRequest("clearPreviewInserts", {});
      await window.layoutRequest("clearPreviewStructure", { previewId: "duplicate" });
      await window.layoutRequest("previewLayout", {
        updates: [],
        nodeIds: [],
        cancelMoves: true,
      });
      return {
        measured: measured.map((details: { oid: string; styles: { width: string } }) => details.oid + ":" + details.styles.width),
        during,
        restored: {
          identity: document.querySelector('[data-oid="a"]') === a,
          order: Array.from(root.children).map((child) => child.getAttribute("data-oid")),
          originalOrder,
          inserted: document.querySelector('[data-oid="inserted"]') !== null,
          copy: document.querySelector('[data-oid="copy"]') !== null,
        },
      };
    });
    expect(result.measured).toEqual(["a:140px", expect.stringContaining("root:")]);
    expect(result.during).toEqual({
      parent: "nested",
      ids: ["b", "copy", "nested", "inserted"],
      width: "100px",
      inserted: true,
      copy: true,
      revision: expect.any(Number),
      unchangedRevision: true,
    });
    expect(result.restored).toEqual({
      identity: true,
      order: result.restored.originalOrder,
      originalOrder: ["a", "b", "nested"],
      inserted: false,
      copy: false,
    });
  });

  it("resolves a node hidden by a structural preview and restores it after a details failure", async () => {
    const result = await page.evaluate(async () => {
      const root = document.querySelector<HTMLElement>('[data-oid="root"]')!;
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      await window.layoutRequest("previewStructure", {
        previewId: "delete-a",
        operations: [{ type: "delete", nodeId: "a" }],
      });
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      let armed = true;
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (armed && this === a) {
          armed = false;
          throw new Error("topology details failed");
        }
        return originalRect.call(this);
      };
      const error = await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nodeIds: ["a", "root"],
      }).then(() => "", (failure: Error) => failure.message);
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      const stillDeleted = a.parentNode === null;
      await window.layoutRequest("clearPreviewStructure", { previewId: "delete-a" });
      return {
        error,
        stillDeleted,
        identity: document.querySelector('[data-oid="a"]') === a,
        order: Array.from(root.children).map((child) => child.getAttribute("data-oid")),
      };
    });
    expect(result).toEqual({
      error: "topology details failed",
      stillDeleted: true,
      identity: true,
      order: ["a", "b", "nested"],
    });
  });

  it("retains semantic visibility while isolating its preview map", async () => {
    const result = await page.evaluate(async () => {
      const b = document.querySelector<HTMLElement>('[data-oid="b"]')!;
      await window.layoutRequest("setNodeVisibility", { nodeId: "b", visible: false });
      const before = await window.layoutRequest("getSnapshot", {});
      await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nodeIds: ["a", "root"],
      });
      const after = await window.layoutRequest("getSnapshot", {});
      const hidden = getComputedStyle(b).display;
      await window.layoutRequest("setNodeVisibility", { nodeId: "b", visible: true });
      return { hidden, revisionUnchanged: after.revision === before.revision };
    });
    expect(result).toEqual({ hidden: "none", revisionUnchanged: true });
  });

  it("restores mixed topology previews when set-aside throws partway through", async () => {
    const result = await page.evaluate(async () => {
      const root = document.querySelector<HTMLElement>('[data-oid="root"]')!;
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      const b = document.querySelector<HTMLElement>('[data-oid="b"]')!;
      const nested = document.querySelector<HTMLElement>('[data-oid="nested"]')!;
      await window.layoutRequest("previewInsert", {
        inserts: [{ nodeId: "inserted", parentId: "root", beforeId: null, tag: "div", style: "width:30px;height:20px" }],
      });
      await window.layoutRequest("previewStructure", {
        previewId: "delete-a",
        operations: [{ type: "delete", nodeId: "a" }],
      });
      await window.layoutRequest("previewStructure", {
        previewId: "delete-b",
        operations: [{ type: "delete", nodeId: "b" }],
      });
      const p2Order = Array.from(root.children).map((child) => child.getAttribute("data-oid"));
      const originalInsertBefore = root.insertBefore;
      let armed = true;
      root.insertBefore = function <T extends Node>(node: T, before: Node | null): T {
        if (armed) {
          armed = false;
          throw new Error("topology set-aside failed");
        }
        return originalInsertBefore.call(this, node, before) as T;
      };
      const error = await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "nested", styles: { width: "220px" } }],
        nodeIds: ["nested"],
      }).then(() => "", (failure: Error) => failure.message);
      root.insertBefore = originalInsertBefore;
      const afterFailure = {
        order: Array.from(root.children).map((child) => child.getAttribute("data-oid")),
        aConnected: a.isConnected,
        bConnected: b.isConnected,
        insertedConnected: document.querySelector('[data-oid="inserted"]') !== null,
      };
      await window.layoutRequest("clearPreviewStructure", {});
      await window.layoutRequest("clearPreviewInserts", {});
      return {
        error,
        p2Order,
        afterFailure,
        cancelled: {
          order: Array.from(root.children).map((child) => child.getAttribute("data-oid")),
          a: document.querySelector('[data-oid="a"]') === a,
          b: document.querySelector('[data-oid="b"]') === b,
          nested: document.querySelector('[data-oid="nested"]') === nested,
          inserted: document.querySelector('[data-oid="inserted"]') !== null,
        },
      };
    });
    expect(result.error).toBe("topology set-aside failed");
    expect(result.afterFailure).toEqual({
      order: result.p2Order,
      aConnected: false,
      bConnected: false,
      insertedConnected: true,
    });
    expect(result.cancelled).toEqual({
      order: ["a", "b", "nested"],
      a: true,
      b: true,
      nested: true,
      inserted: false,
    });
  });

  it("restores important stylesheet CSSOM and text preview child identity", async () => {
    const result = await page.evaluate(async () => {
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      const style = document.createElement("style");
      style.textContent = "[data-oid='a']{width:100px;color:red !important}";
      document.head.appendChild(style);
      const rule = Array.from(style.sheet!.cssRules).find((entry) => entry instanceof CSSStyleRule) as CSSStyleRule;
      const ruleBefore = rule.style.cssText;
      const authoredText = "confirmed";
      a.textContent = authoredText;
      await window.layoutRequest("previewStyles", {
        nodeId: "a",
        styles: { width: "180px", color: "blue" },
      });
      await window.layoutRequest("previewText", { nodeId: "a", text: "P2 text" });
      const p2Node = a.firstChild;
      const p2ChildNodes = Array.from(a.childNodes);
      const p2 = {
        rule: rule.style.cssText,
        text: a.textContent,
        nodeIsCurrent: a.firstChild === p2Node,
        childNodesAreCurrent: p2ChildNodes.every((node, index) => a.childNodes[index] === node),
        width: getComputedStyle(a).width,
      };
      let measuredState: {
        rule: string;
        text: string | null;
        width: string;
      } | null = null;
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (this === a) {
          measuredState = {
            rule: rule.style.cssText,
            text: a.textContent,
            width: getComputedStyle(a).width,
          };
        }
        return originalRect.call(this);
      };
      const measured = await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nodeIds: ["a"],
      });
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      const after = {
        rule: rule.style.cssText,
        text: a.textContent,
        nodeIsP2: a.firstChild === p2Node,
        width: getComputedStyle(a).width,
      };
      await window.layoutRequest("clearPreviewText", { nodeId: "a" });
      const clearedText = a.textContent;
      await window.layoutRequest("clearPreviewStyles", { nodeId: "a" });
      return {
        measured: measured[0].styles.width,
        ruleBefore,
        p2,
        measuredState,
        after,
        clearedText,
        cancelled: {
          rule: rule.style.cssText,
          text: a.textContent,
          width: getComputedStyle(a).width,
        },
      };
    });
    expect(result.measured).toBe("140px");
    expect(result.p2.rule).not.toBe(result.ruleBefore);
    expect(result.p2.text).toBe("P2 text");
    expect(result.p2.nodeIsCurrent).toBe(true);
    expect(result.p2.childNodesAreCurrent).toBe(true);
    expect(result.after).toEqual({
      rule: result.p2.rule,
      text: "P2 text",
      nodeIsP2: true,
      width: "180px",
    });
    expect(result.cancelled).toEqual({
      rule: result.ruleBefore,
      text: "confirmed",
      width: "100px",
    });
    expect(result.clearedText).toBe("confirmed");
    expect(result.measuredState).toEqual({
      rule: result.ruleBefore,
      text: "confirmed",
      width: "140px",
    });
  });

  it("restores stylesheet and options previews without replacing their CSSOM identities", async () => {
    const result = await page.evaluate(async () => {
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      a.style.removeProperty("width");
      const source = document.createElement("style");
      source.setAttribute("data-zeros-source", "tokens.css");
      source.textContent = ":root{--zd-width:100px}[data-oid='a']{width:var(--zd-width);color:red!important}";
      document.head.appendChild(source);
      await window.layoutRequest("previewStylesheet", {
        file: "tokens.css",
        css: ":root{--zd-width:100px}[data-oid='a']{width:var(--zd-width);color:blue!important}",
      });
      await window.layoutRequest("previewComponentOptions", {
        properties: { "--zd-width": "180px" },
      });
      const sourceSheet = source.sheet!;
      const sourceRule = sourceSheet.cssRules[1]!;
      const optionsStyle = document.querySelector<HTMLStyleElement>("style[data-zeros-runtime-options]")!;
      const optionsSheet = optionsStyle.sheet!;
      const optionsRule = optionsSheet.cssRules[0]!;
      const before = {
        width: getComputedStyle(a).width,
        color: getComputedStyle(a).color,
        sourceText: source.textContent,
        sourceRule: (sourceRule as CSSStyleRule).style.cssText,
      };
      let measuredState: {
        width: string;
        color: string;
        token: string;
      } | null = null;
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (this === a) {
          measuredState = {
            width: getComputedStyle(a).width,
            color: getComputedStyle(a).color,
            token: getComputedStyle(document.documentElement).getPropertyValue("--zd-width").trim(),
          };
        }
        return originalRect.call(this);
      };
      const measured = await window.layoutRequest("measureLayout", {
        updates: [{ nodeId: "a", styles: { width: "140px" } }],
        nodeIds: ["a"],
      });
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      const after = {
        sameSourceSheet: source.sheet === sourceSheet,
        sameSourceRule: source.sheet?.cssRules[1] === sourceRule,
        sameOptionsStyle: document.querySelector("style[data-zeros-runtime-options]") === optionsStyle,
        sameOptionsSheet: optionsStyle.sheet === optionsSheet,
        sameOptionsRule: optionsStyle.sheet?.cssRules[0] === optionsRule,
        width: getComputedStyle(a).width,
        color: getComputedStyle(a).color,
        sourceText: source.textContent,
        sourceRule: (source.sheet!.cssRules[1] as CSSStyleRule).style.cssText,
      };
      await window.layoutRequest("previewStylesheet", { file: "tokens.css", css: null });
      await window.layoutRequest("previewComponentOptions", { clear: true });
      return {
        before,
        measured: measured[0].styles,
        measuredState,
        after,
        cleared: { width: getComputedStyle(a).width, color: getComputedStyle(a).color },
      };
    });
    expect(result.before).toMatchObject({
      width: "180px",
      color: "rgb(0, 0, 255)",
    });
    expect(result.measuredState).toEqual({
      width: "140px",
      color: "rgb(255, 0, 0)",
      token: "100px",
    });
    expect(result.measured).toMatchObject({ width: "140px", color: "rgb(255, 0, 0)" });
    expect(result.after).toMatchObject({
      sameSourceSheet: true,
      sameSourceRule: true,
      sameOptionsStyle: true,
      sameOptionsSheet: true,
      sameOptionsRule: true,
      width: "180px",
      color: "rgb(0, 0, 255)",
      sourceText: ":root{--zd-width:100px}[data-oid='a']{width:var(--zd-width);color:blue!important}",
    });
    expect(result.cleared).toEqual({
      width: "100px",
      color: "rgb(255, 0, 0)",
    });
  });

  it.each(["running", "paused"] as const)(
    "rejects a %s CSS transition before measurement writes",
    async (state) => {
      const result = await page.evaluate(async (playState) => {
        const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
        await window.layoutRequest("previewStyles", {
          nodeId: "a",
          styles: { width: "150px" },
        });
        const baselineSnapshot = await window.layoutRequest("getSnapshot", {});
        a.style.transition = "height 30s linear";
        void a.offsetHeight;
        a.style.height = "160px";
        void a.offsetHeight;
        const transition = a
          .getAnimations()
          .find((animation) => animation.constructor.name === "CSSTransition");
        if (!transition) throw new Error("Expected a CSS transition.");
        if (playState === "paused") {
          transition.pause();
          transition.currentTime = 5000;
          // Settle the pending pause so the measurement sees a paused transition.
          await transition.ready;
        }
        const before = {
          style: a.getAttribute("style"),
          width: getComputedStyle(a).width,
          transition,
          currentTime: transition.currentTime,
          playState: transition.playState,
          revision: playState === "paused" ? baselineSnapshot.revision : null,
        };
        let error: string | null = null;
        try {
          await window.layoutRequest("measureLayout", {
            updates: [{ nodeId: "a", styles: { width: "140px" } }],
            nodeIds: ["a", "root"],
          });
        } catch (caught) {
          error = (caught as Error).message;
        }
        const afterTransition = a
          .getAnimations()
          .find((animation) => animation.constructor.name === "CSSTransition");
        const after = {
          style: a.getAttribute("style"),
          width: getComputedStyle(a).width,
          sameTransition: afterTransition === before.transition,
          currentTime: afterTransition?.currentTime ?? null,
          playState: afterTransition?.playState ?? null,
          revision: playState === "paused"
            ? (await window.layoutRequest("getSnapshot", {})).revision
            : null,
        };
        await window.layoutRequest("clearPreviewStyles", { nodeId: "a" });
        return {
          error,
          before: {
            style: before.style,
            width: before.width,
            currentTime: before.currentTime,
            playState: before.playState,
            revision: before.revision,
          },
          after,
          clearedWidth: getComputedStyle(a).width,
        };
      }, state);
      expect(result.error).toContain("Active CSS transitions prevent layout measurement");
      expect(result.after).toMatchObject({
        style: result.before.style,
        playState: state,
      });
      if (state === "paused") {
        expect(result.after.width).toBe(result.before.width);
        expect(result.after.revision).toBe(result.before.revision);
      }
      expect(result.after.sameTransition).toBe(true);
      if (state === "paused") {
        expect(result.after.currentTime).toBe(5000);
      }
      expect(result.clearedWidth).toBe("100px");
    },
  );

  it("stills a newly inserted authored CSSAnimation before measurement in a passive frame", async () => {
    const result = await page.evaluate(async () => {
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      const started = new Promise<void>((resolve) => {
        document.addEventListener("animationstart", function onStart(event) {
          if (event.target !== a || event.animationName !== "layout-passive-width") return;
          document.removeEventListener("animationstart", onStart, true);
          resolve();
        }, true);
      });
      const source = document.createElement("style");
      source.textContent =
        "@keyframes layout-passive-width{from{width:100px}to{width:200px}}" +
        "[data-oid='a']{animation:layout-passive-width 10s linear paused both}";
      document.head.append(source);
      const animation = a.getAnimations()[0];
      if (!animation) throw new Error("Expected a CSS animation before animationstart.");
      const cancel = animation.cancel.bind(animation);
      let cancelCalls = 0;
      animation.cancel = () => {
        cancelCalls += 1;
        cancel();
      };
      animation.currentTime = 5000;
      const sheet = source.sheet!;
      const rule = sheet.cssRules[0];
      const text = source.textContent;
      const beforeEvent = { listed: a.getAnimations().includes(animation), playState: animation.playState };
      await started;
      return {
        beforeEvent,
        cancelCalls,
        listed: a.getAnimations().includes(animation),
        playState: animation.playState,
        currentTime: animation.currentTime,
        width: getComputedStyle(a).width,
        sourceIntact: source.isConnected && source.sheet === sheet && sheet.cssRules[0] === rule && source.textContent === text,
      };
    });
    expect(result).toEqual({
      beforeEvent: { listed: true, playState: "paused" },
      cancelCalls: 1,
      listed: false,
      playState: "idle",
      currentTime: null,
      width: "100px",
      sourceIntact: true,
    });
  });

  it.each(["success", "details throw"] as const)(
    "preserves geometry-affecting CSSAnimation effects through a measurement %s",
    async (outcome) => {
      const result = await page.evaluate(async (measurementOutcome) => {
        await window.layoutRequest("setPlayback", {
          sessionId: "geometry-css-animation-measurement",
          playing: true,
        });
        const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
        const b = document.querySelector<HTMLElement>('[data-oid="b"]')!;
        const started = new Promise<void>((resolve) => {
          const targets = new Set<EventTarget>();
          document.addEventListener("animationstart", function onStart(event) {
            if ((event.target !== a && event.target !== b) || event.animationName !== "layout-measure-width") return;
            targets.add(event.target);
            if (targets.size !== 2) return;
            document.removeEventListener("animationstart", onStart, true);
            resolve();
          }, true);
        });
        const animationStyle = document.createElement("style");
        animationStyle.textContent =
          "@keyframes layout-measure-width{from{width:100px}to{width:200px}}" +
          "[data-oid='a'],[data-oid='b']{animation:layout-measure-width 10s linear paused both}";
        document.head.append(animationStyle);
        void getComputedStyle(a).width;
        void getComputedStyle(b).width;
        const cssAnimations = [a, b].map((element) =>
          element
            .getAnimations()
            .find((animation) => animation.constructor.name === "CSSAnimation"),
        );
        if (cssAnimations.some((animation) => !animation)) {
          throw new Error("Expected CSS animations on both measurement targets.");
        }
        const effects = cssAnimations.map((animation) => animation!.effect);
        cssAnimations.forEach((animation) => {
          animation!.pause();
          animation!.currentTime = 5000;
        });
        await started;
        const animationSheet = animationStyle.sheet!;
        const animationRule = animationSheet.cssRules[0];
        const animationText = animationStyle.textContent;
        const detachedDuringRead: Array<{
          target: HTMLElement;
          effectNull: boolean;
          originalTarget: boolean;
        }> = [];
        let thrown = false;
        let detailsError: string | null = null;
        let measuredWidths: string[] | null = null;
        const originalRect = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function () {
          if ((this === a || this === b) && a.style.width === "140px") {
            const index = this === a ? 0 : 1;
            detachedDuringRead.push({
              target: this as HTMLElement,
              effectNull: cssAnimations[index]!.effect === null,
              originalTarget: (effects[index] as KeyframeEffect | null)?.target === this,
            });
            if (this === a && measurementOutcome === "details throw" && !thrown) {
              thrown = true;
              throw new Error("Injected details read failure.");
            }
          }
          return originalRect.call(this);
        };
        const beforeMeasure = cssAnimations.map((animation, index) => ({
          listed: [a, b][index].getAnimations().includes(animation!),
          currentTime: animation!.currentTime,
          playState: animation!.playState,
        }));
        if (beforeMeasure.some((state) => !state.listed || state.currentTime !== 5000 || state.playState !== "paused")) {
          throw new Error("CSSAnimation changed before measureLayout: " + JSON.stringify(beforeMeasure));
        }
        try {
          const measured = await window.layoutRequest("measureLayout", {
            updates: [{ nodeId: "a", styles: { width: "140px" } }],
            nodeIds: ["a", "b"],
          });
          measuredWidths = measured.map((detail: { styles: { width: string } }) => detail.styles.width);
        } catch (caught) {
          detailsError = (caught as Error).message;
        } finally {
          HTMLElement.prototype.getBoundingClientRect = originalRect;
        }
        return {
          beforeMeasure,
          sourceIntact: animationStyle.isConnected && animationStyle.sheet === animationSheet &&
            animationSheet.cssRules[0] === animationRule && animationStyle.textContent === animationText,
          detailsError,
          detailsReadThrew: thrown,
          measuredWidths,
          detachedDuringRead: detachedDuringRead.map((state) => ({
            target: state.target === a ? "a" : "b",
            effectNull: state.effectNull,
            originalTarget: state.originalTarget,
          })),
          animations: cssAnimations.map((animation, index) => {
            const target = index === 0 ? a : b;
            const effect = effects[index];
            const listedAnimations = target
              .getAnimations()
              .filter((entry) => entry.constructor.name === "CSSAnimation");
            return {
              count: listedAnimations.length,
              listed: listedAnimations.includes(animation!),
              effect: animation!.effect === effect,
              target: (effect as KeyframeEffect | null)?.target === target,
              currentTime: animation!.currentTime,
              playState: animation!.playState,
            };
          }),
          restoredWidths: [getComputedStyle(a).width, getComputedStyle(b).width],
        };
      }, outcome);

      expect(result.beforeMeasure).toEqual([
        { listed: true, currentTime: 5000, playState: "paused" },
        { listed: true, currentTime: 5000, playState: "paused" },
      ]);
      expect(result.sourceIntact).toBe(true);
      if (outcome === "success") {
        expect(result.measuredWidths).toEqual(["140px", "100px"]);
        expect(result.detailsError).toBeNull();
      } else {
        expect(result.measuredWidths).toBeNull();
        expect(result.detailsReadThrew).toBe(true);
        expect(result.detailsError).toBe("Injected details read failure.");
      }
      expect(result.detachedDuringRead.length).toBeGreaterThan(0);
      expect(
        result.detachedDuringRead.every((state) => state.effectNull && state.originalTarget),
        JSON.stringify(result),
      ).toBe(true);
      expect(result.animations).toEqual([
        { count: 1, listed: true, effect: true, target: true, currentTime: 5000, playState: "paused" },
        { count: 1, listed: true, effect: true, target: true, currentTime: 5000, playState: "paused" },
      ]);
      expect(result.restoredWidths).toEqual(["150px", "150px"]);
    },
  );

  it.each(["pending", "null currentTime"] as const)(
    "rejects an animation with %s before measurement writes",
    async (state) => {
      const result = await page.evaluate(async (animationState) => {
        const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
        const b = document.querySelector<HTMLElement>('[data-oid="b"]')!;
        await window.layoutRequest("previewStyles", {
          nodeId: "b",
          styles: { width: "150px" },
        });
        const baselineSnapshot = await window.layoutRequest("getSnapshot", {});
        const animation = a.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 10000,
          fill: "both",
        });
        animation.pause();
        animation.currentTime = 2500;
        const effect = animation.effect as KeyframeEffect;
        let restoreGetAnimations: (() => void) | null = null;
        if (animationState === "pending") {
          Object.defineProperty(animation, "pending", {
            configurable: true,
            get: () => true,
          });
        } else {
          animation.cancel();
          const descriptor = Object.getOwnPropertyDescriptor(document, "getAnimations");
          const original = document.getAnimations;
          document.getAnimations = function () {
            return original.call(document).concat(animation);
          };
          restoreGetAnimations = () => {
            if (descriptor) Object.defineProperty(document, "getAnimations", descriptor);
            else delete (document as unknown as { getAnimations?: typeof document.getAnimations }).getAnimations;
          };
        }
        let error: string | null = null;
        try {
          await window.layoutRequest("measureLayout", {
            updates: [{ nodeId: "a", styles: { width: "140px" } }],
            nodeIds: ["a"],
          });
        } catch (caught) {
          error = (caught as Error).message;
        } finally {
          restoreGetAnimations?.();
        }
        const snapshot = await window.layoutRequest("getSnapshot", {});
        return {
          error,
          targetPreserved: effect.target === a,
          currentTime: animation.currentTime,
          aWidth: a.style.width,
          bWidth: b.style.width,
          previewWidth: getComputedStyle(b).width,
          revisionUnchanged: snapshot.sourceVersion === baselineSnapshot.sourceVersion,
        };
      }, state);

      expect(result.error).toBe(
        "Layout measurement cannot safely preserve a pending animation or one without a current time. Wait for it to settle and retry.",
      );
      expect(result.targetPreserved).toBe(true);
      if (state === "pending") expect(result.currentTime).toBe(2500);
      else expect(result.currentTime).toBeNull();
      expect(result.aWidth).toBe("100px");
      expect(result.bWidth).toBe("150px");
      expect(result.previewWidth).toBe("150px");
      expect(result.revisionUnchanged).toBe(true);
    },
  );

  it.each(["success", "details throw"] as const)("preserves finished CSSAnimation isolation on %s", async (outcome) => {
    const result = await page.evaluate(async (measurementOutcome) => {
      await window.layoutRequest("setPlayback", { sessionId: "finished-css", playing: true });
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      const started = new Promise<void>((resolve) => {
        document.addEventListener("animationstart", function onStart(event) {
          if (event.target !== a || event.animationName !== "layout-finished-css-width") return;
          document.removeEventListener("animationstart", onStart, true);
          resolve();
        }, true);
      });
      const style = document.createElement("style");
      style.textContent =
        "@keyframes layout-finished-css-width{from{width:100px}to{width:200px}}" +
        "[data-oid='a']{animation:layout-finished-css-width 10s linear 1 forwards}";
      document.head.append(style);
      void getComputedStyle(a).width;
      const animation = a
        .getAnimations()
        .find((entry) => entry.constructor.name === "CSSAnimation");
      if (!animation) throw new Error("Expected a CSS animation.");
      await started;
      animation.finish();
      const effect = animation.effect;
      const currentTime = animation.currentTime;
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      let detailsReads = 0;
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (this === a && a.style.width === "140px") {
          detailsReads += 1;
          if (measurementOutcome === "details throw" && detailsReads === 1) throw new Error("Injected details read failure.");
        }
        return originalRect.call(this);
      };
      let error: string | null = null;
      let measuredWidth: string | null = null;
      try {
        const measured = await window.layoutRequest("measureLayout", {
          updates: [{ nodeId: "a", styles: { width: "140px" } }],
          nodeIds: ["a"],
        });
        measuredWidth = measured[0].styles.width;
      } catch (caught) {
        error = (caught as Error).message;
      } finally {
        HTMLElement.prototype.getBoundingClientRect = originalRect;
      }
      return {
        error,
        measuredWidth,
        detailsReads,
        listed: a.getAnimations().includes(animation),
        count: a.getAnimations().filter((entry) => entry.constructor.name === "CSSAnimation").length,
        effect: animation.effect === effect,
        target: (effect as KeyframeEffect | null)?.target === a,
        currentTime: animation.currentTime,
        expectedCurrentTime: currentTime,
        playState: animation.playState,
        width: getComputedStyle(a).width,
      };
    }, outcome);

    expect(result.error, JSON.stringify(result)).toBe(outcome === "success" ? null : "Injected details read failure.");
    expect(result.measuredWidth).toBe(outcome === "success" ? "140px" : null);
    expect(result.detailsReads).toBeGreaterThan(0);
    expect(result.listed, JSON.stringify(result)).toBe(true);
    expect(result.count).toBe(1);
    expect(result.effect).toBe(true);
    expect(result.target).toBe(true);
    expect(result.currentTime).toBe(result.expectedCurrentTime);
    expect(result.playState).toBe("finished");
    expect(result.width).toBe("200px");
  });

  it.each(["success", "details throw"] as const)(
    "preserves finished fill-forward WAAPI animations through a measurement %s",
    async (outcome) => {
      const result = await page.evaluate(async (measurementOutcome) => {
        const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
        const b = document.querySelector<HTMLElement>('[data-oid="b"]')!;
        const animation = b.animate(
          [{ width: "100px" }, { width: "200px" }],
          { duration: 10000, fill: "forwards" },
        );
        animation.finish();
        const effect = animation.effect;
        const currentTime = animation.currentTime;
        const detachedDuringRead: Array<{ effectNull: boolean; target: boolean }> = [];
        const originalRect = HTMLElement.prototype.getBoundingClientRect;
        let proposedRead = false;
        let thrown = false;
        let detailsError: string | null = null;
        let confirmedWidths: string[] | null = null;
        let proposedWidths: string[] | null = null;
        HTMLElement.prototype.getBoundingClientRect = function () {
          if (this === a && proposedRead && measurementOutcome === "details throw" && !thrown) {
            thrown = true;
            throw new Error("Injected details read failure.");
          }
          if (this === a) {
            detachedDuringRead.push({
              effectNull: animation.effect === null,
              target: (effect as KeyframeEffect | null)?.target === b,
            });
          }
          return originalRect.call(this);
        };
        try {
          const confirmed = await window.layoutRequest("measureLayout", {
            updates: [],
            nodeIds: ["a", "b"],
          });
          confirmedWidths = confirmed.map((detail: { styles: { width: string } }) => detail.styles.width);
          proposedRead = true;
          const proposed = await window.layoutRequest("measureLayout", {
            updates: [{ nodeId: "a", styles: { width: "140px" } }],
            nodeIds: ["a", "b"],
          });
          proposedWidths = proposed.map((detail: { styles: { width: string } }) => detail.styles.width);
        } catch (caught) {
          detailsError = (caught as Error).message;
        } finally {
          HTMLElement.prototype.getBoundingClientRect = originalRect;
        }
        return {
          confirmedWidths,
          proposedWidths,
          detailsError,
          detailsReadThrew: thrown,
          detachedDuringRead,
          listed: b.getAnimations().includes(animation),
          effect: animation.effect === effect,
          target: (effect as KeyframeEffect | null)?.target === b,
          currentTime: animation.currentTime,
          expectedCurrentTime: currentTime,
          playState: animation.playState,
          restoredWidths: [getComputedStyle(a).width, getComputedStyle(b).width],
        };
      }, outcome);

      expect(result.confirmedWidths).toEqual(["100px", "100px"]);
      expect(result.detachedDuringRead.length).toBeGreaterThanOrEqual(2);
      expect(result.detachedDuringRead.every((state) => state.effectNull && state.target)).toBe(true);
      expect(result.listed).toBe(true);
      expect(result.effect).toBe(true);
      expect(result.target).toBe(true);
      expect(result.currentTime).toBe(result.expectedCurrentTime);
      expect(result.playState).toBe("finished");
      expect(result.restoredWidths).toEqual(["100px", "200px"]);
      if (outcome === "success") {
        expect(result.proposedWidths).toEqual(["140px", "100px"]);
        expect(result.detailsError).toBeNull();
      } else {
        expect(result.proposedWidths).toBeNull();
        expect(result.detailsReadThrew).toBe(true);
        expect(result.detailsError).toBe("Injected details read failure.");
      }
    },
  );

  it.each([
    { previewKind: "stylesheet", outcome: "success" },
    { previewKind: "stylesheet", outcome: "details throw" },
    { previewKind: "options", outcome: "success" },
    { previewKind: "options", outcome: "details throw" },
    { previewKind: "animation-name", outcome: "reject" },
    { previewKind: "same-animation-name", outcome: "success" },
    { previewKind: "clear-animation-name", outcome: "reject" },
    { previewKind: "absent-animation-name", outcome: "reject" },
  ] as const)(
    "preserves CSSAnimation identity through $previewKind isolation and $outcome",
    async ({ previewKind, outcome }) => {
      const result = await page.evaluate(
          async ({ kind, measurementOutcome }) => {
            const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
            await window.layoutRequest("setPlayback", {
              sessionId: "css-animation-measurement",
              playing: true,
            });
            const expectedName = kind === "clear-animation-name" ? "layout-motion-alternate" : "layout-motion-source";
            if (kind === "clear-animation-name") a.style.animationName = expectedName;
            const started = new Promise<void>((resolve) => {
              document.addEventListener("animationstart", function onStart(event) {
                if (event.target !== a || event.animationName !== expectedName) return;
                document.removeEventListener("animationstart", onStart, true);
                resolve();
              }, true);
            });
            const source = document.createElement("style");
            source.setAttribute("data-zeros-source", "motion.css");
            const sourceCss =
              "@keyframes layout-motion-source{from{opacity:.2}to{opacity:.8}}" +
              "@keyframes layout-motion-alternate{from{opacity:.1}to{opacity:.9}}" +
              ":root{--zd-motion-color:red}" +
              "[data-oid='a']{animation-name:layout-motion-source;animation-duration:10s;" +
              "animation-timing-function:linear;animation-iteration-count:infinite;" +
              "color:var(--zd-motion-color)}";
            const previewCss = sourceCss.replace(
              "color:var(--zd-motion-color)",
              "color:blue",
            );
            source.textContent = sourceCss;
            document.head.append(source);
            void getComputedStyle(a).animationName;
            const originalAnimation = a
              .getAnimations()
              .find((animation) => animation.constructor.name === "CSSAnimation");
            if (!originalAnimation) throw new Error("Expected a CSS animation.");
            originalAnimation.pause();
            originalAnimation.currentTime = 5000;
            await started;
            const originalEffect = originalAnimation.effect;
            const stateOf = (animation: Animation) => ({
              count: a
                .getAnimations()
                .filter((entry) => entry.constructor.name === "CSSAnimation").length,
              listed: a.getAnimations().includes(animation),
              effect: animation.effect === originalEffect,
              target: (originalEffect as KeyframeEffect | null)?.target === a,
              time: animation.currentTime,
              playState: animation.playState,
              animations: a
                .getAnimations()
                .filter((entry) => entry.constructor.name === "CSSAnimation")
                .map((entry) => ({
                  name: (entry as CSSAnimation).animationName,
                  listed: entry === originalAnimation,
                  playState: entry.playState,
                  time: entry.currentTime,
                  target: (entry.effect as KeyframeEffect | null)?.target === a,
                })),
            });
            const beforePreview = stateOf(originalAnimation);

            if (kind === "stylesheet") {
              await window.layoutRequest("previewStylesheet", {
                file: "motion.css",
                css: previewCss,
              });
            } else if (kind === "options") {
              await window.layoutRequest("previewComponentOptions", {
                properties: { "--zd-motion-color": "blue" },
              });
            }

            const beforeMeasure = stateOf(originalAnimation);
            const originalRect = HTMLElement.prototype.getBoundingClientRect;
            let proposedRead = false;
            let thrown = false;
            let detailsError: string | null = null;
            let measuredWidth: string | null = null;
            const detachedDuringRead: Array<{
              effectNull: boolean;
              originalEffectTarget: boolean;
              listed: boolean;
              count: number;
              names: string[];
            }> = [];
            HTMLElement.prototype.getBoundingClientRect = function () {
              if (this === a && proposedRead) {
                const animations = a
                  .getAnimations()
                  .filter((entry) => entry.constructor.name === "CSSAnimation");
                detachedDuringRead.push({
                  effectNull: originalAnimation.effect === null,
                  originalEffectTarget: (originalEffect as KeyframeEffect | null)?.target === a,
                  listed: animations.includes(originalAnimation),
                  count: animations.length,
                  names: animations.map((entry) => (entry as CSSAnimation).animationName),
                });
              }
              if (this === a && proposedRead && measurementOutcome === "details throw" && !thrown) {
                thrown = true;
                throw new Error("Injected details read failure.");
              }
              return originalRect.call(this);
            };
            try {
              proposedRead = true;
              const styles =
                kind === "animation-name"
                  ? { "animation-name": "layout-motion-alternate", width: "140px" }
                  : kind === "same-animation-name"
                    ? { "animation-name": "layout-motion-source", width: "140px" }
                  : kind === "clear-animation-name" || kind === "absent-animation-name"
                    ? { "animation-name": null, width: "140px" }
                  : { width: "140px" };
              const measured = await window.layoutRequest("measureLayout", {
                updates: [{ nodeId: "a", styles }],
                nodeIds: ["a"],
              });
              measuredWidth = measured[0].styles.width;
            } catch (caught) {
              detailsError = (caught as Error).message;
            } finally {
              HTMLElement.prototype.getBoundingClientRect = originalRect;
            }

            const after = stateOf(originalAnimation);
            return {
              beforePreview,
              beforeMeasure,
              after,
              detailsError,
              detailsReadThrew: thrown,
              measuredWidth,
              detachedDuringRead,
              previewStillActive:
                kind === "stylesheet"
                  ? source.textContent === previewCss
                  : kind === "options"
                    ? getComputedStyle(document.documentElement)
                        .getPropertyValue("--zd-motion-color")
                        .trim() === "blue"
                    : true,
              animationName: getComputedStyle(a).animationName,
            };
          },
          { kind: previewKind, measurementOutcome: outcome },
        );

        expect(result.beforePreview).toEqual({
          count: 1,
          listed: true,
          effect: true,
          target: true,
          time: 5000,
          playState: "paused",
          animations: [
            {
              name: previewKind === "clear-animation-name" ? "layout-motion-alternate" : "layout-motion-source",
              listed: true,
              playState: "paused",
              time: 5000,
              target: true,
            },
          ],
        });
        expect(result.beforeMeasure).toEqual(result.beforePreview);
        expect(result.after, JSON.stringify(result)).toEqual(result.beforePreview);
        expect(result.previewStillActive).toBe(true);
        expect(result.animationName).toBe(previewKind === "clear-animation-name" ? "layout-motion-alternate" : "layout-motion-source");
        if (outcome === "reject") {
          expect(result.detachedDuringRead).toEqual([]);
          expect(result.measuredWidth).toBeNull();
          expect(result.detailsError).toBe(
            "Layout measurement cannot safely preserve a CSS animation when changing animation-name on its target. Measure without changing animation-name, then apply that edit separately.",
          );
          expect(result.detailsReadThrew).toBe(false);
        } else {
          expect(result.detachedDuringRead.length).toBeGreaterThan(0);
          expect(
            result.detachedDuringRead.every(
              (state) => state.effectNull && state.originalEffectTarget,
            ),
          ).toBe(true);
        }
        if (outcome === "success") {
          expect(result.measuredWidth).toBe("140px");
          expect(result.detailsError).toBeNull();
          expect(result.detailsReadThrew).toBe(false);
        } else if (outcome === "details throw") {
          expect(result.measuredWidth).toBeNull();
          expect(result.detailsError).toBe("Injected details read failure.");
          expect(result.detailsReadThrew).toBe(true);
        }
    },
  );

  it("allows animation-name measurement when the target has no CSSAnimation", async () => {
    const result = await page.evaluate(async () => {
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      const beforeAnimationName = getComputedStyle(a).animationName;
      const beforeCssAnimationCount = a
        .getAnimations()
        .filter((animation) => animation.constructor.name === "CSSAnimation").length;
      const measured = await window.layoutRequest("measureLayout", {
        updates: [
          {
            nodeId: "a",
            styles: { "animation-name": "layout-measure-name", width: "140px" },
          },
        ],
        nodeIds: ["a"],
      });
      return {
        measuredWidth: measured[0].styles.width,
        beforeAnimationName,
        afterAnimationName: getComputedStyle(a).animationName,
        beforeCssAnimationCount,
        afterCssAnimationCount: a
          .getAnimations()
          .filter((animation) => animation.constructor.name === "CSSAnimation").length,
      };
    });

    expect(result.measuredWidth).toBe("140px");
    expect(result.beforeAnimationName).toBe(result.afterAnimationName);
    expect(result.beforeCssAnimationCount).toBe(0);
    expect(result.afterCssAnimationCount).toBe(0);
  });

  it("restores later animations and preview state after one animation setter throws", async () => {
    const result = await page.evaluate(async () => {
      const a = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      const b = document.querySelector<HTMLElement>('[data-oid="b"]')!;
      await window.layoutRequest("previewStyles", {
        nodeId: "b",
        styles: { width: "150px" },
      });
      const baselineSnapshot = await window.layoutRequest("getSnapshot", {});
      const first = a.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 10000,
        fill: "both",
      });
      first.pause();
      first.currentTime = 2500;
      const later = b.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 10000,
        fill: "both",
      });
      later.pause();
      later.currentTime = 3500;
      const firstEffect = first.effect as KeyframeEffect;
      const laterEffect = later.effect as KeyframeEffect;
      const effectDescriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(first),
        "effect",
      )!;
      let throwOnRestore = true;
      Object.defineProperty(first, "effect", {
        configurable: true,
        get() {
          return effectDescriptor.get!.call(first);
        },
        set(value: AnimationEffect | null) {
          if (value === firstEffect && throwOnRestore) {
            throwOnRestore = false;
            throw new Error("Injected animation effect restoration failure.");
          }
          effectDescriptor.set!.call(first, value);
        },
      });
      let error: string | null = null;
      try {
        await window.layoutRequest("measureLayout", {
          updates: [{ nodeId: "a", styles: { width: "140px" } }],
          nodeIds: ["a", "b"],
        });
      } catch (caught) {
        error = (caught as Error).message;
      }
      const snapshot = await window.layoutRequest("getSnapshot", {});
      delete (first as unknown as { effect?: AnimationEffect | null }).effect;
      return {
        error,
        laterTargetRestored: laterEffect.target === b,
        laterTime: later.currentTime,
        laterPlayState: later.playState,
        previewWidth: getComputedStyle(b).width,
        inlineWidth: b.style.width,
        proposedWidthRestored: a.style.width,
        revisionUnchanged: snapshot.sourceVersion === baselineSnapshot.sourceVersion,
      };
    });

    expect(result.error).toBe("Injected animation effect restoration failure.");
    expect(result.laterTargetRestored).toBe(true);
    expect(result.laterTime).toBe(3500);
    expect(result.laterPlayState).toBe("paused");
    expect(result.previewWidth).toBe("150px");
    expect(result.inlineWidth).toBe("150px");
    expect(result.proposedWidthRestored).toBe("100px");
    expect(result.revisionUnchanged).toBe(true);
  });

  it.each([
    { scope: "stylesheet", outcome: "success" },
    { scope: "stylesheet", outcome: "details throw" },
    { scope: "inline", outcome: "success" },
    { scope: "inline", outcome: "details throw" },
    { scope: "shadow", outcome: "success" },
    { scope: "shadow", outcome: "details throw" },
  ] as const)(
    "prevents $scope important transitions through $outcome measurement",
    async ({ scope, outcome }) => {
      const result = await page.evaluate(async ({ scope, outcome }) => {
        let target: HTMLElement;
        let styleElement: HTMLStyleElement | null = null;
        if (scope === "shadow") {
          const host = document.createElement("div");
          document.body.append(host);
          const shadow = host.attachShadow({ mode: "open" });
          shadow.innerHTML =
            "<style>[data-oid='shadow-a']{transition:width 30s linear!important}</style>" +
            "<div data-oid='shadow-a' style='width:100px;height:20px'></div>";
          styleElement = shadow.querySelector("style");
          target = shadow.querySelector<HTMLElement>('[data-oid="shadow-a"]')!;
          await window.layoutRequest("getSnapshot", {});
        } else {
          target = document.querySelector<HTMLElement>('[data-oid="a"]')!;
          if (scope === "stylesheet") {
            styleElement = document.createElement("style");
            styleElement.textContent =
              "[data-oid='a']{transition:width 30s linear!important}";
            document.head.append(styleElement);
          } else {
            target.style.setProperty(
              "transition",
              "width 30s linear",
              "important",
            );
          }
        }
        void target.offsetWidth;
        const beforeTransitions = target
          .getAnimations()
          .filter((animation) => animation.constructor.name === "CSSTransition")
          .length;
        const beforeStyle = target.getAttribute("style");
        const beforeRule = styleElement?.sheet?.cssRules[0] ?? null;
        const beforeRuleText = beforeRule?.cssText ?? null;
        let measuredWidth: string | null = null;
        let resultWidth: string | null = null;
        let error: string | null = null;
        let thrown = false;
        const originalRect = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function () {
          if (this === target) {
            measuredWidth = getComputedStyle(target).width;
            if (outcome === "details throw" && !thrown) {
              thrown = true;
              throw new Error("Injected details read failure.");
            }
          }
          return originalRect.call(this);
        };
        try {
          const measured = await window.layoutRequest("measureLayout", {
            updates: [{ nodeId: scope === "shadow" ? "shadow-a" : "a", styles: { width: "140px" } }],
            nodeIds: [scope === "shadow" ? "shadow-a" : "a"],
          });
          resultWidth = measured[0].styles.width;
        } catch (caught) {
          error = (caught as Error).message;
        } finally {
          HTMLElement.prototype.getBoundingClientRect = originalRect;
        }
        return {
          beforeTransitions,
          measuredWidth,
          resultWidth,
          error,
          beforeStyle,
          afterStyle: target.getAttribute("style"),
          afterWidth: getComputedStyle(target).width,
          afterTransitions: target
            .getAnimations()
            .filter((animation) => animation.constructor.name === "CSSTransition")
            .length,
          sameRule: beforeRule === (styleElement?.sheet?.cssRules[0] ?? null),
          beforeRuleText,
          afterRuleText: styleElement?.sheet?.cssRules[0]?.cssText ?? null,
        };
      }, { scope, outcome });
      expect(result).toMatchObject({
        beforeTransitions: 0,
        measuredWidth: "140px",
        afterStyle: result.beforeStyle,
        afterWidth: "100px",
        afterTransitions: 0,
        sameRule: true,
        beforeRuleText: result.afterRuleText,
      });
      if (outcome === "success") {
        expect(result.resultWidth).toBe("140px");
        expect(result.error).toBeNull();
      } else {
        expect(result.resultWidth).toBeNull();
        expect(result.error).toBe("Injected details read failure.");
      }
      if (scope === "inline") {
        expect(result.afterStyle).toContain("transition: width 30s linear !important");
      }
    },
  );

  it.each(["success", "details throw"] as const)(
    "keeps open-shadow child selectors stable during a measurement %s",
    async (outcome) => {
    const result = await page.evaluate(async (measurementOutcome) => {
      const host = document.createElement("div");
      document.body.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(
        "[data-oid='shadow-first']{width:100px}" +
          "[data-oid='shadow-first']:first-child{width:200px}",
      );
      shadow.adoptedStyleSheets = [sheet];
      const target = document.createElement("div");
      target.dataset.oid = "shadow-first";
      target.style.height = "20px";
      shadow.append(target);
      await window.layoutRequest("getSnapshot", {});
      const beforeWidth = getComputedStyle(target).width;
      const beforeRule = sheet.cssRules[0];
      const beforeChildren = Array.from(shadow.childNodes);
      let widthDuringRead: string | null = null;
      let firstChildDuringRead: boolean | null = null;
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      let thrown = false;
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (this === target) {
          widthDuringRead = getComputedStyle(target).width;
          firstChildDuringRead = target.matches(":first-child");
          if (measurementOutcome === "details throw" && !thrown) {
            thrown = true;
            throw new Error("Injected details read failure.");
          }
        }
        return originalRect.call(this);
      };
      let measuredWidth: string | null = null;
      let detailsError: string | null = null;
      try {
        const measured = await window.layoutRequest("measureLayout", {
          updates: [{ nodeId: "shadow-first", styles: { height: "40px" } }],
          nodeIds: ["shadow-first"],
        });
        measuredWidth = measured[0].styles.width;
      } catch (caught) {
        detailsError = (caught as Error).message;
      } finally {
        HTMLElement.prototype.getBoundingClientRect = originalRect;
      }
      return {
        beforeWidth,
        widthDuringRead,
        firstChildDuringRead,
        measuredWidth,
        detailsError,
        afterWidth: getComputedStyle(target).width,
        afterFirstChild: target.matches(":first-child"),
        sameSheet: shadow.adoptedStyleSheets[0] === sheet,
        sameChildren:
          beforeChildren.length === shadow.childNodes.length &&
          beforeChildren.every((child, index) => shadow.childNodes[index] === child),
        sameRule: sheet.cssRules[0] === beforeRule,
      };
    }, outcome);
    expect(result).toEqual({
      beforeWidth: "200px",
      widthDuringRead: "200px",
      firstChildDuringRead: true,
      measuredWidth: outcome === "success" ? "200px" : null,
      detailsError: outcome === "success" ? null : "Injected details read failure.",
      afterWidth: "200px",
      afterFirstChild: true,
      sameSheet: true,
      sameChildren: true,
      sameRule: true,
    });
  },
  );

  it("isolates an inherited descendant's transition when the first stylesheet is print-only", async () => {
    const result = await page.evaluate(async () => {
      const target = document.querySelector<HTMLElement>('[data-oid="a"]')!;
      const print = document.createElement("style");
      print.media = "print";
      print.textContent = ".print-only{color:red}";
      document.head.prepend(print);
      const screen = document.createElement("style");
      screen.textContent = ".inherits{display:block;width:10em;height:4px;transition:width 30s linear}";
      document.head.append(screen);
      const kid = document.createElement("div");
      kid.className = "inherits";
      target.append(kid);
      target.style.fontSize = "16px";
      void kid.offsetWidth;
      let kidWidth: string | null = null;
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (this === target) kidWidth = getComputedStyle(kid).width;
        return originalRect.call(this);
      };
      try {
        await window.layoutRequest("measureLayout", {
          updates: [{ nodeId: "a", styles: { "font-size": "20px" } }],
          nodeIds: ["a"],
        });
      } finally {
        HTMLElement.prototype.getBoundingClientRect = originalRect;
        kid.remove();
        print.remove();
        screen.remove();
        target.style.removeProperty("font-size");
      }
      return { kidWidth };
    });
    expect(result.kidWidth).toBe("200px");
  });

  it("rejects an active transition in an open shadow scope before measurement writes", async () => {
    const result = await page.evaluate(async () => {
      const host = document.createElement("div");
      document.body.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML =
        "<style>[data-oid='shadow-a']{transition:width 30s linear}</style>" +
        "<div data-oid='shadow-a' style='width:100px;height:20px'></div>";
      const target = shadow.querySelector<HTMLElement>('[data-oid="shadow-a"]')!;
      await window.layoutRequest("getSnapshot", {});
      void target.offsetWidth;
      target.style.width = "200px";
      void target.offsetWidth;
      const transition = shadow
        .getAnimations()
        .find((animation) => animation.constructor.name === "CSSTransition");
      if (!transition) throw new Error("Expected a shadow CSS transition.");
      transition.pause();
      transition.currentTime = 5000;
      const beforeStyle = target.getAttribute("style");
      const beforeSnapshot = await window.layoutRequest("getSnapshot", {});
      let error: string | null = null;
      try {
        await window.layoutRequest("measureLayout", {
          updates: [{ nodeId: "shadow-a", styles: { width: "150px" } }],
          nodeIds: ["shadow-a"],
        });
      } catch (caught) {
        error = (caught as Error).message;
      }
      const afterSnapshot = await window.layoutRequest("getSnapshot", {});
      const afterTransition = shadow
        .getAnimations()
        .find((animation) => animation.constructor.name === "CSSTransition");
      return {
        error,
        beforeStyle,
        afterStyle: target.getAttribute("style"),
        sameTransition: transition === afterTransition,
        beforeTime: transition.currentTime,
        afterTime: afterTransition?.currentTime,
        afterPlayState: afterTransition?.playState,
        beforeRevision: beforeSnapshot.revision,
        afterRevision: afterSnapshot.revision,
      };
    });
    expect(result.error).toContain("Active CSS transitions prevent layout measurement");
    expect(result.afterStyle).toBe(result.beforeStyle);
    expect(result.sameTransition).toBe(true);
    expect(result.afterTime).toBe(5000);
    expect(result.afterPlayState).toBe("paused");
    expect(result.afterRevision).toBe(result.beforeRevision);
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
