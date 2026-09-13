import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  DESIGN_RUNTIME_SOURCE,
  type DesignRuntimeNodeDetails,
  type DesignRuntimeSnapshot,
  isDesignRuntimeFrameMessage,
} from "../design-runtime";
import { designLayoutActionStyles } from "../../../../apps/desktop/src/renderer/features/design-workspace/design-layout-values";
import { designLayoutChildUpdates } from "../../../../apps/desktop/src/renderer/features/design-workspace/design-layout-children";
import { DESIGN_DOCUMENT_BODY_ID } from "@zeros/design-core";
import { DESIGN_RUNTIME_DOCUMENT_BODY_ID } from "../design-runtime";
import { designFrameLayerChildren } from "../../../../apps/desktop/src/renderer/features/design-workspace/design-layer-tree";

type RuntimeWindow = Window & {
  __zerosDesignSourceVersion: string;
  layoutRequest: (nodeId: string) => Promise<DesignRuntimeNodeDetails>;
  layoutSnapshot: () => Promise<DesignRuntimeSnapshot>;
};

async function fixture(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluate(async (source) => {
    document.body.innerHTML = `<main data-oid="parent" style="position:relative;width:400px;height:300px;border:5px solid;padding:20px;box-sizing:border-box;transform:rotate(20deg)"><div data-oid="child" style="position:absolute;left:40.4px;top:30.2px;width:100px;height:60px;transform:rotate(30deg)"></div></main>`;
    const runtimeWindow = window as unknown as RuntimeWindow;
    runtimeWindow.__zerosDesignSourceVersion = "a".repeat(24);
    new Function(source)();
    const channel = new MessageChannel();
    const pending = new Map<
      string,
      (value: DesignRuntimeNodeDetails) => void
    >();
    let count = 0;
    const snapshots = new Map<string, (value: DesignRuntimeSnapshot) => void>();
    const ready = new Promise<void>((resolve) => {
      channel.port1.onmessage = (event) => {
        if (event.data.type === "event" && event.data.event === "ready")
          resolve();
        if (event.data.type === "response") {
          snapshots.get(event.data.requestId)?.(event.data.result);
          snapshots.delete(event.data.requestId);
          pending.get(event.data.requestId)?.(event.data.result);
          pending.delete(event.data.requestId);
        }
      };
    });
    runtimeWindow.layoutRequest = (nodeId) =>
      new Promise((resolve) => {
        const requestId = String(++count);
        pending.set(requestId, resolve);
        channel.port1.postMessage({
          protocol: "zeros-design-runtime",
          version: 2,
          type: "request",
          sourceVersion: runtimeWindow.__zerosDesignSourceVersion,
          requestId,
          method: "getNodeDetails",
          args: { nodeId },
        });
      });
    runtimeWindow.layoutSnapshot = () =>
      new Promise((resolve) => {
        const requestId = String(++count);
        snapshots.set(requestId, resolve);
        channel.port1.postMessage({
          protocol: "zeros-design-runtime",
          version: 2,
          type: "request",
          sourceVersion: runtimeWindow.__zerosDesignSourceVersion,
          requestId,
          method: "getSnapshot",
          args: {},
        });
      });
    channel.port1.start();
    window.postMessage(
      {
        protocol: "zeros-design-runtime",
        version: 2,
        type: "handshake",
        sourceVersion: runtimeWindow.__zerosDesignSourceVersion,
      },
      "*",
      [channel.port2],
    );
    await ready;
  }, DESIGN_RUNTIME_SOURCE);
  return page;
}
const read = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as RuntimeWindow).layoutRequest("child"),
  );
const apply = (page: Page, styles: Record<string, string | null>) =>
  page.locator('[data-oid="child"]').evaluate((element, patch) => {
    for (const [property, value] of Object.entries(patch))
      (element as HTMLElement).style.setProperty(property, value ?? "");
  }, styles);
const readNode = (page: Page, nodeId: string) =>
  page.evaluate(
    (nodeId) => (window as unknown as RuntimeWindow).layoutRequest(nodeId),
    nodeId,
  );
const applyUpdates = (
  page: Page,
  updates: Map<string, Record<string, string | null>>,
) =>
  page.evaluate(
    (updates) => {
      for (const [oid, styles] of updates) {
        const element = document.querySelector<HTMLElement>(
          `[data-oid="${CSS.escape(oid)}"]`,
        )!;
        for (const [key, value] of Object.entries(styles))
          element.style.setProperty(key, value ?? "");
      }
    },
    [...updates],
  );

