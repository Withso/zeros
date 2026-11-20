import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DESIGN_RUNTIME_SOURCE, designComponentPartNodeId, type DesignRuntimeFrameChanges } from "@zeros/protocol/design-runtime";
import type { DesignFramesChange } from "@zeros/protocol/messages";

import { createDesignFrame, createDesignPage, DESIGN_DIRECTORY_NAME, lintDesignDocument, prepareDesignNavigationFrames, readDesignFrameRenderIdentity, readDesignNavigationSnapshot } from "../document";
import { readCanvas, writeCanvas } from "../document-storage";
import { designDocumentIdForFrame, getWorkspaceDesignApi } from "../design-api";
import { DesignFrameChanges } from "../frame-changes";
import { prepareFrameRenderSource } from "../render-preparation";
import { readDesignProtocolResource } from "../protocol-resource";
import { designDirectoryEntry } from "../metadata";

const doc = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const declaration = '<template data-zd-options><zd-option name="size" type="number" default="12" unit="px"></zd-option>' +
  '<zd-variant name="compact" size="8"></zd-variant></template>';
const mainSource = (rootStyle = "padding-left: 12px; color: rebeccapurple", partStyle = "padding-left: 8px") => doc(
  `<main class="root" data-oid="root" style="${rootStyle}"><span class="label" data-oid="label" style="${partStyle}">Main</span></main>`,
  declaration + '<style>.root { padding-left: 1px; color: black; } .label { display: block; padding-left: 2px; }</style>',
);
const PART = designComponentPartNodeId("host", "label");
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
type RuntimeWindow = Window & {
  __zerosDesignSourceVersion: string;
  runtimeRequest(method: string, args: Record<string, unknown>): Promise<{ result?: unknown; error?: unknown }>;
};

