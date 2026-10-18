import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { captureDesignFrameRestorePoint, createDesignFrame, DESIGN_DIRECTORY_NAME, readDesignFrameRenderIdentity, transferDesignNode } from "../document";

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
