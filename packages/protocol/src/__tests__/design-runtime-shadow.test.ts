import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  DESIGN_RUNTIME_SOURCE,
  DESIGN_RUNTIME_TREE_DEPTH_LIMIT,
  isDesignRuntimeFrameMessage,
  type DesignRuntimeNodeDetails,
  type DesignRuntimeSnapshot,
  type DesignRuntimeTreeNode,
} from "../design-runtime";

type RuntimeWindow = Window & {
  __zerosDesignSourceVersion: string;
  runtimeRequest: (method: string, args: unknown) => Promise<{ ok: boolean; result?: unknown; message: unknown }>;
};

// A frame serialized from a web component: its visible content lives in a
// declarative shadow root with its own linked (placeholder) stylesheet.
const SHADOW_DOCUMENT = `<!doctype html><html><head>
<style data-zeros-source="tokens.css">:root { --diff-bg: rgb(23, 23, 23); } body { margin: 0; } main { padding: 8px; }</style>
</head><body>
<main data-oid="sheet">
  <diffs-container data-oid="host" style="display: block; width: 300px; background-color: rgb(157, 51, 51)">
    <template shadowrootmode="open"><style data-zeros-source="page/shadow.css">pre { margin: 0; height: 120px; background-color: var(--diff-bg); } .line { display: block; height: 20px; color: rgb(230, 230, 230); }</style><pre data-oid="pre"><code data-oid="code"><span class="line" data-oid="line">const value = 1;</span></code></pre></template>
  </diffs-container>
</main>
</body></html>`;

function nestedDocument(levels: number): string {
  let markup = '<span data-oid="leaf">deep</span>';
  for (let level = levels - 1; level >= 0; level -= 1) markup = `<div data-oid="d${level}">${markup}</div>`;
  return `<!doctype html><html><head></head><body>${markup}</body></html>`;
}

async function fixture(browser: Browser, html: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(async (source) => {
    const runtimeWindow = window as unknown as RuntimeWindow;
    runtimeWindow.__zerosDesignSourceVersion = "a".repeat(24);
    new Function(source)();
    const channel = new MessageChannel();
    const pending = new Map<string, (value: { ok: boolean; result?: unknown; message: unknown }) => void>();
    let count = 0;
    const ready = new Promise<void>((resolve) => {
      channel.port1.onmessage = (event) => {
        if (event.data.type === "event" && event.data.event === "ready") resolve();
        if (event.data.type === "response") {
          pending.get(event.data.requestId)?.({ ok: event.data.ok, result: event.data.result, message: event.data });
          pending.delete(event.data.requestId);
        }
      };
    });
    runtimeWindow.runtimeRequest = (method, args) =>
      new Promise((resolve) => {
        const requestId = String(++count);
        pending.set(requestId, resolve);
        channel.port1.postMessage({
          protocol: "zeros-design-runtime",
          version: 2,
          type: "request",
          sourceVersion: runtimeWindow.__zerosDesignSourceVersion,
          requestId,
          method,
          args,
        });
      });
    channel.port1.start();
    window.postMessage(
      { protocol: "zeros-design-runtime", version: 2, type: "handshake", sourceVersion: runtimeWindow.__zerosDesignSourceVersion },
      "*",
      [channel.port2],
    );
    await ready;
  }, DESIGN_RUNTIME_SOURCE);
  return page;
}

async function request<T>(page: Page, method: string, args: unknown): Promise<{ result: T; message: unknown }> {
  const response = await page.evaluate(
    ({ method, args }) => (window as unknown as RuntimeWindow).runtimeRequest(method, args),
    { method, args },
  );
  expect(response.ok).toBe(true);
  return { result: response.result as T, message: response.message };
}

/** Deep snapshots outgrow Playwright's evaluate() serializer, so summarize in
 * the page what a deep-tree assertion needs. */