describe("registered linked copies through production expansion and runtime", () => {
  let browser: Browser;
  let root: string;
  let main: string;
  let copy: string;
  let pages: Page[];
  const file = (name: string) => path.join(root, DESIGN_DIRECTORY_NAME, name);
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zeros-linked-regression-")); pages = []; });
  afterEach(async () => { await Promise.all(pages.map((page) => page.close())); await rm(root, { recursive: true, force: true }); });

  async function setup(source = mainSource(), attributes = "", separatePage = false) {
    main = (await createDesignFrame(root, { title: "Main" })).file;
    const page = separatePage ? await createDesignPage(root, { title: "Copies" }) : null;
    copy = (await createDesignFrame(root, { title: "Copy", ...(page ? { pageId: page.id } : {}) })).file;
    await writeFile(file(main), source);
    await writeFile(file(copy), doc(`<zd-card data-oid="host" data-zeros-frame-root ${attributes}></zd-card>`));
    const canvas = await readCanvas(root);
    canvas.frame_info[main] = { ...canvas.frame_info[main]!, component: "card" } as never;
    await writeCanvas(root, canvas);
  }

  async function render() {
    const prepared = await prepareFrameRenderSource(root, await readFile(file(copy), "utf8"), { width: 400, height: 300 },
      undefined, undefined, copy, await readCanvas(root));
    expect(prepared.instances?.hosts.host?.component).toBe("card");
    const page = await browser.newPage();
    pages.push(page);
    const resources: { path: string; status: number; body: Buffer }[] = [];
    await page.route("http://linked.test/**", async (route) => {
      const requested = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
      if (requested === copy) await route.fulfill({ contentType: "text/html", body: prepared.sanitized });
      else {
        const resource = await readDesignProtocolResource(root, { path: requested, sourceVersion: null });
        resources.push({ path: requested, status: resource.status, body: resource.body });
        await route.fulfill({ status: resource.status, headers: resource.headers, body: resource.body });
      }
    });
    await page.goto(`http://linked.test/${copy}`, { waitUntil: "load" });
    await page.evaluate(async ({ source, version }) => {
      const target = window as unknown as RuntimeWindow;
      target.__zerosDesignSourceVersion = version;
      new Function(source)();
      const channel = new MessageChannel();
      const pending = new Map<string, (reply: { result?: unknown; error?: unknown }) => void>();
      let count = 0;
      const ready = new Promise<void>((resolve) => {
        channel.port1.onmessage = ({ data }) => {
          if (data.type === "event" && data.event === "ready") resolve();
          if (data.type === "response") { pending.get(data.requestId)?.(data); pending.delete(data.requestId); }
        };
      });
      target.runtimeRequest = (method, args) => new Promise((resolve) => {
        const requestId = String(++count);
        pending.set(requestId, resolve);
        channel.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request", sourceVersion: version, requestId, method, args });
      });
      channel.port1.start();
      window.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake", sourceVersion: version,
        features: ["getFrameChanges", "getComponentPartAtLoc"] }, "*", [channel.port2]);
      await ready;
      const now = performance.now();
      performance.now = () => now;
    }, { source: DESIGN_RUNTIME_SOURCE, version: prepared.sourceVersion });
    return { page, prepared, resources };
  }

  async function request<T>(page: Page, method: string, args: Record<string, unknown> = {}) {
    const reply = await page.evaluate(({ method, args }) => (window as unknown as RuntimeWindow).runtimeRequest(method, args), { method, args });
    expect(reply.error).toBeUndefined();
    return reply.result as T;
  }
  const changes = (page: Page) => request<DesignRuntimeFrameChanges>(page, "getFrameChanges");
  const computed = (page: Page, property: string) => page.evaluate((property) => [".root", ".label"].map((selector) =>
    getComputedStyle(document.querySelector(selector)!).getPropertyValue(property)), property);
  async function mutate(operation: Record<string, unknown>) {
    const api = getWorkspaceDesignApi(root);
    const opened = await api.open(designDocumentIdForFrame(copy));
    const result = await api.apply({ schemaVersion: 1, transactionId: `tx-${Math.random()}`, documentId: opened.documentId,
      baseRevision: opened.revision, actor: { kind: "human", id: "desktop" }, intent: "Reset copy override", createdAt: 1,
      operations: [{ operationId: "op", ...operation }] } as never);
    expect(result.receipt.status).toBe("applied");
  }
  async function reset(property: string) {
    for (const nodeId of ["host", PART]) await mutate({ type: "node.set-styles", nodeId, styles: { [property]: null }, scope: "auto" });
  }

  it("a: source inline root and part declarations are inherited and not resettable", async () => {
    await setup();
    const { page } = await render();
    expect(await computed(page, "padding-left")).toEqual(["12px", "8px"]);
    const report = await changes(page);
    expect.soft(report.layers).toEqual([]);
    for (const nodeId of ["host", PART]) {
      const details = await request<{ authoredStyles: Record<string, { replaced?: unknown }> }>(page, "getNodeDetails", { nodeId });
      expect.soft(details.authoredStyles["padding-left"]?.replaced).toBeUndefined();
    }
  });

  it.each(["exact-OID", "class"])("a: source %s rules retain their values without becoming own changes", async (kind) => {
    const rootSelector = kind === "exact-OID" ? '[data-oid="root"]' : ".root";
    const partSelector = kind === "exact-OID" ? '[data-oid="label"]' : ".label";
    await setup(doc('<main class="root" data-oid="root"><span class="label" data-oid="label">Main</span></main>', declaration +
      `<style>${rootSelector} { padding-left: 12px; } ${partSelector} { padding-left: 8px; } .root { margin-left: 7px; } .label { margin-left: 5px; }</style>`));
    const { page } = await render();
    expect.soft(await computed(page, "padding-left")).toEqual(["12px", "8px"]);
    expect.soft(await computed(page, "margin-left")).toEqual(["7px", "5px"]);
    expect.soft((await changes(page)).layers).toEqual([]);
    for (const nodeId of ["host", PART]) {
      const details = await request<{ authoredStyles: Record<string, { replaced?: unknown }> }>(page, "getNodeDetails", { nodeId });
      expect.soft(details.authoredStyles["padding-left"]?.replaced).toBeUndefined();
    }
  });

  it("b: same-property root and part overrides are own, with the main inline value as their reset value", async () => {
    await setup(mainSource(), 'style="padding-left: 40px" zd-style-label="padding-left: 32px"');
    const original = await readFile(file(main), "utf8");
    const { page } = await render();
    expect(await computed(page, "padding-left")).toEqual(["40px", "32px"]);
    const report = await changes(page);
    for (const [oid, own, inherited] of [["host", "40px", "12px"], [PART, "32px", "8px"]]) {
      expect.soft(report.layers.find((layer) => layer.oid === oid)?.changes).toContainEqual(expect.objectContaining({
        property: "padding-left", value: own, replaced: expect.objectContaining({ value: inherited }),
      }));
    }
    await reset("padding-left");
    const restored = await render();
    expect.soft(await computed(restored.page, "padding-left")).toEqual(["12px", "8px"]);
    expect.soft((await changes(restored.page)).layers).toEqual([]);
    expect(await readFile(file(main), "utf8")).toBe(original);
    expect(await readFile(file(copy), "utf8")).not.toMatch(/data-zd-(?:own|source)-style/);
    expect(hash(await readFile(file(main), "utf8"))).toBe(hash(original));
  });

  it("b: engine reset removes only authored copy overrides and leaves main bytes unchanged", async () => {
    await setup(mainSource(), 'style="padding-left: 40px" zd-style-label="padding-left: 32px"');
    const original = await readFile(file(main), "utf8");
    await render();
    await reset("padding-left");
    const { page } = await render();
    expect(await computed(page, "padding-left")).toEqual(["12px", "8px"]);
    expect(await readFile(file(main), "utf8")).toBe(original);
  });

  it("a: duplicate physical source OIDs remain CSS-only across instances", async () => {
    await setup();
    await writeFile(file(copy), doc('<zd-card data-oid="host" data-zeros-frame-root></zd-card><zd-card data-oid="other"></zd-card>'));
    const { page } = await render();
    expect(await page.locator('[data-oid="label"]').count()).toBe(2);
    for (const nodeId of ["root", "label"]) {
      const reply = await page.evaluate((nodeId) => (window as unknown as RuntimeWindow).runtimeRequest("getNodeDetails", { nodeId }), nodeId);
      expect(reply.error).toBeDefined();
    }
    for (const host of ["host", "other"]) {
      const part = await request<{ oid: string }>(page, "getNodeDetails", { nodeId: designComponentPartNodeId(host, "label") });
      expect(part.oid).toBe(designComponentPartNodeId(host, "label"));
    }
    expect((await changes(page)).layers).toEqual([]);
  });

  it("b: capture strips provenance and isolates the semantic target rather than a colliding source OID", async () => {
    await setup(mainSource(), 'style="padding-left: 40px" zd-style-label="padding-left: 32px"');
    await writeFile(file(copy), (await readFile(file(copy), "utf8")).replace("</body>", '<aside data-oid="label">Capture target</aside></body>'));
    const { page } = await render();
    const seen = await page.evaluate(async () => {
      const serialize = XMLSerializer.prototype.serializeToString;
      const captured: string[] = [];
      const targets: (string | null)[] = [];
      XMLSerializer.prototype.serializeToString = function (node: Node) {
        const target = (node as Element).querySelector('[data-zeros-capture-isolate]');
        targets.push(target?.textContent ?? null);
        const text = serialize.call(this, node);
        captured.push(text);
        return text;
      };
      try {
        const reply = await (window as unknown as RuntimeWindow).runtimeRequest("captureScreenshot", { nodeId: "label", isolate: true });
        return { captured, targets, error: reply.error };
      } finally {
        XMLSerializer.prototype.serializeToString = serialize;
      }
    });
    expect(seen.error).toBeUndefined();
    expect(seen.targets).toEqual(["Capture target"]);
    expect(seen.captured.join("")).not.toMatch(/data-zd-(?:own|source)-style/);
    expect(await page.locator('[data-zd-own-style]').count()).toBe(2);
  });

  it("c: a different overridden property never owns source-only color on root or its inheriting part", async () => {
    await setup(mainSource(), 'style="padding-left: 40px" zd-style-label="padding-left: 32px"');
    const { page } = await render();
    expect(await computed(page, "color")).toEqual(["rgb(102, 51, 153)", "rgb(102, 51, 153)"]);
    const report = await changes(page);
    expect.soft(report.layers.flatMap((layer) => layer.changes.map((change) => change.property))).not.toContain("color");
    for (const nodeId of ["host", PART]) {
      const details = await request<{ authoredStyles: Record<string, { replaced?: unknown }> }>(page, "getNodeDetails", { nodeId });
      expect.soft(details.authoredStyles.color?.replaced).toBeUndefined();
    }
  });

  it("b: copy overrides without an authored baseline remain resettable", async () => {
    await setup(doc('<main class="root" data-oid="root"><span class="label" data-oid="label">Main</span></main>'),
      'style="padding-left: 40px" zd-style-label="padding-left: 32px"');
    const { page } = await render();
    const report = await changes(page);
    for (const oid of ["host", PART]) {
      expect(report.layers.find((layer) => layer.oid === oid)?.changes).toContainEqual(expect.objectContaining({
        property: "padding-left", replaced: expect.objectContaining({ value: "" }),
      }));
      const details = await request<{ authoredStyles: Record<string, { replaced?: unknown }> }>(page, "getNodeDetails", { nodeId: oid });
      expect(details.authoredStyles["padding-left"]?.replaced).toBeDefined();
    }
    await reset("padding-left");
    expect((await changes((await render()).page)).layers).toEqual([]);
  });

  it("b: definition-owned nested host styles remain inherited until the outer copy overrides them", async () => {
    await setup(doc('<main class="root" data-oid="root"><zd-inner class="label" data-oid="inner" style="padding-left: 12px; color: rebeccapurple"></zd-inner></main>', declaration));
    const nested = (await createDesignFrame(root, { title: "Inner" })).file;
    await writeFile(file(nested), doc('<article class="inner-box" data-oid="inner-root" style="padding-left: 6px">Inner</article>', declaration + '<style>.inner-box { padding-left: 1px; }</style>'));
    const canvas = await readCanvas(root);
    canvas.frame_info[nested] = { ...canvas.frame_info[nested]!, component: "inner" } as never;
    await writeCanvas(root, canvas);
    const original = await readFile(file(main), "utf8");
    expect((await changes((await render()).page)).layers).toEqual([]);
    const part = designComponentPartNodeId("host", "inner");
    await mutate({ type: "node.set-styles", nodeId: part, styles: { "padding-left": "40px" }, scope: "auto" });
    expect((await changes((await render()).page)).layers).toEqual([expect.objectContaining({ oid: part,
      changes: [expect.objectContaining({ property: "padding-left", value: "40px", replaced: expect.objectContaining({ value: "12px" }) })] })]);
    await mutate({ type: "node.set-styles", nodeId: part, styles: { "padding-left": null }, scope: "auto" });
    expect((await changes((await render()).page)).layers).toEqual([]);
    expect(await readFile(file(main), "utf8")).toBe(original);
  });

  it.each([
    { name: "main important beats ordinary copy", main: "padding-left: 12px !important", own: "padding-left: 40px", property: "padding-left", value: "40px", rootValue: "12px", partValue: "12px", owns: false },
    { name: "copy important beats ordinary main", main: "padding-left: 12px", own: "padding-left: 40px !important", property: "padding-left", value: "40px", rootValue: "40px", partValue: "40px", owns: true },
    { name: "later important copy beats important main", main: "padding-left: 12px !important", own: "padding-left: 40px !important", property: "padding-left", value: "40px", rootValue: "40px", partValue: "40px", owns: true },
    { name: "main shorthand and copy longhand", main: "padding: 12px", own: "padding-left: 40px", property: "padding-left", value: "40px", rootValue: "40px", partValue: "40px", owns: true },
    { name: "main longhand and copy shorthand", main: "padding-left: 12px", own: "padding: 40px", property: "padding", value: "40px", rootValue: "40px", partValue: "40px", owns: true },
  ])("d: $name preserves priority, ownership and reset", async (scenario) => {
    await setup(mainSource(scenario.main, scenario.main), `style="${scenario.own}" zd-style-label="${scenario.own}"`);
    const original = await readFile(file(main), "utf8");
    const { page } = await render();
    expect.soft(await computed(page, "padding-left")).toEqual([scenario.rootValue, scenario.partValue]);
    const report = await changes(page);
    const inline = await page.evaluate(() => [".root", ".label"].map((selector) => (document.querySelector(selector) as HTMLElement).style.cssText));
    if (scenario.owns) {
      for (const oid of ["host", PART]) expect.soft(report.layers.find((layer) => layer.oid === oid)?.changes ?? [], `CSSOM inline: ${JSON.stringify(inline)}`)
        .toContainEqual(expect.objectContaining({ property: scenario.property, value: scenario.value,
          replaced: expect.objectContaining({ value: scenario.property === "padding" ? "padding-left: 12px" : "12px" }) }));
    } else {
      expect.soft(report.layers.flatMap((layer) => layer.changes)).not.toContainEqual(expect.objectContaining({ property: "padding-left" }));
    }
    await reset(scenario.property);
    const restored = await render();
    expect.soft(await computed(restored.page, "padding-left")).toEqual(["12px", "12px"]);
    expect(await readFile(file(main), "utf8")).toBe(original);
  });

  it("d: a var()-based main shorthand stays the reset value of a copy longhand", async () => {
    const main = "--space: 12px; padding: var(--space)";
    await setup(mainSource(main, main), 'style="padding-left: 40px" zd-style-label="padding-left: 40px"');
    const { page } = await render();
    expect.soft(await computed(page, "padding-left")).toEqual(["40px", "40px"]);
    const report = await changes(page);
    for (const oid of ["host", PART]) {
      expect.soft(report.layers.find((layer) => layer.oid === oid)?.changes ?? []).toContainEqual(expect.objectContaining({
        property: "padding-left", value: "40px", replaced: expect.objectContaining({ value: "padding: var(--space)" }),
      }));
      const details = await request<{ authoredStyles: Record<string, { replaced?: { value?: string } }> }>(page, "getNodeDetails", { nodeId: oid });
      expect.soft(details.authoredStyles["padding-left"]?.replaced?.value).toBe("padding: var(--space)");
    }
  });

  it("b: an in-place style commit on an instance defers to the new render so the override stays own", async () => {
    await setup();
    const { page } = await render();
    const reply = await page.evaluate(() => (window as unknown as RuntimeWindow).runtimeRequest("commitStyles",
      { updates: [{ nodeId: "host", styles: { "padding-left": "40px" } }], nextSourceVersion: "a".repeat(24) }));
    expect(reply.error).toBeDefined();
    expect(await computed(page, "padding-left")).toEqual(["12px", "8px"]);
    await mutate({ type: "node.set-styles", nodeId: "host", styles: { "padding-left": "40px" }, scope: "auto" });
    const saved = await changes((await render()).page);
    expect(saved.layers.find((layer) => layer.oid === "host")?.changes).toContainEqual(expect.objectContaining({
      property: "padding-left", value: "40px", replaced: expect.objectContaining({ value: "12px" }),
    }));
  });

  it.each([false, true])("g: a linked frame copy keeps the main's document context without owning it (frame root wrapper: %s)", async (wrapped) => {
    await setup('<!doctype html><html><head>' + declaration + '<style>body { margin: 0; font-family: Arial, sans-serif; }</style></head>' +
      '<body style="color: rgb(1, 2, 3)"><main class="root" data-oid="root"><span class="label" data-oid="label">Main</span></main></body></html>');
    if (wrapped) await writeFile(file(copy), doc('<main data-oid="frame" data-zeros-frame-root style="display:block; width:100%"><zd-card data-oid="host"></zd-card></main>'));
    const { page } = await render();
    expect(await page.evaluate(() => {
      const root = getComputedStyle(document.querySelector(".root")!);
      return [getComputedStyle(document.body).marginLeft, root.fontFamily, root.color];
    })).toEqual(["0px", "Arial, sans-serif", "rgb(1, 2, 3)"]);
    expect((await changes(page)).layers).toEqual([]);
  });

  it("e: warm-copy invalidation and a variant switch consume edited source and added/renamed variants", async () => {
    const source = doc('<main class="root" data-oid="root"><span class="label" data-oid="label">{{ size }}</span></main>',
      declaration + '<style>.root { padding-left: var(--zd-size); } .label { padding-left: 2px; }</style>');
    await setup(source, 'zd-variant="compact"');
    const navigation = await readDesignNavigationSnapshot(root);
    await prepareDesignNavigationFrames(root, navigation.catalogRevision, [copy]);
    const before = await readDesignFrameRenderIdentity(root, copy);
    const initial = await render();
    expect(await computed(initial.page, "padding-left")).toEqual(["8px", "2px"]);
    const published: DesignFramesChange[] = [];
    const watcher = new DesignFrameChanges({ directory: () => ({ name: DESIGN_DIRECTORY_NAME, id: designDirectoryEntry(root, DESIGN_DIRECTORY_NAME)!.id }),
      publish: (_root, change) => published.push(change) }, 60_000);
    try {
      const edited = source.replace('name="compact" size="8"', 'name="small" size="18"')
        .replace('</template>', '<zd-variant name="wide" size="36"></zd-variant></template>')
        .replace('.label { padding-left: 2px;', '.label { padding-left: 9px;');
      await writeFile(file(main), edited);
      watcher.note(root, file(main));
      await watcher.flush(root);
      expect.soft(published.some((event) => event.all || event.frames?.includes(copy))).toBe(true);
      await mutate({ type: "node.set-attribute", nodeId: "host", attribute: "zd-variant", value: "wide" });
      const next = await render();
      expect.soft(await computed(next.page, "padding-left")).toEqual(["36px", "9px"]);
      expect.soft(next.prepared.sourceVersion).not.toBe(before.sourceVersion);
      expect.soft(next.prepared.instances?.components.card?.elements).toContainEqual(expect.objectContaining({ tag: "zd-variant",
        attributes: expect.arrayContaining([{ name: "name", value: "small" }]) }));
      await mutate({ type: "node.set-attribute", nodeId: "host", attribute: "zd-variant", value: "small" });
      expect.soft(await computed((await render()).page, "padding-left")).toEqual(["18px", "9px"]);
    } finally { watcher.stop(); }
  });

  it.each(["rename", "delete"])("e: a warm linked copy diagnoses its missing main after %s", async (action) => {
    await setup();
    await readDesignFrameRenderIdentity(root, copy);
    await render();
    if (action === "rename") await rename(file(main), `${file(main)}.moved`);
    else await rm(file(main));
    const { prepared } = await render();
    expect(prepared.instances?.hosts.host?.missing).toBe(true);
    expect((await lintDesignDocument(root, copy, { healOids: false, includeRuntimeAudits: false })).violations)
      .toContainEqual(expect.objectContaining({ ruleId: "component-undefined", severity: "error" }));
  });

  it("f: different-page image and CSS URLs resolve against the main, not the copy", async () => {
    await setup(doc('<main class="root" data-oid="root"><img class="label" data-oid="label" src="./assets/icon.png" alt="origin"></main>',
      declaration + '<style>.root { background-image: url(./assets/icon.png); }</style>'), "", true);
    const mainAsset = path.join(path.dirname(file(main)), "assets/icon.png");
    const copyAsset = path.join(path.dirname(file(copy)), "assets/icon.png");
    const encoder = await browser.newPage();
    const images = await encoder.evaluate(() => [1, 2].map((width) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = 1;
      return canvas.toDataURL("image/png").split(",")[1]!;
    }));
    await encoder.close();
    for (const [index, target] of [mainAsset, copyAsset].entries()) {
      await mkdir(path.dirname(target!), { recursive: true });
      await writeFile(target!, Buffer.from(images[index]!, "base64"));
    }
    const preload = `${path.posix.dirname(main)}/assets/icon.png`;
    const preloadReference = path.posix.relative(path.posix.dirname(copy), preload);
    await writeFile(file(copy), (await readFile(file(copy), "utf8")).replace("</head>", `<link rel="preload" as="image" href="${preloadReference}"></head>`));
    const { page, prepared, resources } = await render();
    const expected = `data:image/png;base64,${images[0]}`;
    expect.soft(prepared.sanitized).toContain(`src="${expected}"`);
    const urls = await page.evaluate(() => ({ image: document.querySelector("img")!.getAttribute("src"),
      background: getComputedStyle(document.querySelector(".root")!).backgroundImage }));
    expect.soft(urls.image).toBe(expected);
    expect.soft(urls.background).toContain(expected);
    expect.soft(await page.evaluate(() => document.querySelector("img")!.naturalWidth)).toBe(1);
    await expect.poll(() => resources.find((resource) => resource.path === preload)?.status).toBe(200);
    expect(resources.find((resource) => resource.path === preload)?.body).toEqual(Buffer.from(images[0]!, "base64"));
  });

  it("f: resource delivery rejects SVG, traversal and resources outside assets", async () => {
    await setup();
    const folder = path.posix.dirname(main);
    await mkdir(path.join(path.dirname(file(main)), "assets"), { recursive: true });
    await writeFile(file(`${folder}/assets/icon.svg`), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(file(`${folder}/private.png`), "private");
    for (const resource of [`${folder}/assets/icon.svg`, `${folder}/private.png`, `${folder}/assets/../private.png`, "../private.png", `${folder}/assets/code.js`]) {
      expect((await readDesignProtocolResource(root, { path: resource, sourceVersion: null })).status).toBe(404);
    }
  });
});
