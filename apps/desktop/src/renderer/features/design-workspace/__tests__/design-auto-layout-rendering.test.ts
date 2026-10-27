import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyDesignTransaction,
  type DesignOperation,
} from "@zeros/design-core";
import {
  createDesignWebDocumentState,
  designWebTransactionAdapter,
  type DesignWebDocumentState,
} from "@zeros/design-web";
import {
  DESIGN_RUNTIME_SOURCE,
  type DesignRuntimeNodeDetails,
} from "@zeros/protocol/design-runtime";
import { LAYERED_LAYOUT_SOURCE } from "../../../harnesses/harness-design-layered-layout";
import {
  designAutoLayoutUpdates,
  type DesignAutoLayoutFlow,
} from "../design-auto-layout-values";

type RuntimeWindow = typeof window & {
  layoutRequest: (
    method: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
};

async function mount(page: Page, html: string) {
  await page.setContent(html);
  await page.evaluate(
    (source) =>
      new Promise<void>((resolve, reject) => {
        let sourceVersion = "a".repeat(24);
        Object.assign(window, { __zerosDesignSourceVersion: sourceVersion });
        const channel = new MessageChannel();
        let sequence = 0;
        const pending = new Map<
          string,
          { resolve: (value: unknown) => void; reject: (error: Error) => void }
        >();
        const timeout = setTimeout(
          () => reject(new Error("Runtime handshake timed out")),
          5_000,
        );
        channel.port1.onmessage = ({ data }) => {
          if (data.type === "event" && data.event === "ready") {
            clearTimeout(timeout);
            resolve();
          }
          if (data.type !== "response") return;
          const task = pending.get(data.requestId);
          pending.delete(data.requestId);
          if (!data.ok)
            task?.reject(
              new Error(data.error?.message ?? "Runtime request failed"),
            );
          else {
            if (data.result?.sourceVersion)
              sourceVersion = data.result.sourceVersion;
            task?.resolve(data.result);
          }
        };
        (window as RuntimeWindow).layoutRequest = (method, args) =>
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
        new Function(source)();
        window.postMessage(
          {
            protocol: "zeros-design-runtime",
            version: 2,
            type: "handshake",
            sourceVersion,
            features: ["setPlayback"],
          },
          "*",
          [channel.port2],
        );
      }),
    DESIGN_RUNTIME_SOURCE,
  );
}

function request<T>(
  page: Page,
  method: string,
  args: Record<string, unknown>,
): Promise<T> {
  return page.evaluate(
    ({ method, args }) => (window as RuntimeWindow).layoutRequest(method, args),
    { method, args },
  ) as Promise<T>;
}

function apply(state: DesignWebDocumentState, operations: DesignOperation[]) {
  return applyDesignTransaction(
    state,
    {
      schemaVersion: 1,
      transactionId: crypto.randomUUID(),
      documentId: state.documentId,
      baseRevision: state.revision,
      actor: { kind: "human", id: "test" },
      intent: "Change layout",
      createdAt: 1,
      operations,
    },
    designWebTransactionAdapter,
  );
}

const details = (page: Page, nodeId: string) =>
  request<DesignRuntimeNodeDetails>(page, "getNodeDetails", { nodeId });

async function changeLayout(
  page: Page,
  state: DesignWebDocumentState,
  flow: DesignAutoLayoutFlow,
  generation: number,
) {
  const parent = await details(page, "home-main");
  const children = await Promise.all(
    parent.childrenLayout!.nodeIds.map((id) => details(page, id)),
  );
  const updates = [...designAutoLayoutUpdates([parent], children, flow)].map(
    ([nodeId, styles]) => ({ nodeId, styles }),
  );
  const outcome = apply(
    state,
    updates.map((update, index) => ({
      operationId: `layout-${index}`,
      type: "node.set-styles",
      ...update,
      scope: "auto",
      responsiveContext: "base",
      stateContext: "default",
    })),
  );
  expect(outcome.receipt.status).toBe("applied");
  await request(page, "commitStyles", {
    updates,
    nextSourceVersion: generation.toString(16).padStart(24, "0"),
  });
  return outcome;
}

async function expectComposition(page: Page) {
  const [root, backdrop, copy, heading, mark, fixed, badge] = await Promise.all(
    [
      "home-main",
      "home-field",
      "home-hero",
      "home-heading",
      "home-mark-b",
      "home-fixed",
      "home-badge",
    ].map((id) => details(page, id)),
  );
  expect(backdrop!.styles.position).toBe("absolute");
  expect(fixed!.styles.position).toBe("fixed");
  expect(badge!.styles.position).toBe("absolute");
  expect(badge!.rect).toMatchObject({
    x: root!.rect.width - 121,
    y: 41,
    width: 80,
    height: 24,
  });
  expect(backdrop!.rect).toMatchObject({
    x: 1,
    y: 1,
    width: root!.rect.width - 2,
    height: root!.rect.height - 2,
  });
  expect(copy!.rect.y).toBe(105);
  for (const layer of [heading!, mark!]) {
    expect(layer.rect.y).toBeGreaterThanOrEqual(root!.rect.y);
    expect(layer.rect.y + layer.rect.height).toBeLessThan(root!.rect.height);
    expect(layer.styles.opacity).toBe("1");
  }
}

describe("auto layout preserves layered HTML", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("does not move ancestor-positioned overlays when a static CSS container gains layout", async () => {
    const page = await browser.newPage({
      viewport: { width: 960, height: 600 },
    });
    try {
      const source = LAYERED_LAYOUT_SOURCE.replace(
        "position: relative; width: 100%; height: 100vh;",
        "position: static; margin: 40px; width: auto; height: 400px;",
      );
      let state = createDesignWebDocumentState({
        documentId: "static-layout",
        entryFile: "home.html",
        files: { "home.html": source },
      });
      await mount(page, source);
      const before = (await details(page, "home-field")).rect;
      for (const [generation, flow] of (
        ["column", "grid", "none", "row"] as const
      ).entries()) {
        state = (await changeLayout(page, state, flow, generation + 1)).state;
        expect((await details(page, "home-field")).rect).toEqual(before);
        expect((await details(page, "home-main")).styles.position).toBe(
          "static",
        );
      }
    } finally {
      await page.close();
    }
  });

  it.each(["row", "column", "grid"] as const)(
    "keeps content visible and responsive after enabling %s, saving, undo and redo",
    async (flow) => {
      const page = await browser.newPage({
        viewport: { width: 960, height: 600 },
      });
      try {
        const state = createDesignWebDocumentState({
          documentId: "layered-layout",
          entryFile: "home.html",
          files: { "home.html": LAYERED_LAYOUT_SOURCE },
        });
        await mount(page, LAYERED_LAYOUT_SOURCE);
        await expectComposition(page);
        const changed = await changeLayout(page, state, flow, 1);
        await expectComposition(page);
        const after = changed.state.files["home.html"]!;
        expect(after).toContain(
          '<div class="field" data-oid="home-field" aria-hidden="true">',
        );
        expect(after).toContain('<div class="copy" data-oid="home-hero">');
        expect((await details(page, "home-hero")).layout).toMatchObject({
          widthValue: "80%",
          heightValue: "auto",
        });

        const undone = apply(changed.state, changed.inverseOperations);
        expect(undone.state.files["home.html"]).toBe(LAYERED_LAYOUT_SOURCE);
        await request(page, "restoreGeneration", {
          targetSourceVersion: "a".repeat(24),
          commit: true,
        });
        await expectComposition(page);
        const redone = apply(undone.state, undone.inverseOperations);
        expect(redone.state.files["home.html"]).toBe(after);
        await request(page, "restoreGeneration", {
          targetSourceVersion: "1".padStart(24, "0"),
          commit: true,
        });
        await expectComposition(page);

        // Reload the actual adapter output, not just the live style preview.
        const saved = await browser.newPage({
          viewport: { width: 960, height: 600 },
        });
        try {
          await mount(saved, after);
          await expectComposition(saved);
          const width = (await details(saved, "home-hero")).rect.width;
          await saved.setViewportSize({ width: 800, height: 600 });
          expect((await details(saved, "home-hero")).rect.width).toBeLessThan(
            width,
          );
          await expectComposition(saved);
        } finally {
          await saved.close();
        }
      } finally {
        await page.close();
      }
    },
  );

  it("keeps original overlays out of repeated layout toggles and restores visible editing after Play", async () => {
    const page = await browser.newPage({
      viewport: { width: 960, height: 600 },
    });
    try {
      let state = createDesignWebDocumentState({
        documentId: "layered-layout",
        entryFile: "home.html",
        files: { "home.html": LAYERED_LAYOUT_SOURCE },
      });
      await mount(page, LAYERED_LAYOUT_SOURCE);
      let generation = 0;
      for (const flow of ["column", "none", "row", "none", "grid"] as const) {
        state = (await changeLayout(page, state, flow, ++generation)).state;
        await expectComposition(page);
      }
      await request(page, "setPlayback", {
        sessionId: "composition",
        playing: true,
      });
      const animations = await page.evaluate(() => {
        const animations = document.getAnimations();
        for (const animation of animations) {
          animation.pause();
          animation.currentTime = 2_000;
        }
        return animations.length;
      });
      expect(animations).toBeGreaterThan(0);
      await expectComposition(page);
      await request(page, "setPlayback", {
        sessionId: "composition",
        playing: false,
      });
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(
        0,
      );
      await expectComposition(page);
    } finally {
      await page.close();
    }
  });
});
