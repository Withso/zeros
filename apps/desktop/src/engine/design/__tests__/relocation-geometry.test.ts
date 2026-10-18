import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { captureDesignFrameRestorePoint, createDesignFrame, DESIGN_DIRECTORY_NAME, readDesignFrameRenderIdentity, restoreDesignFrameChanges, transferDesignNode } from "../document";
import { DESIGN_RUNTIME_SOURCE, type DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { designRelocationStyles } from "@zeros/protocol/design-relocation";
import { designNodeRelocation } from "../../../renderer/features/design-workspace/design-movement-geometry";

it("preserves all four painted corners and inherited appearance after a reflected affine extraction", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "zeros-relocation-geometry-"));
  const browser = await chromium.launch({ headless: true });
  try {
    const frame = await createDesignFrame(workspace);
    const source = '<!doctype html><html><head></head><body style="margin:0"><main style="position:relative;width:400px;height:400px;transform:rotate(30deg) scale(-2,3);color:navy;font-size:30px;--accent:red" data-oid="parent"><div data-oid="child" style="position:absolute;left:40px;top:60px;margin:20px 5px;width:100px;height:80px;transform:rotate(15deg);background:var(--accent)"><span data-oid="label">Keep</span></div></main></body></html>';
    await writeFile(path.join(workspace, DESIGN_DIRECTORY_NAME, frame.file), source);
    const page = await browser.newPage();
    const measure = async (html: string) => {
      await page.setContent(html);
      return page.evaluate(() => {
        const node = document.querySelector<HTMLElement>('[data-oid="child"]')!;
        const rect = node.getBoundingClientRect();
        const computed = getComputedStyle(node);
        const corners = [[0, 0], [100, 0], [100, 80], [0, 80]].map(([x, y]) => {
          const point = document.createElement("i");
          point.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`;
          node.append(point);
          const box = point.getBoundingClientRect(); point.remove();
          return { x: box.x, y: box.y };
        });
        return { corners, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, inheritedStyles: { color: computed.color, "font-size": computed.fontSize, "--accent": computed.getPropertyValue("--accent") }, background: computed.backgroundColor };
      });
    };
    const before = await measure(source);
    const [p, q, , s] = before.corners;
    const matrix = [(q.x - p.x) / 100, (q.y - p.y) / 100, (s.x - p.x) / 80, (s.y - p.y) / 80, p.x - before.rect.x, p.y - before.rect.y] as [number, number, number, number, number, number];
    const identity = await readDesignFrameRenderIdentity(workspace, frame.file);
    const result = await transferDesignNode(workspace, { frame: frame.file, sourceVersion: identity.sourceVersion, nodeId: "child", geometry: { x: before.rect.x, y: before.rect.y, w: before.rect.width, h: before.rect.height, z: 1 }, relocation: { width: 100, height: 80, matrix, inheritedStyles: before.inheritedStyles } });
    const saved = await captureDesignFrameRestorePoint(workspace, result.frame);
    const after = await measure(await readFile(path.join(workspace, DESIGN_DIRECTORY_NAME, result.frame), "utf8"));
    expect(after.inheritedStyles).toEqual(before.inheritedStyles);
    expect(after.background).toBe(before.background);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(after.corners[i].x + saved.geometry.x - before.corners[i].x)).toBeLessThan(0.5);
      expect(Math.abs(after.corners[i].y + saved.geometry.y - before.corners[i].y)).toBeLessThan(0.5);
    }
  } finally { await browser.close(); await rm(workspace, { recursive: true, force: true }); }
});

it("admits the complete runtime appearance through preview, extraction and exact undo within 64 styles", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "zeros-runtime-relocation-"));
  const browser = await chromium.launch({ headless: true });
  try {
    const frame = await createDesignFrame(workspace);
    const source = '<!doctype html><html><head><style>body{margin:0}td{border:4px solid red;width:40px;height:30px}</style></head><body><main data-oid="parent" style="position:relative;width:800px;height:600px;border-collapse:collapse;border-spacing:20px 15px;color:navy;font-size:30px;--accent:red"><div data-oid="child" style="position:absolute;left:70px;top:80px;right:12px;bottom:15px;width:240px;height:150px;margin:20px;margin-left:30px;background:var(--accent)"><table data-oid="table"><tbody data-oid="tbody"><tr data-oid="row"><td data-oid="cell-a">A</td><td data-oid="cell-b">B</td></tr></tbody></table></div></main></body></html>';
    const file = path.join(workspace, DESIGN_DIRECTORY_NAME, frame.file);
    await writeFile(file, source);
    const identity = await readDesignFrameRenderIdentity(workspace, frame.file);
    const beforePoint = await captureDesignFrameRestorePoint(workspace, frame.file);
    const page = await browser.newPage();
    await page.setContent(source);
    const details = await page.evaluate(({ runtime, sourceVersion }) => new Promise<DesignRuntimeNodeDetails>((resolve, reject) => {
      Object.assign(window, { __zerosDesignSourceVersion: sourceVersion });
      const channel = new MessageChannel();
      const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
      let request = 0;
      const ask = (method: string, args: unknown) => new Promise((resolve, reject) => {
        const requestId = String(++request);
        pending.set(requestId, { resolve, reject });
        channel.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request", sourceVersion, requestId, method, args });
      });
      Object.assign(window, { __relocationRequest: ask });
      const timeout = window.setTimeout(() => reject(new Error("Runtime measurement timed out")), 3000);
      channel.port1.onmessage = ({ data }) => {
        if (data.event === "ready") {
          void ask("getNodeDetails", { nodeId: "child", relocation: true }).then((value) => {
            window.clearTimeout(timeout);
            resolve(value as DesignRuntimeNodeDetails);
          }, reject);
        } else if (data.type === "response") {
          const reply = pending.get(data.requestId);
          pending.delete(data.requestId);
          if (reply) {
            if (data.ok) reply.resolve(data.result);
            else reply.reject(new Error(data.error?.message));
          }
        }
      };
      channel.port1.start();
      new Function(runtime)();
      window.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake", sourceVersion }, "*", [channel.port2]);
    }), { runtime: DESIGN_RUNTIME_SOURCE, sourceVersion: identity.sourceVersion });
    const measure = () => page.evaluate(() => {
      const child = document.querySelector<HTMLElement>('[data-oid="child"]')!;
      const table = document.querySelector<HTMLElement>('[data-oid="table"]')!;
      const style = getComputedStyle(table), rect = table.getBoundingClientRect(), root = child.getBoundingClientRect();
      return { borderCollapse: style.borderCollapse, borderSpacing: style.borderSpacing, width: rect.width, height: rect.height, localX: rect.x - root.x, localY: rect.y - root.y, color: style.color, fontSize: style.fontSize, background: getComputedStyle(child).backgroundColor };
    });
    const before = await measure();
    expect(details.relocationContext?.unsupported).toEqual([]);
    expect(Object.keys(details.relocationContext!.inheritedStyles).length).toBeGreaterThanOrEqual(42);
    const relocation = designNodeRelocation(details, { x: 0, y: 0 });
    const styles = designRelocationStyles(relocation);
    expect(Object.keys(styles).length).toBeLessThanOrEqual(64);
    expect(styles["--accent"]).toBe("red");
    await page.evaluate(async (styles) => {
      const ask = (window as unknown as { __relocationRequest: (method: string, args: unknown) => Promise<unknown> }).__relocationRequest;
      await ask("previewLayout", { updates: [{ nodeId: "child", styles }], nodeIds: ["child"], children: false });
    }, styles);
    expect(await measure()).toEqual(before);
    await page.evaluate(async () => {
      const ask = (window as unknown as { __relocationRequest: (method: string, args: unknown) => Promise<unknown> }).__relocationRequest;
      await ask("clearPreviewStyles", { nodeId: "child" });
    });
    expect(await page.locator('[data-oid="child"]').evaluate((node) => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y }))).toEqual({ x: details.rect.x, y: details.rect.y });
    const result = await transferDesignNode(workspace, { frame: frame.file, sourceVersion: identity.sourceVersion, nodeId: "child", relocation, movementGuard: { sourceVersion: identity.sourceVersion, geometry: beforePoint.geometry }, geometry: { x: details.rect.x, y: details.rect.y, w: details.rect.width, h: details.rect.height, z: 1 } });
    const saved = await captureDesignFrameRestorePoint(workspace, result.frame);
    await page.setContent(saved.source);
    expect(await measure()).toEqual(before);
    expect(await page.locator('[data-oid="child"]').evaluate((node) => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y }))).toEqual({ x: 0, y: 0 });
    await restoreDesignFrameChanges(workspace, result.changes, "undo");
    expect(await readFile(file, "utf8")).toBe(source);
    const excessive = { ...details, relocationContext: { ...details.relocationContext!, inheritedStyles: { ...details.relocationContext!.inheritedStyles, ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`--extra-${index}`, "red"])) } } };
    expect(Object.keys(excessive.relocationContext.inheritedStyles).length).toBeLessThanOrEqual(64);
    expect(() => designNodeRelocation(excessive, { x: 0, y: 0 })).toThrow(/bounded|64|style/i);
    await expect(transferDesignNode(workspace, { frame: frame.file, sourceVersion: identity.sourceVersion, nodeId: "child", relocation: { ...relocation, inheritedStyles: excessive.relocationContext.inheritedStyles }, geometry: { x: 0, y: 0, w: 240, h: 150, z: 1 } })).rejects.toThrow(/bounded|64|style/i);
    expect(await readFile(file, "utf8")).toBe(source);
  } finally {
    await browser.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
