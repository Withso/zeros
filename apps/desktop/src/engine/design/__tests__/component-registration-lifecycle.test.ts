import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodeCanvasFile, encodeCanvasFile } from "../canvas-file";
import { designComponentRenderBytesForTests, rememberDesignComponentRender, resetDesignComponentRendersForTests } from "../component-last-good";
import {
  createDesignFrame,
  createDesignPage,
  deleteDesignFrame,
  DESIGN_DIRECTORY_NAME,
  duplicateDesignFrame,
  listDesignFrames,
  lintDesignDocument,
  readDesignFrameRenderIdentity,
  renameDesignFrame,
  restoreDesignFrame,
  transferDesignNode,
} from "../document";
import { readCanvas, writeCanvas } from "../document-storage";
import { prepareFrameRenderSource } from "../render-preparation";
import { DESIGN_RUNTIME_DOCUMENT_BODY_ID } from "@zeros/protocol/design-runtime";
import { createComponentTemplateBudget, renderComponentTemplate } from "@zeros/design-web/component-template";

describe("a frame registered as a component", () => {
  let root: string;
  const canvasFile = () => path.join(root, DESIGN_DIRECTORY_NAME, "meta", "canvas.json");
  const register = async (file: string, name: string) => {
    const canvas = await readCanvas(root);
    canvas.frame_info[file] = { ...canvas.frame_info[file]!, component: name } as never;
    await writeCanvas(root, canvas);
  };
  const componentOf = async (file: string) => ((await readCanvas(root)).frame_info[file] as { component?: string } | undefined)?.component;

  beforeEach(async () => {
    resetDesignComponentRendersForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-components-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps its registration in the frame's record, through a title change", async () => {
    const frame = await createDesignFrame(root, { title: "Chat composer" });
    await register(frame.file, "chat-composer");
    const records = Object.values(JSON.parse(await readFile(canvasFile(), "utf8")).frames) as { source: string; component?: string }[];
    expect(records.find((record) => record.source === frame.file)?.component).toBe("chat-composer");
    await renameDesignFrame(root, frame.file, "Composer");
    expect(await componentOf(frame.file)).toBe("chat-composer");
  });

  it("does not pass its registration to a duplicate", async () => {
    const frame = await createDesignFrame(root, { title: "Chat composer" });
    await register(frame.file, "chat-composer");
    const copy = await duplicateDesignFrame(root, frame.file);
    expect(await componentOf(copy.file)).toBeUndefined();
    expect(await componentOf(frame.file)).toBe("chat-composer");
  });

  it("keeps an unregistered declaration as an authored copy", async () => {
    const main = await createDesignFrame(root, { title: "Unregistered declaration" });
    const source = '<!doctype html><html><head><template data-zd-options><zd-option name="width" type="number" default="400"></zd-option><zd-variant name="compact" width="320"></zd-variant></template></head><body><div data-oid="main">Authored main</div></body></html>';
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), source);
    const sourceVersion = (await readDesignFrameRenderIdentity(root, main.file)).sourceVersion;
    const copy = await duplicateDesignFrame(root, main.file, { sourceVersion, componentCopy: { variant: "compact" } });
    const copiedSource = await readFile(path.join(root, DESIGN_DIRECTORY_NAME, copy.file), "utf8");
    expect(copiedSource).toContain("<template data-zd-options>");
    expect(copiedSource).toContain('name="compact" width="320"');
    expect(copiedSource).not.toContain("<zd-unregistered-declaration");
    expect(await componentOf(copy.file)).toBeUndefined();
  });

  it("validates linked variants only from direct options in the head", async () => {
    const main = await createDesignFrame(root, { title: "Chat composer" });
    const source = '<!doctype html><html><head><template data-zd-options>' +
      '<zd-variant name="compact"></zd-variant><div><zd-variant name="nested"></zd-variant></div>' +
      '</template></head><body><template data-zd-options><zd-variant name="body"></zd-variant></template>' +
      '<main data-oid="cc-root"></main></body></html>';
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), source);
    await register(main.file, "chat-composer");
    const sourceVersion = (await readDesignFrameRenderIdentity(root, main.file)).sourceVersion;
    await expect(duplicateDesignFrame(root, main.file, { sourceVersion, componentCopy: { variant: "body" } }))
      .rejects.toThrow(/no longer declares/);
    await expect(duplicateDesignFrame(root, main.file, { sourceVersion, componentCopy: { variant: "nested" } }))
      .rejects.toThrow(/no longer declares/);
  });

  it("duplicates a whole registered frame into another frame as a linked host", async () => {
    const main = await createDesignFrame(root, { title: "Chat composer" });
    const destination = await createDesignFrame(root, { title: "Board" });
    const source = '<!doctype html><html><head><template data-zd-options><zd-variant name="compact" width="420"></zd-variant></template><style>.main-definition { color: red; }</style></head><body><div data-oid="main">Authored component</div></body></html>';
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), source);
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, destination.file), '<!doctype html><html><head></head><body><section data-oid="board" style="position:relative"></section></body></html>');
    await register(main.file, "chat-composer");
    const sourceVersion = (await readDesignFrameRenderIdentity(root, main.file)).sourceVersion;
    const destinationSourceVersion = (await readDesignFrameRenderIdentity(root, destination.file)).sourceVersion;
    const transfer = await transferDesignNode(root, {
      frame: main.file,
      sourceVersion,
      nodeId: DESIGN_RUNTIME_DOCUMENT_BODY_ID,
      duplicateNodeId: "copy",
      componentCopy: { variant: "compact" },
      destinationFrame: destination.file,
      destinationSourceVersion,
      parentId: "board",
      relocation: { width: main.width, height: main.height, matrix: [1, 0, 0, 1, 20, 30], inheritedStyles: {} },
      geometry: { x: 20, y: 30, w: main.width, h: main.height, z: 1 },
    });
    const destinationSource = await readFile(path.join(root, DESIGN_DIRECTORY_NAME, destination.file), "utf8");
    expect(transfer.frame).toBe(destination.file);
    expect(destinationSource).toContain('<zd-chat-composer data-oid="');
    expect(destinationSource).toContain('zd-variant="compact"');
    expect(destinationSource).not.toContain("main-definition");
    expect(await readFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), "utf8")).toBe(source);
  });

  it("duplicates a runtime component-root id into another frame as a linked host", async () => {
    const main = await createDesignFrame(root, { title: "Chat composer" });
    const destination = await createDesignFrame(root, { title: "Board" });
    const source = '<!doctype html><html><head><template data-zd-options><zd-variant name="compact"></zd-variant></template></head><body><main data-oid="cc-root"><p data-oid="cc-copy">Copy</p></main></body></html>';
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), source);
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, destination.file), '<!doctype html><html><head></head><body><section data-oid="board" style="position:relative"></section></body></html>');
    await register(main.file, "chat-composer");
    const sourceVersion = (await readDesignFrameRenderIdentity(root, main.file)).sourceVersion;
    const destinationSourceVersion = (await readDesignFrameRenderIdentity(root, destination.file)).sourceVersion;
    await transferDesignNode(root, {
      frame: main.file,
      sourceVersion,
      nodeId: "cc-root",
      duplicateNodeId: "copy",
      componentCopy: { variant: "compact" },
      destinationFrame: destination.file,
      destinationSourceVersion,
      parentId: "board",
      relocation: { width: main.width, height: main.height, matrix: [1, 0, 0, 1, 20, 30], inheritedStyles: {} },
      geometry: { x: 20, y: 30, w: main.width, h: main.height, z: 1 },
    });
    const destinationSource = await readFile(path.join(root, DESIGN_DIRECTORY_NAME, destination.file), "utf8");
    expect(destinationSource).toContain('<zd-chat-composer data-oid="');
    expect(destinationSource).toContain('zd-variant="compact"');
    expect(destinationSource).not.toContain("cc-copy");
    expect(await readFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), "utf8")).toBe(source);
  });

  it("keeps an unregistered semantic frame root direct when frame-copy intent is present", async () => {
    const main = await createDesignFrame(root, { title: "Ordinary frame" });
    const destination = await createDesignFrame(root, { title: "Board" });
    const source = '<!doctype html><html><head></head><body><main data-oid="shell" data-zeros-frame-root style="height:100vh"><zd-card data-oid="card" heading="Welcome" zd-variant="compact" zd-style-card="padding: 4px"><p data-oid="slot-fill" slot="content">Slotted content</p></zd-card><footer data-oid="bottom" style="position:absolute;bottom:0">Bottom anchored</footer></main></body></html>';
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), source);
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, destination.file), '<!doctype html><html><head></head><body><section data-oid="board" style="position:relative"></section></body></html>');
    const sourceVersion = (await readDesignFrameRenderIdentity(root, main.file)).sourceVersion;
    const destinationSourceVersion = (await readDesignFrameRenderIdentity(root, destination.file)).sourceVersion;
    await transferDesignNode(root, {
      frame: main.file,
      sourceVersion,
      nodeId: "shell",
      duplicateNodeId: "copy-shell",
      componentCopy: { variant: null },
      destinationFrame: destination.file,
      destinationSourceVersion,
      parentId: "board",
      relocation: { width: main.width, height: main.height, matrix: [1, 0, 0, 1, 20, 30], inheritedStyles: {} },
      geometry: { x: 20, y: 30, w: main.width, h: main.height, z: 1 },
      styles: { position: "absolute", top: "30px", left: "20px", width: "100%", height: "100vh" },
    });
    const destinationSource = await readFile(path.join(root, DESIGN_DIRECTORY_NAME, destination.file), "utf8");
    expect(destinationSource).toMatch(/<section[^>]*data-oid="board"[^>]*><main[^>]*data-oid="copy-shell"/);
    expect(destinationSource).toContain('<zd-card data-oid="copy-shell-card" heading="Welcome" zd-variant="compact" zd-style-card="padding: 4px">');
    expect(destinationSource).toContain('<p data-oid="copy-shell-slot-fill" slot="content">Slotted content</p>');
    expect(destinationSource).toMatch(/data-oid="copy-shell"[^>]*height:\s*900px/);
    expect(destinationSource).toMatch(/data-oid="copy-shell"[^>]*>[^]*<footer[^>]*data-oid="copy-shell-bottom"[^>]*style="position:absolute;bottom:0"/);
    expect(destinationSource).not.toMatch(/data-oid="copy-shell"[^>]*><main/);
    const destinationIds = Array.from(destinationSource.matchAll(/data-oid="([^"]+)"/g), (match) => match[1]);
    expect(new Set(destinationIds).size).toBe(destinationIds.length);
    expect(await readFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), "utf8")).toBe(source);
  });

  it("keeps component-instance relocation protection for generic root moves", async () => {
    const main = await createDesignFrame(root, { title: "Ordinary frame" });
    const destination = await createDesignFrame(root, { title: "Board" });
    const source = '<!doctype html><html><head></head><body><main data-oid="shell" data-zeros-frame-root><zd-card data-oid="card"><p data-oid="slot-fill" slot="content">Slotted content</p></zd-card></main></body></html>';
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), source);
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, destination.file), '<!doctype html><html><head></head><body><section data-oid="board"></section></body></html>');
    const sourceVersion = (await readDesignFrameRenderIdentity(root, main.file)).sourceVersion;
    const destinationSourceVersion = (await readDesignFrameRenderIdentity(root, destination.file)).sourceVersion;
    await expect(transferDesignNode(root, {
      frame: main.file,
      sourceVersion,
      nodeId: "shell",
      destinationFrame: destination.file,
      destinationSourceVersion,
      parentId: "board",
      relocation: { width: main.width, height: main.height, matrix: [1, 0, 0, 1, 20, 30], inheritedStyles: {} },
      geometry: { x: 20, y: 30, w: main.width, h: main.height, z: 1 },
    })).rejects.toThrow(/component instance/);
  });

  it.each([
    ["conditional top-level siblings", '<div data-oid="a" data-zd-if="toolbar">Toolbar</div><div data-oid="b" data-zd-if="!toolbar">No toolbar</div>', "a", "b"],
    ["conditional templates", '<template data-zd-if="toolbar"><div data-oid="compact-root">Compact</div></template><template data-zd-if="!toolbar"><div data-oid="default-root">Default</div></template>', "compact-root", "default-root"],
  ])("copies a registered main with %s as a named linked variant", async (_shape, body, runtimeRootId, omittedRootId) => {
    const main = await createDesignFrame(root, { title: "Conditional component" });
    const destination = await createDesignFrame(root, { title: "Board" });
    const source = '<!doctype html><html><head><template data-zd-options><zd-option name="toolbar" type="boolean" default="false"></zd-option><zd-variant name="compact" toolbar="true"></zd-variant></template></head><body>' + body + '</body></html>';
    const evaluated = renderComponentTemplate(source, {
      scope: new Map([["toolbar", true]]),
      ids: "copy",
      budget: createComponentTemplateBudget(),
      document: true,
    });
    expect(evaluated).toContain(`data-oid="${runtimeRootId}"`);
    expect(evaluated).not.toContain(`data-oid="${omittedRootId}"`);
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), source);
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, destination.file), '<!doctype html><html><head></head><body><section data-oid="board" style="position:relative"></section></body></html>');
    await register(main.file, "conditional-card");
    const sourceVersion = (await readDesignFrameRenderIdentity(root, main.file)).sourceVersion;
    const destinationSourceVersion = (await readDesignFrameRenderIdentity(root, destination.file)).sourceVersion;
    await transferDesignNode(root, {
      frame: main.file,
      sourceVersion,
      nodeId: runtimeRootId,
      duplicateNodeId: "copy-conditional",
      componentCopy: { variant: "compact" },
      destinationFrame: destination.file,
      destinationSourceVersion,
      parentId: "board",
      relocation: { width: main.width, height: main.height, matrix: [1, 0, 0, 1, 20, 30], inheritedStyles: {} },
      geometry: { x: 20, y: 30, w: main.width, h: main.height, z: 1 },
    });
    const destinationSource = await readFile(path.join(root, DESIGN_DIRECTORY_NAME, destination.file), "utf8");
    expect(destinationSource).toMatch(/<zd-conditional-card data-oid="copy-conditional-o-[a-f0-9]+" zd-variant="compact">/);
    expect(await readFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), "utf8")).toBe(source);
  });

  it.each([
    [null, null],
    ["compact", 'zd-variant="compact"'],
    ["hover", null],
  ] as const)("duplicates a registered main as a linked instance for %s", async (variant, expectedAttribute) => {
    const main = await createDesignFrame(root, { title: "Chat composer" });
    const otherPage = await createDesignPage(root, { title: "Other page" });
    const mainPageFolder = main.file.split("/")[0]!;
    const mainAsset = path.join(root, DESIGN_DIRECTORY_NAME, mainPageFolder, "assets", "icon.svg");
    const otherAsset = path.join(root, DESIGN_DIRECTORY_NAME, otherPage.folder, "assets", "icon.svg");
    await mkdir(path.dirname(mainAsset), { recursive: true });
    await mkdir(path.dirname(otherAsset), { recursive: true });
    await writeFile(mainAsset, '<svg id="component-origin"></svg>');
    await writeFile(otherAsset, '<svg id="destination-origin"></svg>');
    const source = '<!doctype html><html><head><title>Chat composer</title><template data-zd-options>' +
      '<zd-option name="width" type="number" default="1120"></zd-option>' +
      '<zd-variant name="compact" width="420"></zd-variant>' +
      '<zd-variant name="hover" zd-state="hover"></zd-variant>' +
      '</template><style>.main-definition { color: red; }</style></head>' +
      '<body><div class="main-definition" data-oid="root"><img data-oid="icon" src="./assets/icon.svg" alt="component asset"></div></body></html>';
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), source);
    await register(main.file, "chat-composer");
    const sourceVersion = (await readDesignFrameRenderIdentity(root, main.file)).sourceVersion;
    const linked = await duplicateDesignFrame(root, main.file, {
      pageId: otherPage.id,
      sourceVersion,
      componentCopy: { variant },
      geometry: { x: 800, y: 640, w: main.width, h: main.height, z: 2 },
    });
    const linkedSource = await readFile(path.join(root, DESIGN_DIRECTORY_NAME, linked.file), "utf8");
    const hostId = linkedSource.match(/<zd-chat-composer data-oid="([^"]+)"/)?.[1];
    const identities = [...linkedSource.matchAll(/data-oid="([^"]+)"/g)].map((match) => match[1]);
    expect(linkedSource).toContain(`<zd-chat-composer data-oid="${hostId}"`);
    expect(hostId).toBeTruthy();
    expect(hostId).not.toBe("root");
    expect(new Set(identities).size).toBe(identities.length);
    if (expectedAttribute) expect(linkedSource).toContain(expectedAttribute);
    else expect(linkedSource).not.toMatch(/<zd-chat-composer[^>]*\s+zd-variant=/);
    expect(linkedSource).not.toContain("main-definition");
    expect(linkedSource).not.toContain("<img");
    expect(await readFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), "utf8")).toBe(source);
    expect(linked).toMatchObject({ kind: main.kind, x: 800, y: 640, width: main.width, height: main.height });
    expect(await componentOf(linked.file)).toBeUndefined();
    const expanded = await prepareFrameRenderSource(root, linkedSource, { width: 400, height: 300 }, undefined, undefined, linked.file, await readCanvas(root));
    expect(expanded.sanitized).toContain("component asset");
    expect(expanded.sanitized).toContain(`src="${path.posix.relative(otherPage.folder, `${mainPageFolder}/assets/icon.svg`)}"`);
    expect(expanded.sanitized).not.toContain(`src="./assets/icon.svg"`);
  });

  it("rejects unknown or stale linked component copies without changing the source", async () => {
    const main = await createDesignFrame(root, { title: "Chat composer" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file),
      '<!doctype html><html><head><template data-zd-options><zd-variant name="compact"></zd-variant></template></head><body><b data-oid="root">Main</b></body></html>');
    await register(main.file, "chat-composer");
    const source = await readFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), "utf8");
    const sourceVersion = (await readDesignFrameRenderIdentity(root, main.file)).sourceVersion;
    await expect(duplicateDesignFrame(root, main.file, {
      sourceVersion,
      componentCopy: { variant: "missing" },
    })).rejects.toThrow(/variant/i);
    await expect(duplicateDesignFrame(root, main.file, {
      sourceVersion: "0".repeat(24),
      componentCopy: { variant: null },
    })).rejects.toThrow(/changed/i);
    await expect(duplicateDesignFrame(root, main.file, {
      componentCopy: { variant: null },
    })).rejects.toThrow(/source frame changed/i);
    expect(await readFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), "utf8")).toBe(source);
    expect((await listDesignFrames(root)).filter((frame) => frame.file !== main.file)).toHaveLength(0);
  });

  it("serializes concurrent linked copies with collision-safe names", async () => {
    const main = await createDesignFrame(root, { title: "Chat composer" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file),
      '<!doctype html><html><head></head><body><b data-oid="root">Main</b></body></html>');
    await register(main.file, "chat-composer");
    const sourceVersion = (await readDesignFrameRenderIdentity(root, main.file)).sourceVersion;
    const copies = await Promise.all(Array.from({ length: 3 }, () => duplicateDesignFrame(root, main.file, {
      sourceVersion,
      componentCopy: { variant: null },
    })));
    expect(new Set(copies.map((copy) => copy.file)).size).toBe(3);
    expect(copies.map((copy) => copy.file)).toEqual(expect.arrayContaining([
      "page-1/chat-composer-copy.html",
      "page-1/chat-composer-copy-2.html",
      "page-1/chat-composer-copy-3.html",
    ]));
  });

  it("comes back to its place on the page on undo, leaving the canvas file as it was", async () => {
    const first = await createDesignFrame(root, { title: "Before" });
    const main = await createDesignFrame(root, { title: "Chat composer" });
    await createDesignFrame(root, { title: "After" });
    await register(main.file, "chat-composer");
    const before = await readFile(canvasFile(), "utf8");
    expect(JSON.parse(before).pages[0].frames.indexOf(main.frameId)).toBe(1);
    const restorePoint = await deleteDesignFrame(root, main.file);
    await restoreDesignFrame(root, restorePoint);
    expect(await readFile(canvasFile(), "utf8")).toBe(before);
    expect(first.file).not.toBe(main.file);
  });

  it("loses its registration and its last good render when deleted, and gets them back on undo", async () => {
    const frame = await createDesignFrame(root, { title: "Chat composer" });
    await register(frame.file, "chat-composer");
    rememberDesignComponentRender(root, frame.file, "<html></html>");
    const restorePoint = await deleteDesignFrame(root, frame.file);
    expect(designComponentRenderBytesForTests().frames).toBe(0);
    expect(await componentOf(frame.file)).toBeUndefined();
    await restoreDesignFrame(root, restorePoint);
    expect(await componentOf(frame.file)).toBe("chat-composer");
  });

  it("renders as an instance in another frame through its registration", async () => {
    const main = await createDesignFrame(root, { title: "Chat composer" });
    const host = await createDesignFrame(root, { title: "Workspace" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file),
      '<!doctype html><html><head><template data-zd-options>\n<zd-option name="width" type="number" default="1120" unit="px"></zd-option>\n</template>' +
        '<style>.c { width: var(--zd-width); }</style></head><body><div class="c" data-oid="root">Composer</div></body></html>');
    await register(main.file, "chat-composer");
    const source = '<!doctype html><html><head></head><body><zd-chat-composer data-oid="ws" width="800"></zd-chat-composer></body></html>';
    const canvas = await readCanvas(root);
    const render = await prepareFrameRenderSource(root, source, { width: 400, height: 300 }, undefined, undefined, host.file, canvas);
    expect(render.sanitized).toContain('<div class="c" data-zd-part="root" data-zd-root="">Composer</div>');
    expect(render.sanitized).toContain("--zd-width: 800px;");
    expect(render.componentOptions).toBeUndefined();
  });
});