describe("designer layout in Chromium", () => {
  it("shares the document target identity with the authoring API", () => {
    expect(DESIGN_RUNTIME_DOCUMENT_BODY_ID).toBe(DESIGN_DOCUMENT_BODY_ID);
  });
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("keeps visible authored roots separate from the canvas frame", async () => {
    const page = await fixture(browser);
    try {
      await page.locator('[data-oid="parent"]').evaluate((element) => {
        const outer = document.createElement("div");
        outer.dataset.oid = "outer";
        outer.style.cssText =
          "display:block;position:relative;width:500px;height:400px";
        element.replaceWith(outer);
        outer.append(element);
      });
      const snapshot = await page.evaluate(() =>
        (window as unknown as RuntimeWindow).layoutSnapshot(),
      );
      expect(snapshot.frame.tag).toBe("body");
      expect(snapshot.frame.oid).toBe("::zeros-document-body");
      expect(snapshot.frame.childrenLayout?.nodeIds).toEqual(["outer"]);
      expect(snapshot.tree[0]?.oid).toBe("outer");
      expect((await readNode(page, snapshot.frame.oid)).oid).toBe(
        snapshot.frame.oid,
      );
      expect((await readNode(page, "parent")).childrenLayout?.nodeIds).toEqual([
        "child",
      ]);
    } finally {
      await page.close();
    }
  });

  it("merges only an explicitly marked sole frame shell and retains sibling roots", async () => {
    const page = await fixture(browser);
    const snapshot = () =>
      page.evaluate(() =>
        (window as unknown as RuntimeWindow).layoutSnapshot(),
      );
    try {
      await page
        .locator('[data-oid="parent"]')
        .evaluate((node) => node.setAttribute("data-zeros-frame-root", ""));
      const marked = await snapshot();
      expect(marked.frame.oid).toBe("parent");
      expect(
        designFrameLayerChildren(marked.tree, marked.frame.oid).map(
          (node) => node.oid,
        ),
      ).toEqual(["child"]);
      await page.evaluate(() =>
        document.body.insertAdjacentHTML(
          "beforeend",
          '<div data-oid="sibling"></div>',
        ),
      );
      const siblings = await snapshot();
      expect(siblings.frame.oid).toBe(DESIGN_DOCUMENT_BODY_ID);
      expect(
        designFrameLayerChildren(siblings.tree, siblings.frame.oid).map(
          (node) => node.oid,
        ),
      ).toEqual(["parent", "sibling"]);
      await page
        .locator('[data-oid="sibling"]')
        .evaluate((node) => node.remove());
      await page
        .locator('[data-oid="child"]')
        .evaluate((node) => node.remove());
      const empty = await snapshot();
      expect(empty.frame.childrenLayout?.count).toBe(0);
      expect(designFrameLayerChildren(empty.tree, empty.frame.oid)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("maps child coordinates through transformed, mirrored, scrolled padding boxes", async () => {
    const page = await fixture(browser);
    try {
      await page.locator('[data-oid="parent"]').evaluate((element) => {
        const parent = element as HTMLElement;
        parent.style.transform = "rotate(30deg) scale(-1, 1.5) skewX(10deg)";
        parent.style.overflow = "scroll";
        const child = parent.firstElementChild as HTMLElement;
        child.style.cssText =
          "position:absolute;left:40px;top:30px;width:0;height:0;";
        parent.insertAdjacentHTML(
          "beforeend",
          '<div style="width:800px;height:700px"></div>',
        );
        parent.scrollLeft = 20;
        parent.scrollTop = 10;
      });
      const parent = await readNode(page, "parent");
      const child = await readNode(page, "child");
      const matrix = parent.childCoordinateSpace;
      expect(matrix).toHaveLength(6);
      if (!matrix) throw new Error("Missing child coordinate space");
      expect(matrix[0] * 40 + matrix[2] * 30 + matrix[4]).toBeCloseTo(
        child.rect.x,
        2,
      );
      expect(matrix[1] * 40 + matrix[3] * 30 + matrix[5]).toBeCloseTo(
        child.rect.y,
        2,
      );
    } finally {
      await page.close();
    }
  });

  it("reports direct child pins for containers and none for empty layers", async () => {
    const page = await fixture(browser);
    try {
      expect(await read(page)).toHaveProperty("childrenLayout", {
        count: 0,
        nodeIds: [],
        x: "start",
        y: "start",
        truncated: false,
      });
      const readParent = () =>
        page.evaluate(() =>
          (window as unknown as RuntimeWindow).layoutRequest("parent"),
        );
      expect(await readParent()).toHaveProperty("childrenLayout", {
        count: 1,
        nodeIds: ["child"],
        x: "start",
        y: "start",
        truncated: false,
      });
      await page.locator('[data-oid="child"]').evaluate((element) => {
        (element as HTMLElement).style.setProperty("--zeros-layout-x", "end");
        element.innerHTML = '<div data-oid="grandchild"></div>';
        element.insertAdjacentHTML(
          "afterend",
          '<div data-oid="sibling"></div><div data-oid="hidden" hidden></div>',
        );
      });
      expect(await readParent()).toHaveProperty("childrenLayout", {
        count: 3,
        nodeIds: ["child", "sibling"],
        x: "mixed",
        y: "start",
        truncated: false,
      });
      // Inherited intent must never make an unpinned descendant appear pinned.
      expect(await read(page)).toHaveProperty("childrenLayout.x", "start");
    } finally {
      await page.close();
    }
  });

  it("measures parent-local geometry independently of transform chains and validates optional context", async () => {
    const page = await fixture(browser);
    try {
      const details = await read(page);
      expect(details.layout).toMatchObject({
        x: 40.4,
        parentWidth: 390,
        parentHeight: 290,
        parentId: "parent",
        isContainingBlock: true,
      });
      expect(details.layout?.y).toBeCloseTo(30.2, 1);
      const message = (frame: DesignRuntimeNodeDetails) => ({
        protocol: "zeros-design-runtime",
        version: 2,
        type: "event",
        event: "mutation",
        sourceVersion: "a".repeat(24),
        payload: {
          sourceVersion: "a".repeat(24),
          revision: 1,
          tree: [],
          frame,
          warnings: [],
          viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 },
        },
      });
      expect(isDesignRuntimeFrameMessage(message(details))).toBe(true);
      expect(
        isDesignRuntimeFrameMessage(
          message({ ...details, childCoordinateSpace: undefined }),
        ),
      ).toBe(true);
      for (const matrix of [
        [1, 0],
        [1, 0, 0, 1, Number.NaN, 0],
        [1, 0, 0, 1, 0, Infinity],
      ]) {
        expect(
          isDesignRuntimeFrameMessage(
            message({
              ...details,
              childCoordinateSpace: matrix,
            } as DesignRuntimeNodeDetails),
          ),
        ).toBe(false);
      }
      for (const childrenLayout of [
        { ...details.childrenLayout!, count: -1 },
        { ...details.childrenLayout!, x: "invalid" },
        { ...details.childrenLayout!, count: 2, nodeIds: ["same", "same"] },
        {
          ...details.childrenLayout!,
          count: 256,
          nodeIds: Array.from({ length: 256 }, (_, i) => `node-${i}`),
        },
      ])
        expect(
          isDesignRuntimeFrameMessage(
            message({ ...details, childrenLayout } as DesignRuntimeNodeDetails),
          ),
        ).toBe(false);
      expect(
        isDesignRuntimeFrameMessage(
          message({ ...details, childrenLayout: undefined }),
        ),
      ).toBe(true);
      expect(
        isDesignRuntimeFrameMessage(
          message({
            ...details,
            layout: { ...details.layout!, parentWidth: -1 },
          }),
        ),
      ).toBe(false);
      expect(
        isDesignRuntimeFrameMessage(message({ ...details, layout: undefined })),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("bounds child readback before measuring an oversized container", async () => {
    const page = await fixture(browser);
    try {
      await page.locator('[data-oid="parent"]').evaluate((element) => {
        element.innerHTML = Array.from(
          { length: 256 },
          (_, index) => `<div data-oid="child-${index}"></div>`,
        ).join("");
      });
      expect((await readNode(page, "parent")).childrenLayout).toEqual({
        count: 256,
        nodeIds: [],
        x: "mixed",
        y: "mixed",
        truncated: true,
      });
    } finally {
      await page.close();
    }
  });

  it("preserves a content-sized container when alignment takes its children out of flow", async () => {
    const page = await fixture(browser);
    try {
      await page.locator('[data-oid="parent"]').evaluate((element) => {
        (element as HTMLElement).style.height = "auto";
        (element.firstElementChild as HTMLElement).style.cssText =
          "display:block;width:100px;height:60px";
      });
      const parent = await readNode(page, "parent");
      const child = await read(page);
      await applyUpdates(
        page,
        designLayoutChildUpdates([parent], [child], {
          type: "align",
          axis: "x",
          value: "end",
        }),
      );
      expect((await readNode(page, "parent")).box?.height).toBe(
        parent.box?.height,
      );
      expect((await read(page)).layout?.x).toBe(290);
    } finally {
      await page.close();
    }
  });

  it("fits rotated and mirrored children including negative extents without clipping", async () => {
    const page = await fixture(browser);
    try {
      await page.locator('[data-oid="parent"]').evaluate((element) => {
        (element as HTMLElement).style.transform = "none";
        const child = element.firstElementChild as HTMLElement;
        child.style.left = "-20px";
        child.style.top = "-10px";
        child.style.scale = "-1 1";
      });
      const before = await read(page);
      await applyUpdates(
        page,
        designLayoutChildUpdates([await readNode(page, "parent")], [before], {
          type: "resize-fit",
        }),
      );
      const parent = await readNode(page, "parent");
      const child = await read(page);
      expect(child.rect.x).toBeGreaterThanOrEqual(parent.rect.x + 24);
      expect(child.rect.y).toBeGreaterThanOrEqual(parent.rect.y + 24);
      expect(child.rect.x + child.rect.width).toBeLessThanOrEqual(
        parent.rect.x + parent.rect.width - 24,
      );
      expect(child.rect.y + child.rect.height).toBeLessThanOrEqual(
        parent.rect.y + parent.rect.height - 24,
      );
      expect(child.styles.transform).toBe(before.styles.transform);
      expect(child.styles.scale).toBe(before.styles.scale);
    } finally {
      await page.close();
    }
  });

  it("preserves right and bottom distances as the parent resizes, then stretches between paired pins", async () => {
    const page = await fixture(browser);
    try {
      await apply(
        page,
        designLayoutActionStyles(await read(page), {
          type: "constraint",
          axis: "x",
          value: "end",
        }),
      );
      await apply(
        page,
        designLayoutActionStyles(await read(page), {
          type: "constraint",
          axis: "y",
          value: "end",
        }),
      );
      await page.locator('[data-oid="parent"]').evaluate((element) => {
        (element as HTMLElement).style.width = "600px";
        (element as HTMLElement).style.height = "500px";
      });
      const pinned = await read(page);
      expect(pinned.layout?.x).toBe(240);
      expect(pinned.layout?.y).toBe(230);
      await apply(
        page,
        designLayoutActionStyles(pinned, {
          type: "constraint",
          axis: "x",
          value: "stretch",
        }),
      );
      await page.locator('[data-oid="parent"]').evaluate((element) => {
        (element as HTMLElement).style.width = "700px";
      });
      expect((await read(page)).box?.width).toBe(200);
    } finally {
      await page.close();
    }
  });

  it("keeps centered offsets through resize without taking over an authored transform", async () => {
    const page = await fixture(browser);
    try {
      const before = await read(page);
      await apply(page, designLayoutActionStyles(before, { type: "center" }));
      await page.locator('[data-oid="parent"]').evaluate((element) => {
        (element as HTMLElement).style.width = "600px";
        (element as HTMLElement).style.height = "500px";
      });
      const after = await read(page);
      expect(after.layout?.x).toBe(140);
      expect(after.layout?.y).toBe(130);
      expect(after.styles.transform).toBe(before.styles.transform);
    } finally {
      await page.close();
    }
  });

  it("keeps a rotated selection outline on a mirrored element", async () => {
    const page = await fixture(browser);
    try {
      await apply(page, { scale: "-1 1" });
      const details = await read(page);
      const box = details.box!;
      const angle = (box.rotation * Math.PI) / 180;
      const points = [
        [0, 0],
        [box.width * box.scaleX, 0],
        [0, box.height * box.scaleY],
        [box.width * box.scaleX, box.height * box.scaleY],
      ].map(([x, y]) => ({
        x: box.x + x! * Math.cos(angle) - y! * Math.sin(angle),
        y: box.y + x! * Math.sin(angle) + y! * Math.cos(angle),
      }));
      expect(Math.min(...points.map((point) => point.x))).toBeCloseTo(
        details.rect.x,
        3,
      );
      expect(
        Math.max(...points.map((point) => point.x)) -
          Math.min(...points.map((point) => point.x)),
      ).toBeCloseTo(details.rect.width, 3);
    } finally {
      await page.close();
    }
  });
});
