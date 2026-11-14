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
    // A shadow root's own stylesheet styles only its component, so its tag
    // rules are this layer's design rather than a shared reset.
    expect(pre.authoredStyles?.["background-color"]).toEqual({
      origin: "linked",
      file: "page/shadow.css",
      selector: "pre",
      scope: "element",
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

const RULE_SCOPE_DOCUMENT = `<!doctype html><html><head><style>
  h1, .title { cursor: pointer; }
  .btn, button { user-select: none; }
  .card > p { text-indent: 2px; }
  .app * { tab-size: 4; }
  p { word-spacing: 1px; }
  input:where([type="button"]) { letter-spacing: 1px; }
  .overlay { position: absolute; inset: 0; }
</style></head><body><div class="app" data-oid="app">
  <h1 class="title" data-oid="title">Title</h1>
  <button class="btn" data-oid="btn">Go</button>
  <div class="card" data-oid="card"><p data-oid="para">Text</p></div>
  <input type="button" data-oid="input" value="Go">
  <div class="overlay" data-oid="overlay"></div>
  <x-panel data-oid="panel"><template shadowrootmode="open"><style>* { box-sizing: border-box; } pre { tab-size: 2; }</style><pre data-oid="code">x</pre></template></x-panel>
</div></body></html>`;

const SLOT_DOCUMENT = `<!doctype html><html><head></head><body>
<x-list data-oid="list" style="display: block">
  <template shadowrootmode="open"><div data-oid="inner"><slot data-oid="slot"><span data-oid="fallback">Fallback</span></slot></div><slot name="extra" data-oid="extra-slot"><span data-oid="extra-fallback">Extra</span></slot></template>
  <button data-oid="a">A</button>
  <button data-oid="b">B</button>
</x-list>
<x-spaced data-oid="spaced">
  <template shadowrootmode="open"><slot data-oid="spaced-slot"><span data-oid="spaced-fallback">Fallback</span></slot></template>
</x-spaced>
<x-bare data-oid="bare"><template shadowrootmode="open"><slot data-oid="bare-slot"><span data-oid="bare-fallback">Fallback</span></slot></template></x-bare>
</body></html>`;

const DARK_SHADOW_DOCUMENT = `<!doctype html><html><head></head><body>
<main data-oid="sheet" style="background-color: rgb(13, 13, 13); color: rgb(250, 250, 250)">
  <x-badge data-oid="badge"><template shadowrootmode="open"><span data-oid="label">New release</span></template></x-badge>
  <span data-oid="light-label">Light DOM</span>
</main>
</body></html>`;

describe("which authored rules name a layer", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await fixture(browser, RULE_SCOPE_DOCUMENT);
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function scopes(nodeId: string, properties: readonly string[]) {
    const { result } = await request<DesignRuntimeNodeDetails>(page, "getNodeDetails", { nodeId });
    return {
      scopes: Object.fromEntries(properties.map((property) => [property, result.authoredStyles?.[property]?.scope ?? null])),
      base: result.baseStyleProperties ?? [],
    };
  }

  it("counts every matching selector of a list, in either order", async () => {
    expect(await scopes("title", ["cursor"])).toMatchObject({ scopes: { cursor: "element" } });
    expect((await scopes("title", ["cursor"])).base).not.toContain("cursor");
    expect(await scopes("btn", ["user-select"])).toMatchObject({ scopes: { "user-select": "element" } });
  });

  it("keeps contextual tag rules and leaves universal and bare tag rules as shared", async () => {
    const paragraph = await scopes("para", ["text-indent", "word-spacing", "tab-size"]);
    expect(paragraph.scopes).toEqual({ "text-indent": "element", "word-spacing": "base", "tab-size": "base" });
    expect(paragraph.base).toEqual(expect.arrayContaining(["word-spacing", "tab-size"]));
    expect(paragraph.base).not.toContain("text-indent");
    expect((await scopes("input", ["letter-spacing"])).scopes).toEqual({ "letter-spacing": "base" });
  });

  it("keeps inset sides with the class rule that pins them", async () => {
    const { result } = await request<DesignRuntimeNodeDetails>(page, "getNodeDetails", { nodeId: "overlay" });
    const sides = ["top", "right", "bottom", "left"];
    expect(result.authoredStyleProperties).toEqual(expect.arrayContaining(sides));
    expect((result.baseStyleProperties ?? []).filter((property) => sides.includes(property))).toEqual([]);
  });

  it("treats a shadow stylesheet's tag rules as the component's own, but not its universal reset", async () => {
    const code = await scopes("code", ["tab-size", "box-sizing"]);
    expect(code.scopes).toEqual({ "tab-size": "element", "box-sizing": "base" });
    expect(code.base).toEqual(["box-sizing"]);
  });
});

describe("slots in the design runtime", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await fixture(browser, SLOT_DOCUMENT);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("lists assigned elements under their slot and fallback only where it renders", async () => {
    const { result: snapshot } = await request<DesignRuntimeSnapshot>(page, "getSnapshot", {});
    const ids = (oid: string) => find(snapshot.tree, oid)?.children.map((child) => child.oid);
    expect(ids("list")).toEqual(["inner", "extra-slot"]);
    expect(ids("slot")).toEqual(["a", "b"]);
    expect(ids("extra-slot")).toEqual(["extra-fallback"]);
    // Whitespace around the template is assigned to the default slot.
    expect(ids("spaced-slot")).toEqual([]);
    expect(ids("bare-slot")).toEqual(["bare-fallback"]);
  });

  it("keeps a slotted layer's parent in source, where it is reordered", async () => {
    const { result: button } = await request<DesignRuntimeNodeDetails>(page, "getNodeDetails", { nodeId: "b" });
    expect(button.layout?.parentId).toBe("list");
  });
});

