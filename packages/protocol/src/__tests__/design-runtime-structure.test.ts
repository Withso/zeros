import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { mutateDesignNodeDuplicateSource } from "../../../design-web/src/html";
import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const markup = '<main data-oid="root"><section data-oid="a" style="width:120px;height:80px"><b data-oid="child">Hello</b><i data-oid="other">World</i></section><aside data-oid="last">Last</aside></main>';
beforeEach(async () => {
  await page?.close();
  page = await browser.newPage();
  await page.setContent(markup);
  await page.evaluate(async source => {
    let generation = "a".repeat(24);
    Object.assign(window, { __zerosDesignSourceVersion: generation });
    const channel = new MessageChannel();
    let sequence = 0;
    const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const ready = new Promise<void>(resolve => {
      channel.port1.onmessage = ({ data }) => {
        if (data.event === "ready") resolve();
        if (data.type !== "response") return;
        const task = pending.get(data.requestId);
        pending.delete(data.requestId);
        if (data.ok) {
          if (data.result?.sourceVersion) generation = data.result.sourceVersion;
          task?.resolve(data.result);
        } else task?.reject(new Error(data.error?.message));
      };
    });
    Object.assign(window, { structureRequest: (method: string, args: unknown) => new Promise((resolve, reject) => {
      const requestId = String(++sequence);
      pending.set(requestId, { resolve, reject });
      channel.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request", sourceVersion: generation, requestId, method, args });
    }) });
    new Function(source)();
    window.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake", sourceVersion: generation,
      features: ["commitStructure", "previewStructure", "clearPreviewStructure"] }, "*", [channel.port2]);
    await ready;
  }, DESIGN_RUNTIME_SOURCE);
});

type StructureWindow = Window & { structureRequest(method: string, args: unknown): Promise<any> };

