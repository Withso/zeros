import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

let browser: Browser;
let page: Page;
beforeEach(async () => {
  browser = await chromium.launch({ headless: true }); page = await browser.newPage();
  await page.evaluate(async source => {
    document.body.innerHTML = '<main data-oid="root" style="display:block;width:300px;height:200px"><div data-oid="child" style="width:100px;height:50px"></div></main>';
    let generation = "a".repeat(24), sequence = 0;
    Object.assign(window, { __zerosDesignSourceVersion: generation });
    const port = new MessageChannel(); const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
    const ready = new Promise<void>(resolve => {
      port.port1.onmessage = ({ data }) => {
        if (data.event === "ready") { resolve(); return; }
        const task = pending.get(data.requestId); if (!task) return; pending.delete(data.requestId);
        if (data.ok) { if (data.result?.sourceVersion) generation = data.result.sourceVersion; task.resolve(data.result); }
        else task.reject(new Error(data.error?.message));
      };
    });
    Object.assign(window, { historyRequest: (method: string, args: unknown) => new Promise((resolve, reject) => {
      const requestId = String(++sequence); pending.set(requestId, { resolve, reject });
      port.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request", sourceVersion: generation, requestId, method, args });
    }) });
    new Function(source)();
    window.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake", sourceVersion: generation,
      features: ["previewHistory", "previewInsert"] }, "*", [port.port2]);
    await ready;
  }, DESIGN_RUNTIME_SOURCE);
});
afterEach(async () => { await browser?.close(); });

// Wire reply assertions stay close to actual CSS and authority, rather than
// source-text tests of the implementation. This is a DOM check, not timing.
const run = async (scenario: "commit" | "history" | "branch" | "refusal") => page.evaluate(async scenario => {
  const ask = (window as unknown as { historyRequest(method: string, args: unknown): Promise<any> }).historyRequest;
  const node = document.querySelector('[data-oid="root"]')!;
  const display = () => getComputedStyle(node).display;
  const commit = (to: string, value: string) => ask("commitStyles", { nextSourceVersion: to.repeat(24), updates: [{ nodeId: "root", styles: { display: value } }] });
  const restore = (to: string) => ask("restoreGeneration", { targetSourceVersion: to.repeat(24), commit: true, measure: ["root"] });
  await commit("b", "flex");
  await ask("previewStyles", { nodeId: "root", styles: { display: "grid" } });
  await ask("previewHistory", { targetSourceVersion: "a".repeat(24), measure: ["root"] });
  const predicted = display();
  if (scenario === "refusal") {
    let refused = false;
    try { await ask("previewHistory", { targetSourceVersion: "f".repeat(24) }); } catch { refused = true; }
    await ask("previewHistory", { targetSourceVersion: null });
    return { predicted, refused, recovered: display() };
  }
  const adopted = await commit("c", "grid");
  const afterCommit = display();
  const undo = await restore("b"); const afterUndo = display();
  if (scenario === "branch") {
    await commit("d", "inline-block");
    await restore("b");
  }
  if (scenario === "history") { await restore("c"); await restore("b"); }
  await ask("previewHistory", { targetSourceVersion: null });
  const final = display();
  await restore("a"); const older = display();
  return { predicted, afterCommit, afterUndo, final, older,
    committed: adopted.details.find((d: { oid: string }) => d.oid === "root")?.styles.display,
    undo: undo.details.find((d: { oid: string }) => d.oid === "root")?.styles.display,
    sourceVersion: undo.sourceVersion };
}, scenario);

describe("history presentation across authoritative adoption", () => {
  it.each(["commit", "history", "branch"] as const)("keeps the real baseline during %s and returns only confirmed details", async scenario => {
    expect(await run(scenario)).toEqual({ predicted: "block", afterCommit: "block", afterUndo: "block",
      final: "flex", older: "block", committed: "grid", undo: "flex", sourceVersion: "b".repeat(24) });
  });
  it("refuses an unknown inverse and recovers the true authority", async () => {
    expect(await run("refusal")).toEqual({ predicted: "block", refused: true, recovered: "flex" });
  });
  it("clears presentation as teardown without any layout readback", async () => {
    const result = await page.evaluate(async () => {
      const ask = (window as unknown as { historyRequest(method: string, args: unknown): Promise<unknown> }).historyRequest;
      await ask("commitStyles", { nextSourceVersion: "b".repeat(24), updates: [{ nodeId: "root", styles: { display: "flex" } }] });
      await ask("previewHistory", { targetSourceVersion: "a".repeat(24) });
      let reads = 0;
      const original = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () { reads++; return original.call(this); };
      const reply = await ask("previewHistory", { targetSourceVersion: null });
      Element.prototype.getBoundingClientRect = original;
      return { reply, reads, display: getComputedStyle(document.querySelector('[data-oid="root"]')!).display };
    });
    expect(result).toEqual({ reply: null, reads: 0, display: "flex" });
  });
  it("hides an unconfirmed insert immediately and preserves its true absent baseline", async () => {
    const result = await page.evaluate(async () => {
      const ask = (window as unknown as { historyRequest(method: string, args: unknown): Promise<any> }).historyRequest;
      const inserts = [{ nodeId: "inserted", parentId: "root", beforeId: null, tag: "div", style: "width:40px;height:40px" }];
      const exists = () => !!document.querySelector('[data-oid="inserted"]');
      await ask("previewInsert", { inserts });
      const drafted = exists();
      const inverse = await ask("previewHistory", { targetSourceVersion: "a".repeat(24), measure: ["root"] });
      const predicted = exists();
      const committed = await ask("commitStyles", { updates: [], nextSourceVersion: "b".repeat(24), patch: { inserts } });
      const afterCommit = exists();
      await ask("restoreGeneration", { targetSourceVersion: "a".repeat(24), commit: true });
      await ask("previewHistory", { targetSourceVersion: null });
      const afterUndo = exists();
      await ask("restoreGeneration", { targetSourceVersion: "b".repeat(24), commit: true });
      return { drafted, predicted, afterCommit, afterUndo, redone: exists(),
        previewTree: JSON.stringify(inverse.snapshot.tree).includes('"inserted"'),
        confirmedTree: JSON.stringify(committed.snapshot.tree).includes('"inserted"') };
    });
    expect(result).toEqual({ drafted: true, predicted: false, afterCommit: false, afterUndo: false,
      redone: true, previewTree: false, confirmedTree: true });
  });
});