describe("audits of shadow content", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("measures shadow text against the backgrounds it renders over", async () => {
    const page = await fixture(browser, DARK_SHADOW_DOCUMENT);
    const { result: snapshot } = await request<DesignRuntimeSnapshot>(page, "getSnapshot", {});
    const contrast = snapshot.warnings.filter((warning) => warning.ruleId === "contrast").map((warning) => warning.oid);
    expect(contrast).not.toContain("label");
    expect(contrast).not.toContain("light-label");
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

const AUDITED_DOCUMENT = `<!doctype html><html><head><style>body { margin: 0; font: 16px/20px sans-serif; } p { margin: 0 0 8px; padding: 4px 8px; }</style></head><body>
<p data-oid="oklch" style="background-color: oklch(0.968 0.007 247.896); color: oklch(0.208 0.042 265.755)">Dark text on a light oklch fill</p>
<p data-oid="faint" style="background-color: oklch(0.9 0 0); color: oklch(0.8 0 0)">Faint oklch text</p>
<p data-oid="lab" style="background-color: lab(97 0 0); color: lch(20 10 270)">Dark lab text</p>
<p data-oid="p3" style="background-color: color(display-p3 0 0 0); color: color(display-p3 1 1 1)">White on black in display-p3</p>
<p data-oid="ellipsis" style="width: 100px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis">A long file name that is cut off at the end.pdf</p>
<p data-oid="clipped" style="width: 100px; overflow: hidden; white-space: nowrap">A long file name that is cut off at the end.pdf</p>
<p data-oid="clamp" style="width: 100px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden">A paragraph long enough to need more than the two lines its clamp allows here.</p>
</body></html>`;

describe("audits of authored colours and clipped text", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("measures contrast in the colour space each value is written in, and skips text cut off on purpose", async () => {
    const page = await fixture(browser, AUDITED_DOCUMENT);
    const { result: snapshot } = await request<DesignRuntimeSnapshot>(page, "getSnapshot", {});
    const flagged = (ruleId: string) => snapshot.warnings.filter((warning) => warning.ruleId === ruleId).map((warning) => warning.oid).sort();
    expect(flagged("contrast")).toEqual(["faint"]);
    expect(flagged("overflow")).toEqual(["clipped"]);
    await page.close();
  });
});