describe("in-place structural generation adoption", () => {
  it("bounds the total projected document before admitting a copy", async () => {
    const result = await page.evaluate(async () => {
      const root = document.querySelector('[data-oid="root"]')!;
      root.innerHTML = '<section data-oid="a"><b data-oid="child">Hello</b></section>' +
        Array.from({ length: 19_997 }, (_, index) => `<span data-oid="n${index}"></span>`).join("");
      const before = root.childElementCount;
      let refused = false;
      try { await (window as unknown as StructureWindow).structureRequest("previewStructure", {
        previewId: "full", operations: [{ type: "duplicate", nodeId: "a", duplicateNodeId: "overflow" }],
      }); } catch { refused = true; }
      return { refused, same: root.childElementCount === before, copy: !!document.querySelector('[data-oid="overflow"]') };
    });
    expect(result).toEqual({ refused: true, same: true, copy: false });
  });

  it("retains an unfinished copy's placement through snapshots and unrelated commits", async () => {
    const result = await page.evaluate(async () => {
      const ask = (window as unknown as StructureWindow).structureRequest;
      await ask("previewStructure", { previewId: "drag", operations: [{ type: "duplicate", nodeId: "child", duplicateNodeId: "copy" }] });
      await ask("previewLayout", { updates: [{ nodeId: "copy", styles: { position: "absolute", left: "98px" } }],
        moves: [{ nodeId: "copy", parentId: "root", beforeId: "last" }], nodeIds: [] });
      await ask("getSnapshot", {});
      const afterSnapshot = (document.querySelector('[data-oid="copy"]') as HTMLElement).style.left;
      await ask("commitStyles", { updates: [{ nodeId: "last", styles: { width: "100px" } }], nextSourceVersion: "b".repeat(24) });
      const copy = document.querySelector('[data-oid="copy"]') as HTMLElement;
      const retained = { left: copy.style.left, parent: copy.parentElement?.getAttribute("data-oid") };
      await ask("clearPreviewStructure", { previewId: "drag" });
      return { afterSnapshot, retained, cleared: !document.querySelector('[data-oid="copy"]'),
        original: document.querySelector('[data-oid="child"]')?.parentElement?.getAttribute("data-oid") };
    });
    expect(result).toEqual({ afterSnapshot: "98px", retained: { left: "98px", parent: "root" }, cleared: true, original: "a" });
  });

  it("keeps explicit snapshots authoritative while a structural preview is visible", async () => {
    const result = await page.evaluate(async () => {
      const ask = (window as unknown as StructureWindow).structureRequest;
      await ask("previewStructure", { previewId: "pending", operations: [{ type: "duplicate", nodeId: "a", duplicateNodeId: "pending" }] });
      const snapshot = await ask("getSnapshot", {});
      return { ids: snapshot.tree[0].children.map((node: { oid: string }) => node.oid), painted: !!document.querySelector('[data-oid="pending"]') };
    });
    expect(result).toEqual({ ids: ["a", "last"], painted: true });
  });

  it("copies and places a subtree in one generation with exact undo and redo", async () => {
    const result = await page.evaluate(async () => {
      const ask = (window as unknown as StructureWindow).structureRequest;
      const original = document.querySelector('[data-oid="child"]');
      const operations = [{ type: "duplicate", nodeId: "child", duplicateNodeId: "copy" }];
      await ask("previewStructure", { previewId: "drag", operations });
      await ask("previewLayout", { updates: [{ nodeId: "copy", styles: { position: "absolute", left: "40px" } }],
        moves: [{ nodeId: "copy", parentId: "root", beforeId: "last" }], nodeIds: [] });
      await ask("commitStructure", { updates: [{ nodeId: "copy", styles: { position: "absolute", left: "40px" } }], nextSourceVersion: "b".repeat(24),
        patch: { structure: operations, structurePreviewId: "drag", moves: [{ nodeId: "copy", parentId: "root", beforeId: "last" }] } });
      const copy = document.querySelector('[data-oid="copy"]');
      const placed = copy?.parentElement?.getAttribute("data-oid") === "root" && (copy as HTMLElement).style.left === "40px";
      await ask("restoreGeneration", { targetSourceVersion: "a".repeat(24), commit: true });
      const undone = !copy?.isConnected && original === document.querySelector('[data-oid="child"]');
      await ask("restoreGeneration", { targetSourceVersion: "b".repeat(24), commit: true });
      return { placed, undone, same: copy === document.querySelector('[data-oid="copy"]'), parent: copy?.parentElement?.getAttribute("data-oid") };
    });
    expect(result).toEqual({ placed: true, undone: true, same: true, parent: "root" });
  });

  it("accepts the source adapter's printable node identities", async () => {
    const id = '_copy “Résumé”';
    const expected = mutateDesignNodeDuplicateSource(markup, "a", id);
    const result = await page.evaluate(async id => {
      await (window as unknown as StructureWindow).structureRequest("commitStructure", { updates: [], nextSourceVersion: "b".repeat(24),
        patch: { structure: [{ type: "duplicate", nodeId: "a", duplicateNodeId: id }] } });
      return document.querySelector('[data-oid="root"]')!.outerHTML;
    }, id);
    expect(result).toBe(expected);
  });

  it("paints repeated copies before persistence without exposing them as confirmed commit state", async () => {
    const result = await page.evaluate(async () => {
      const ask = (window as unknown as StructureWindow).structureRequest;
      const one = [{ type: "duplicate", nodeId: "a", duplicateNodeId: "one" }];
      const two = [{ type: "duplicate", nodeId: "a", duplicateNodeId: "two" }];
      await ask("previewStructure", { previewId: "first", operations: one });
      await ask("previewStructure", { previewId: "second", operations: two });
      const painted = !!document.querySelector('[data-oid="one"]') && !!document.querySelector('[data-oid="two"]');
      const committed = await ask("commitStructure", { updates: [], nextSourceVersion: "b".repeat(24), patch: { structure: one, structurePreviewId: "first" } });
      const retained = !!document.querySelector('[data-oid="one"]') && !!document.querySelector('[data-oid="two"]');
      await ask("clearPreviewStructure", { previewId: "second" });
      return { painted, retained, confirmed: committed.snapshot.tree[0].children.map((node: { oid: string }) => node.oid),
        cancelled: !document.querySelector('[data-oid="two"]') && !!document.querySelector('[data-oid="one"]') };
    });
    expect(result).toEqual({ painted: true, retained: true, confirmed: ["a", "one", "last"], cancelled: true });
  });

  it("rolls back a speculative deletion exactly and retains it through an unrelated save", async () => {
    const result = await page.evaluate(async () => {
      const ask = (window as unknown as StructureWindow).structureRequest;
      const child = document.querySelector('[data-oid="child"]');
      await ask("previewStructure", { previewId: "remove", operations: [{ type: "delete", nodeId: "child" }] });
      const hidden = !child?.isConnected;
      const committed = await ask("commitStyles", { updates: [{ nodeId: "a", styles: { width: "180px" } }], nextSourceVersion: "b".repeat(24) });
      const stillHidden = !child?.isConnected;
      await ask("clearPreviewStructure", { previewId: "remove" });
      return { hidden, stillHidden, restored: child === document.querySelector('[data-oid="child"]'),
        width: getComputedStyle(document.querySelector('[data-oid="a"]')!).width, generation: committed.sourceVersion };
    });
    expect(result).toEqual({ hidden: true, stillHidden: true, restored: true, width: "180px", generation: "b".repeat(24) });
  });

  it("bounds queued previews and releases their admission after cancellation", async () => {
    const result = await page.evaluate(async () => {
      const ask = (window as unknown as StructureWindow).structureRequest;
      for (let i = 0; i < 32; i++) await ask("previewStructure", { previewId: `copy-${i}`, operations: [{ type: "duplicate", nodeId: "a", duplicateNodeId: `copy-${i}` }] });
      let refused = false;
      try { await ask("previewStructure", { previewId: "overflow", operations: [{ type: "duplicate", nodeId: "a", duplicateNodeId: "overflow" }] }); }
      catch { refused = true; }
      await ask("clearPreviewStructure", {});
      const empty = document.querySelector('[data-oid="root"]')!.children.length === 2;
      await ask("previewStructure", { previewId: "again", operations: [{ type: "duplicate", nodeId: "a", duplicateNodeId: "again" }] });
      return { refused, empty, admitted: !!document.querySelector('[data-oid="again"]') };
    });
    expect(result).toEqual({ refused: true, empty: true, admitted: true });
  });

  it("duplicates the authored identities in place and retains DOM identity through undo/redo", async () => {
    const expected = mutateDesignNodeDuplicateSource(markup, "a", "copy");
    const result = await page.evaluate(async () => {
      const ask = (window as unknown as StructureWindow).structureRequest;
      const original = document.querySelector('[data-oid="a"]');
      const committed = await ask("commitStructure", { updates: [], nextSourceVersion: "b".repeat(24),
        patch: { structure: [{ type: "duplicate", nodeId: "a", duplicateNodeId: "copy" }] } });
      const copy = document.querySelector('[data-oid="copy"]');
      const html = document.querySelector('[data-oid="root"]')!.outerHTML;
      await ask("restoreGeneration", { targetSourceVersion: "a".repeat(24), commit: true });
      const undone = !copy?.isConnected && original === document.querySelector('[data-oid="a"]');
      await ask("restoreGeneration", { targetSourceVersion: "b".repeat(24), commit: true });
      return { html, undone, same: copy === document.querySelector('[data-oid="copy"]'),
        version: committed.sourceVersion, treeUnchanged: committed.treeUnchanged,
        details: committed.details.map((detail: { oid: string }) => detail.oid) };
    });
    expect(result).toEqual({ html: expected, undone: true, same: true, version: "b".repeat(24), treeUnchanged: false, details: ["copy"] });
  });

  it("deletes nested siblings atomically and restores their order and exact elements", async () => {
    const result = await page.evaluate(async () => {
      const ask = (window as unknown as StructureWindow).structureRequest;
      const root = document.querySelector('[data-oid="root"]')!;
      const before = root.innerHTML;
      const child = document.querySelector('[data-oid="child"]');
      await ask("commitStructure", { updates: [], nextSourceVersion: "b".repeat(24),
        patch: { structure: [{ type: "delete", nodeId: "child" }, { type: "delete", nodeId: "other" }] } });
      const empty = document.querySelector('[data-oid="a"]')!.children.length === 0;
      await ask("restoreGeneration", { targetSourceVersion: "a".repeat(24), commit: true });
      return { empty, restored: before === root.innerHTML, same: child === document.querySelector('[data-oid="child"]') };
    });
    expect(result).toEqual({ empty: true, restored: true, same: true });
  });

  it("validates an entire structural batch before changing any nodes or generation", async () => {
    const result = await page.evaluate(async () => {
      const ask = (window as unknown as StructureWindow).structureRequest;
      const before = document.querySelector('[data-oid="root"]')!.outerHTML;
      let rejected = false;
      try {
        await ask("commitStructure", { updates: [], nextSourceVersion: "b".repeat(24),
          patch: { structure: [{ type: "delete", nodeId: "child" }, { type: "delete", nodeId: "missing" }] } });
      } catch { rejected = true; }
      const snapshot = await ask("getSnapshot", {});
      return { rejected, same: document.querySelector('[data-oid="root"]')!.outerHTML === before, generation: snapshot.sourceVersion };
    });
    expect(result).toEqual({ rejected: true, same: true, generation: "a".repeat(24) });
  });

  it("keeps source identity collision rules for long descendant identifiers", async () => {
    const source = `<main data-oid="root"><section data-oid="a"><b data-oid="${"x".repeat(250)}">Long</b></section><i data-oid="copy-${"x".repeat(243)}">Collision</i></main>`;
    const expected = mutateDesignNodeDuplicateSource(source, "a", "copy");
    const result = await page.evaluate(async source => {
      document.querySelector('[data-oid="root"]')!.outerHTML = source;
      await (window as unknown as StructureWindow).structureRequest("getSnapshot", {});
      await (window as unknown as StructureWindow).structureRequest("commitStructure", { updates: [], nextSourceVersion: "b".repeat(24),
        patch: { structure: [{ type: "duplicate", nodeId: "a", duplicateNodeId: "copy" }] } });
      return document.querySelector('[data-oid="root"]')!.outerHTML;
    }, source);
    expect(result).toBe(expected);
  });
});