async function deepSnapshotSummary(page: Page, leaf: string): Promise<{ valid: boolean; limited: boolean; leafText: string | null }> {
  return page.evaluate(async (leafId) => {
    const response = await (window as unknown as RuntimeWindow).runtimeRequest("getSnapshot", {});
    const snapshot = response.result as DesignRuntimeSnapshot;
    let leafText: string | null = null;
    const pending = [...snapshot.tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.oid === leafId) leafText = node.text;
      pending.push(...node.children);
    }
    return {
      valid: response.ok,
      limited: snapshot.warnings.some((warning) => warning.ruleId === "layer-tree-limit"),
      leafText,
    };
  }, leaf);
}

function find(nodes: readonly DesignRuntimeTreeNode[], oid: string): DesignRuntimeTreeNode | null {
  for (const node of nodes) {
    if (node.oid === oid) return node;
    const found = find(node.children, oid);
    if (found) return found;
  }
  return null;
}

describe("declarative shadow roots in the design runtime", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await fixture(browser, SHADOW_DOCUMENT);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("lists rendered shadow content as the host's layers", async () => {
    const { result: snapshot, message } = await request<DesignRuntimeSnapshot>(page, "getSnapshot", {});
    expect(isDesignRuntimeFrameMessage(message)).toBe(true);
    const host = find(snapshot.tree, "host");
    expect(host?.shadow).toBeUndefined();
    expect(host?.children.map((child) => child.oid)).toEqual(["pre"]);
    expect(find(snapshot.tree, "pre")).toMatchObject({ shadow: true, children: [{ oid: "code", children: [{ oid: "line", shadow: true }] }] });
  });

  it("hits the shadow element a person sees, not its host", async () => {
    const { result: hit } = await request<DesignRuntimeNodeDetails>(page, "getElementAtLoc", { x: 20, y: 15, mode: "deepest" });
    expect(hit.oid).toBe("line");
    expect(hit.shadow).toBe(true);
    expect(hit.breadcrumb.map((crumb) => crumb.split(" · ")[0])).toEqual(["main", "diffs-container", "pre", "code", "span"]);
    const { result: topLevel } = await request<DesignRuntimeNodeDetails>(page, "getElementAtLoc", { x: 20, y: 15, mode: "top-level" });
    expect(topLevel.oid).toBe("sheet");
  });

  it("reads a shadow element's authored styles and tokens from its own tree", async () => {
    const { result: pre, message } = await request<DesignRuntimeNodeDetails>(page, "getNodeDetails", { nodeId: "pre" });
    expect(isDesignRuntimeFrameMessage(message)).toBe(true);
    expect(pre.styles.backgroundColor).toBe("rgb(23, 23, 23)");
    expect(pre.authoredStyleProperties).toContain("background-color");
    expect(pre.authoredStyles?.["background-color"]).toEqual({
      origin: "linked",
      file: "page/shadow.css",
      value: "var(--diff-bg)",
      tokens: [{ name: "--diff-bg", value: "rgb(23, 23, 23)", origin: "linked", file: "tokens.css" }],
    });
    expect(pre.layout?.parentId).toBe("host");
    const { result: host } = await request<DesignRuntimeNodeDetails>(page, "getNodeDetails", { nodeId: "host" });
    // The host's own fill is reported truthfully; its shadow content paints over it.
    expect(host.styles.backgroundColor).toBe("rgb(157, 51, 51)");
    expect(host.textEditable).toBe(false);
    expect(host.childrenLayout?.nodeIds).toEqual(["pre"]);
  });
});

describe("deep authored trees", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("keeps every layer of app-depth markup instead of truncating at 32 levels", async () => {
    const page = await fixture(browser, nestedDocument(48));
    expect(await deepSnapshotSummary(page, "leaf")).toEqual({ valid: true, limited: false, leafText: "deep" });
  });

  it("still bounds pathological nesting and says so", async () => {
    const page = await fixture(browser, nestedDocument(DESIGN_RUNTIME_TREE_DEPTH_LIMIT + 8));
    expect(await deepSnapshotSummary(page, "leaf")).toEqual({ valid: true, limited: true, leafText: null });
  });
});