describe("instances of a component that is no longer there", () => {
  let root: string;
  const MAIN = '<!doctype html><html><head><template data-zd-options>\n<zd-option name="label" type="text" default="Chip"></zd-option>\n</template></head>' +
    '<body><b data-oid="root">{{ label }}</b></body></html>';
  const HOST = '<!doctype html><html><head></head><body><p data-oid="p">Before</p><zd-chip data-oid="ws" label="Hi"></zd-chip></body></html>';
  const LEGACY = '<!doctype html><html><head></head><body><b data-zid="b">Chip</b></body></html>';
  const register = async (file: string, name: string) => {
    const canvas = await readCanvas(root);
    canvas.frame_info[file] = { ...canvas.frame_info[file]!, component: name } as never;
    await writeCanvas(root, canvas);
  };

  beforeEach(async () => {
    resetDesignComponentRendersForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-components-gone-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["its main frame is deleted", async (main: string) => { await deleteDesignFrame(root, main); }],
    ["its main frame's file is renamed on disk", async (main: string) => {
      await rename(path.join(root, DESIGN_DIRECTORY_NAME, main), path.join(root, DESIGN_DIRECTORY_NAME, main.replace(/\.html$/, "-old.html")));
    }],
    ["its main frame is registered under another name", async (main: string) => { await register(main, "badge"); }],
  ])("reports each instance on its host frame when %s, and the host still renders", async (_case, lose) => {
    const main = await createDesignFrame(root, { title: "Chip" });
    const host = await createDesignFrame(root, { title: "Workspace" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), MAIN);
    await register(main.file, "chip");
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, host.file), HOST);
    const placed = await prepareFrameRenderSource(root, HOST, { width: 400, height: 300 }, undefined, undefined, host.file, await readCanvas(root));
    expect(placed.instances?.hosts.ws).toMatchObject({ component: "chip" });
    await lose(main.file);
    const lint = (await lintDesignDocument(root, host.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(lint).toContainEqual(expect.objectContaining({ ruleId: "component-undefined", severity: "error", oid: "ws" }));
    const render = await prepareFrameRenderSource(root, HOST, { width: 400, height: 300 }, undefined, undefined, host.file, await readCanvas(root));
    expect(render.sanitized).toContain('<p data-oid="p">Before</p>');
    expect(render.instances?.hosts).toEqual({ ws: { component: "chip", attributes: {}, missing: true } });
    expect(render.instances?.components).toEqual({});
  });

  it.each([
    ["its main frame's file is over the size limit", async (main: string) => {
      await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main), MAIN.replace("</body>", `<p>${"x".repeat(600 * 1024)}</p></body>`));
    }],
    ["its name is also a components/ file", async () => {
      await mkdir(path.join(root, DESIGN_DIRECTORY_NAME, "components"), { recursive: true });
      await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, "components", "chip.html"), MAIN);
    }],
  ])("does not call a component missing when it is there but cannot be used because %s", async (_case, spoil) => {
    const main = await createDesignFrame(root, { title: "Chip" });
    const host = await createDesignFrame(root, { title: "Workspace" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), MAIN);
    await register(main.file, "chip");
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, host.file), HOST);
    await spoil(main.file);
    const render = await prepareFrameRenderSource(root, HOST, { width: 400, height: 300 }, undefined, undefined, host.file, await readCanvas(root));
    expect(render.sanitized).toContain('<p data-oid="p">Before</p>');
    expect(render.instances?.hosts.ws).toBeUndefined();
    const lint = (await lintDesignDocument(root, host.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(lint.some((violation) => violation.oid === "ws" || /zd-chip/.test(violation.message))).toBe(true);
  });
  it("names the registered file that is missing, in one row", async () => {
    const main = await createDesignFrame(root, { title: "Chip" });
    const host = await createDesignFrame(root, { title: "Workspace" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), MAIN);
    await register(main.file, "chip");
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, host.file), HOST);
    await rename(path.join(root, DESIGN_DIRECTORY_NAME, main.file), path.join(root, DESIGN_DIRECTORY_NAME, main.file.replace(/\.html$/, "-old.html")));
    const lint = (await lintDesignDocument(root, host.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(lint.filter((violation) => violation.oid === "ws" || /zd-chip/.test(violation.message))).toEqual([expect.objectContaining({
      ruleId: "component-undefined", severity: "error", oid: "ws",
      message: `Component <zd-chip> is registered to ${main.file}, which is missing.`,
      fix: `Restore ${main.file}, register another frame as zd-chip in meta/canvas.json, or replace the component instance.`,
    })]);
  });

  it("keeps a generated missing-component instance diagnosable through host rename and delete", async () => {
    const main = await createDesignFrame(root, { title: "Chip" });
    const source = '<!doctype html><html><head><template data-zd-options>' +
      '<zd-variant name="compact"></zd-variant></template></head><body><b data-oid="root">Chip</b></body></html>';
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), source);
    await register(main.file, "chip");
    const sourceVersion = (await readDesignFrameRenderIdentity(root, main.file)).sourceVersion;
    const copy = await duplicateDesignFrame(root, main.file, { sourceVersion, componentCopy: { variant: "compact" } });
    const copySource = await readFile(path.join(root, DESIGN_DIRECTORY_NAME, copy.file), "utf8");
    expect(copySource).toContain('<zd-chip data-oid="');

    await deleteDesignFrame(root, main.file);
    const missing = (await lintDesignDocument(root, copy.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(missing).toContainEqual(expect.objectContaining({ ruleId: "component-undefined", severity: "error" }));

    const renamed = await renameDesignFrame(root, copy.file, "Missing chip copy");
    const instanceMarkup = copySource.match(/<zd-chip[^>]*><\/zd-chip>/)?.[0];
    expect(instanceMarkup).toBeTruthy();
    expect(await readFile(path.join(root, DESIGN_DIRECTORY_NAME, renamed.file), "utf8")).toContain(instanceMarkup!);
    const renamedMissing = (await lintDesignDocument(root, renamed.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(renamedMissing).toContainEqual(expect.objectContaining({ ruleId: "component-undefined", severity: "error" }));

    await deleteDesignFrame(root, renamed.file);
    expect((await listDesignFrames(root)).some((frame) => frame.file === renamed.file)).toBe(false);
  });

  it("says no frame is registered and there is no components/ file when the name is not defined at all", async () => {
    const host = await createDesignFrame(root, { title: "Workspace" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, host.file), HOST);
    const lint = (await lintDesignDocument(root, host.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(lint.filter((violation) => violation.oid === "ws" || /zd-chip/.test(violation.message))).toEqual([expect.objectContaining({
      ruleId: "component-undefined", oid: "ws",
      message: "Component <zd-chip> has no definition: no frame is registered as zd-chip and there is no components/chip.html.",
    })]);
  });

  it.each([
    ["a symbolic link", "it is a symbolic link, which Zeros does not follow", async (file: string) => {
      await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, "real-chip.html"), LEGACY);
      await symlink(path.join(root, DESIGN_DIRECTORY_NAME, "real-chip.html"), file);
    }],
    ["over the size limit", "it is over 512 KiB", async (file: string) => {
      await writeFile(file, LEGACY.replace("</body>", `<p>${"x".repeat(600 * 1024)}</p></body>`));
    }],
    ["not a file", "it is not a readable file", async (file: string) => { await mkdir(file); }],
  ])("reports a components/ definition that is %s as unusable, never as missing", async (_case, reason, spoil) => {
    const host = await createDesignFrame(root, { title: "Workspace" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, host.file), HOST);
    await mkdir(path.join(root, DESIGN_DIRECTORY_NAME, "components"), { recursive: true });
    await spoil(path.join(root, DESIGN_DIRECTORY_NAME, "components", "chip.html"));
    const lint = (await lintDesignDocument(root, host.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(lint.filter((violation) => violation.oid === "ws" || /zd-chip/.test(violation.message))).toEqual([expect.objectContaining({
      ruleId: "component-invalid", severity: "error", oid: "ws",
      message: `Component zd-chip's definition components/chip.html cannot be used: ${reason}.`,
    })]);
    const render = await prepareFrameRenderSource(root, HOST, { width: 400, height: 300 }, undefined, undefined, host.file, await readCanvas(root));
    expect(render.sanitized).toContain('<p data-oid="p">Before</p>');
    expect(render.instances?.hosts.ws).toBeUndefined();
  });

  it("says why a registered frame that is there cannot be used", async () => {
    const main = await createDesignFrame(root, { title: "Chip" });
    const host = await createDesignFrame(root, { title: "Workspace" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), MAIN.replace("</body>", `<p>${"x".repeat(600 * 1024)}</p></body>`));
    await register(main.file, "chip");
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, host.file), HOST);
    const lint = (await lintDesignDocument(root, host.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(lint.filter((violation) => violation.oid === "ws")).toEqual([expect.objectContaining({
      ruleId: "component-invalid", message: `${main.file}: The frame registered as zd-chip (${main.file}) cannot be used: it is over 512 KiB.`,
    })]);
  });});

describe("canvas files and the component field", () => {
  const base = {
    version: 2,
    id: "main",
    title: "Design",
    pages: [{ id: "page_home", title: "Home", folder: "home", frames: ["home_main"] }],
    frames: { home_main: { kind: "html", source: "home/main.html", title: "Main", x: 0, y: 0, width: 100, height: 100 } },
  };

  const canonical = (value: unknown) => encodeCanvasFile(decodeCanvasFile(`${JSON.stringify(value, null, 2)}\n`, { version: 2 }), { version: 2 });

  it("read and write a canvas without the field exactly as before", () => {
    const text = canonical(base);
    expect(encodeCanvasFile(decodeCanvasFile(text, { version: 2 }), { version: 2 })).toBe(text);
    expect(text).not.toContain("component");
  });

  it("keep the field through a read and write by code that does not know it", () => {
    // Frame records pass unknown keys through, which is all an older build does with it.
    const text = canonical({ ...base, frames: { home_main: { ...base.frames.home_main, component: "chat-composer" } } });
    expect(text).toContain('"component": "chat-composer"');
    const decoded = decodeCanvasFile(text, { version: 2 });
    expect((decoded.frame_info as Record<string, { component?: string }>)["home/main.html"]!.component).toBe("chat-composer");
    expect(encodeCanvasFile(decoded, { version: 2 })).toBe(text);
    // The only difference from the same canvas without it is that one line.
    expect(text.replace(/\n\s*"component": "chat-composer",?/, "").replace(/,(\n\s*})/, "$1")).toBe(canonical(base));
  });
});
