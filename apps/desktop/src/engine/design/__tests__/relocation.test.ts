import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storage from "../metadata-storage";
import * as transactions from "../document-transactions";
import * as preparation from "../render-preparation";
import { recoverWorkspaceDesignMetadata } from "../metadata";
import {
  captureDesignFrameRestorePoint,
  commitDesignWebDocumentState,
  createDesignFrame,
  DESIGN_DIRECTORY_NAME,
  designTransactionJournalPath,
  listDesignFrames,
  readDesignFrameRenderIdentity,
  readDesignWebDocumentState,
  restoreDesignFrameChanges,
  transferDesignNode,
  updateDesignFrameGeometry,
} from "../document";
import { createDesignWebDocumentState } from "@zeros/design-web";

describe("bounded source-preserving relocation", () => {
  let workspace: string;
  beforeEach(async () => { workspace = await mkdtemp(path.join(tmpdir(), "zeros-relocation-")); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(workspace, { recursive: true, force: true }); });
  const relocation = { width: 100, height: 80, matrix: [0, 2, -3, 0, 240, 0] as [number, number, number, number, number, number], inheritedStyles: { color: "navy", "font-size": "30px", "--accent": "red" } };
  async function fixture(css = "") {
    const frame = await createDesignFrame(workspace);
    const file = path.join(workspace, DESIGN_DIRECTORY_NAME, frame.file);
    const source = `<!doctype html><html><head><style>${css}</style></head><body><main data-oid="parent" style="position:relative;color:navy;font-size:30px;--accent:red"><div data-oid="child" style="position:absolute;margin:20px;width:100px;height:80px;background:var(--accent)"><img data-oid="image" src="../assets/example.png"></div><div data-oid="destination" style="position:relative"></div></main></body></html>`;
    await writeFile(file, source);
    const before = await captureDesignFrameRestorePoint(workspace, frame.file);
    const identity = await readDesignFrameRenderIdentity(workspace, frame.file);
    return { frame, file, source, before, input: { frame: frame.file, sourceVersion: identity.sourceVersion, nodeId: "child", relocation, geometry: { x: 700, y: 50, w: 240, h: 200, z: 1 } } };
  }

  it("preserves affine pose, appearance, IDs and local URLs through exact undo and redo", async () => {
    const { frame, file, before, input } = await fixture();
    const result = await transferDesignNode(workspace, input);
    const moved = await captureDesignFrameRestorePoint(workspace, result.frame);
    expect(moved.source).toContain("matrix(0,2,-3,0,240,0)");
    expect(moved.source).toMatch(/font-size:\s*30px/);
    expect(moved.source).toMatch(/--accent:\s*red/);
    expect(moved.source).toMatch(/margin:\s*0(?:;|")/);
    expect(moved.source).toContain('src="../assets/example.png"');
    expect(moved.source).toContain('data-oid="image"');
    expect(await readFile(file, "utf8")).not.toContain('data-oid="child"');
    await restoreDesignFrameChanges(workspace, result.changes, "undo");
    expect(await captureDesignFrameRestorePoint(workspace, frame.file)).toEqual(before);
    expect(await listDesignFrames(workspace)).toHaveLength(1);
    await restoreDesignFrameChanges(workspace, result.changes, "redo");
    expect(await captureDesignFrameRestorePoint(workspace, result.frame)).toEqual(moved);
  });

  it("reparents within the scene in one reversible source transaction", async () => {
    const { before, input } = await fixture();
    const result = await transferDesignNode(workspace, { ...input, destinationFrame: input.frame, destinationSourceVersion: input.sourceVersion, parentId: "destination" });
    expect(result.changes).toHaveLength(1);
    expect(result.frame).toBe(input.frame);
    expect((await captureDesignFrameRestorePoint(workspace, input.frame)).source).toContain("matrix(0,2,-3,0,240,0)");
    await restoreDesignFrameChanges(workspace, result.changes, "undo");
    expect(await captureDesignFrameRestorePoint(workspace, input.frame)).toEqual(before);
  });

  it.each([
    ".parent > .child { color:red }",
    ".child{width:30vw}",
    "@media (min-width: 700px) { .child { color: red } }",
    "@keyframes spin { to { rotate: 1turn } } .child{animation: spin 1s infinite}",
    "svg.icon:not([fill]) { fill: none !important }",
  ])("moves a layer out of a frame that uses ordinary CSS, reversibly: %s", async (css) => {
    const { before, input } = await fixture(css);
    const result = await transferDesignNode(workspace, input);
    expect(await listDesignFrames(workspace)).toHaveLength(2);
    // The new frame keeps the source's own stylesheet for the moved layer.
    expect((await captureDesignFrameRestorePoint(workspace, result.frame)).source).toContain(css);
    await restoreDesignFrameChanges(workspace, result.changes, "undo");
    expect(await captureDesignFrameRestorePoint(workspace, input.frame)).toEqual(before);
    expect(await listDesignFrames(workspace)).toHaveLength(1);
  });

  it("refuses a component instance inside the moving layer without changing source or catalog", async () => {
    const { file, input } = await fixture();
    const source = (await readFile(file, "utf8")).replace('<img data-oid="image"', '<zd-card data-oid="card"></zd-card><img data-oid="image"');
    await writeFile(file, source);
    const identity = await readDesignFrameRenderIdentity(workspace, input.frame);
    await expect(transferDesignNode(workspace, { ...input, sourceVersion: identity.sourceVersion })).rejects.toThrow(/component instance/);
    expect(await readFile(file, "utf8")).toBe(source);
    expect(await listDesignFrames(workspace)).toHaveLength(1);
  });

  it("nests a layer into a frame with different stylesheets, making a static parent positioned", async () => {
    const { input } = await fixture(".child { border: 1px solid red }");
    const destination = await createDesignFrame(workspace, { title: "Destination" });
    const destinationFile = path.join(workspace, DESIGN_DIRECTORY_NAME, destination.file);
    await writeFile(destinationFile, '<!doctype html><html><head><style>.card{padding:8px}</style></head><body><section data-oid="card" class="card"></section></body></html>');
    const destinationBefore = await captureDesignFrameRestorePoint(workspace, destination.file);
    const destinationIdentity = await readDesignFrameRenderIdentity(workspace, destination.file);
    const result = await transferDesignNode(workspace, {
      ...input,
      destinationFrame: destination.file,
      destinationSourceVersion: destinationIdentity.sourceVersion,
      parentId: "card",
      parentStyles: { position: "relative" },
    });
    expect(result.frame).toBe(destination.file);
    const nested = await captureDesignFrameRestorePoint(workspace, destination.file);
    expect(nested.source).toContain('data-oid="child"');
    expect(nested.source).toMatch(/data-oid="card"[^>]*style="[^"]*position:\s*relative/);
    expect(nested.source).toContain(".child { border: 1px solid red }");
    expect(nested.source).toContain(".card{padding:8px}");
    await restoreDesignFrameChanges(workspace, result.changes, "undo");
    expect(await captureDesignFrameRestorePoint(workspace, destination.file)).toEqual(destinationBefore);
    await expect(transferDesignNode(workspace, {
      ...input,
      destinationFrame: destination.file,
      destinationSourceVersion: destinationIdentity.sourceVersion,
      parentId: "card",
      parentStyles: { position: "fixed" } as never,
    })).rejects.toThrow(/positioned/);
  });

  it("nests a whole body-rooted frame into another frame and restores both exactly", async () => {
    const outer = await createDesignFrame(workspace, { title: "Outer" });
    const inner = await createDesignFrame(workspace, { title: "Inner" });
    const outerFile = path.join(workspace, DESIGN_DIRECTORY_NAME, outer.file);
    const innerFile = path.join(workspace, DESIGN_DIRECTORY_NAME, inner.file);
    await writeFile(outerFile, '<!doctype html><html><head></head><body><main data-oid="board" style="position:relative;width:900px;height:700px"></main></body></html>');
    await writeFile(innerFile, '<!doctype html><html><head><style>.title{font-weight:600}</style></head><body class="sheet" style="padding:12px"><h1 data-oid="title" class="title">Inner</h1><p data-oid="copy">Body</p></body></html>');
    const outerBefore = await captureDesignFrameRestorePoint(workspace, outer.file);
    const innerBefore = await captureDesignFrameRestorePoint(workspace, inner.file);
    const outerIdentity = await readDesignFrameRenderIdentity(workspace, outer.file);
    const innerIdentity = await readDesignFrameRenderIdentity(workspace, inner.file);
    const result = await transferDesignNode(workspace, {
      frame: inner.file,
      sourceVersion: innerIdentity.sourceVersion,
      nodeId: "::zeros-document-body",
      destinationFrame: outer.file,
      destinationSourceVersion: outerIdentity.sourceVersion,
      parentId: "board",
      relocation: { width: 400, height: 300, matrix: [1, 0, 0, 1, 40, 60], inheritedStyles: { "font-family": "Georgia" } },
      frameBackground: "snow",
      geometry: { x: 0, y: 0, w: 400, h: 300, z: 1 },
    });
    expect(result.frame).toBe(outer.file);
    expect(result.nodeId).toMatch(/^frame-[a-f0-9]{8}$/);
    const nested = await captureDesignFrameRestorePoint(workspace, outer.file);
    expect(nested.source).toContain(`data-oid="${result.nodeId}" class="sheet"`);
    expect(nested.source).toContain('data-oid="title"');
    expect(nested.source).toContain(".title{font-weight:600}");
    expect(nested.source).toMatch(/background-color:\s*snow/);
    expect(nested.source).toMatch(/padding:\s*12px/);
    expect(nested.source).toContain("matrix(1,0,0,1,40,60)");
    expect(existsSync(innerFile)).toBe(false);
    expect(await listDesignFrames(workspace)).toHaveLength(1);
    await restoreDesignFrameChanges(workspace, result.changes, "undo");
    expect(await captureDesignFrameRestorePoint(workspace, outer.file)).toEqual(outerBefore);
    expect(await captureDesignFrameRestorePoint(workspace, inner.file)).toEqual(innerBefore);
    await expect(transferDesignNode(workspace, {
      frame: inner.file, sourceVersion: innerIdentity.sourceVersion, nodeId: "::zeros-document-body",
      geometry: { x: 0, y: 0, w: 400, h: 300, z: 1 },
    })).rejects.toThrow(/whole frame/);
  });

  it("does not overwrite a source saved after measurement", async () => {
    const { source, file, input } = await fixture();
    await writeFile(file, source.replace("--accent:red", "--accent:blue"));
    await expect(transferDesignNode(workspace, input)).rejects.toThrow(/changed/);
    expect(await readFile(file, "utf8")).toContain("--accent:blue");
    expect(await listDesignFrames(workspace)).toHaveLength(1);
  });

  it("refuses relocation after a scene moved without changing its HTML", async () => {
    const { source, file, before, input } = await fixture();
    await updateDesignFrameGeometry(workspace, input.frame, {
      ...before.geometry,
      x: before.geometry.x + 10,
    });
    await expect(
      transferDesignNode(workspace, {
        ...input,
        movementGuard: {
          sourceVersion: input.sourceVersion,
          geometry: before.geometry,
        },
      }),
    ).rejects.toThrow(/geometry|changed/);
    expect(await readFile(file, "utf8")).toBe(source);
    expect(await listDesignFrames(workspace)).toHaveLength(1);
  });

  it("checks a measured semantic move again after asynchronous journal preparation", async () => {
    const { source, file, input } = await fixture();
    const css = path.join(workspace, DESIGN_DIRECTORY_NAME, "context.css");
    await writeFile(css, ".child {color:red}");
    const linked = source.replace(
      "<head>",
      '<head><link rel="stylesheet" href="../context.css">',
    );
    await writeFile(file, linked);
    const current = await readDesignWebDocumentState(workspace, input.frame);
    const identity = await readDesignFrameRenderIdentity(
      workspace,
      input.frame,
    );
    const next = createDesignWebDocumentState({
      ...current,
      files: {
        ...current.files,
        [input.frame]: linked.replace("margin:20px", "margin:21px"),
      },
    });
    let checks = 0;
    await expect(
      commitDesignWebDocumentState(
        workspace,
        input.frame,
        current.revision,
        next,
        {
          movementGuard: { sourceVersion: identity.sourceVersion },
          assertAuthorized: () => {
            if (++checks === 2) writeFileSync(css, ".child {color:blue}");
          },
        },
      ),
    ).rejects.toThrow(/changed/);
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(await readFile(file, "utf8")).toBe(linked);
  });

  it("rolls back a partial disk failure before reporting a failed relocation", async () => {
    const { source, file, input } = await fixture();
    const write = storage.atomicWriteDesignStorageFile;
    let writes = 0;
    vi.spyOn(storage, "atomicWriteDesignStorageFile").mockImplementation((...args) => {
      if (args[1].endsWith(".html") && ++writes === 2) throw new Error("Injected disk failure");
      return write(...args);
    });
    await expect(transferDesignNode(workspace, input)).rejects.toThrow("Injected disk failure");
    expect(await readFile(file, "utf8")).toBe(source);
    expect(await listDesignFrames(workspace)).toHaveLength(1);
  });

  it.each(["linked", "imported"])("refuses a %s dependency changed while preparing the semantic admission journal", async (kind) => {
    const { source, file, input } = await fixture();
    const css = path.join(workspace, ...(kind === "linked" ? [DESIGN_DIRECTORY_NAME] : []), "context.css");
    const linked = kind === "linked" ? source.replace("<head>", '<head><link rel="stylesheet" href="../context.css">') : source;
    if (kind === "imported") {
      const canvasFile = path.join(workspace, DESIGN_DIRECTORY_NAME, "meta/canvas.json");
      const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
      canvas.styles = [{ id: "context", kind: "css", path: "context.css" }];
      await writeFile(canvasFile, JSON.stringify(canvas));
    }
    await writeFile(css, ".child{color:red}");
    await writeFile(file, linked);
    const current = await readDesignWebDocumentState(workspace, input.frame);
    const identity = await readDesignFrameRenderIdentity(workspace, input.frame);
    const next = createDesignWebDocumentState({ ...current, files: { ...current.files, [input.frame]: linked.replace("margin:20px", "margin:21px") } });
    const write = storage.writePrivateDesignState;
    let injected = false;
    vi.spyOn(storage, "writePrivateDesignState").mockImplementation((...args) => {
      if (!injected && args[1] === path.basename(designTransactionJournalPath(workspace))) {
        const options = args[3];
        return write(args[0], args[1], args[2], {
          temporaryToken: "b".repeat(32),
          ...options,
          afterPrepare: () => {
            options?.afterPrepare?.();
            injected = true;
            writeFileSync(css, ".child{color:blue}");
          },
        });
      }
      return write(...args);
    });
    await expect(commitDesignWebDocumentState(workspace, input.frame, current.revision, next, { movementGuard: { sourceVersion: identity.sourceVersion } })).rejects.toThrow();
    expect(injected).toBe(true);
    expect(await readFile(file, "utf8")).toBe(linked);
    expect(existsSync(designTransactionJournalPath(workspace))).toBe(false);
  });

  it.each(["between-files", "before-publish"])("retains a concurrent source save at the %s publication boundary", async (boundary) => {
    const { source, file, input } = await fixture();
    const concurrent = `${source}<!-- legitimate-concurrent-editor-save -->`;
    const write = storage.atomicWriteDesignStorageFile;
    let injected = false;
    vi.spyOn(storage, "atomicWriteDesignStorageFile").mockImplementation((...args) => {
      if (boundary === "before-publish" && !injected && args[0] === workspace && args[1] === `${DESIGN_DIRECTORY_NAME}/${input.frame}`) {
        const options = args[4];
        return write(args[0], args[1], args[2], args[3], {
          temporaryToken: "a".repeat(32),
          ...options,
          afterPrepare: () => {
            options?.afterPrepare?.();
            injected = true;
            writeFileSync(file, concurrent);
          },
        });
      }
      const result = write(...args);
      if (boundary === "between-files" && !injected && args[0] === workspace && args[1].endsWith("/canvas.json")) {
        injected = true;
        writeFileSync(file, concurrent);
      }
      return result;
    });
    await expect(transferDesignNode(workspace, input)).rejects.toThrow(/rollback needs recovery/);
    expect(injected).toBe(true);
    expect(await readFile(file, "utf8")).toBe(concurrent);
    const root = storage.designPrivateStorageDirectory(workspace);
    const journals = (await readdir(root)).filter((name) => /^metadata-[a-f0-9]+\.json$/.test(name));
    expect(journals).toHaveLength(1);
    const inverse = await readFile(path.join(root, journals[0]!), "utf8");
    expect(JSON.parse(inverse).changes).toEqual(expect.arrayContaining([expect.objectContaining({ after: source })]));
    expect(() => recoverWorkspaceDesignMetadata(workspace)).toThrow(/retained recovery record/);
    expect(await readFile(file, "utf8")).toBe(concurrent);
    expect(await readFile(path.join(root, journals[0]!), "utf8")).toBe(inverse);
  });

  it("retains the guarded inverse when a failed second write meets a concurrent edit", async () => {
    const { source, file, input } = await fixture();
    const write = storage.atomicWriteDesignStorageFile;
    const concurrent = `${source}<!-- concurrent-after-first-source-write -->`;
    let writes = 0;
    vi.spyOn(storage, "atomicWriteDesignStorageFile").mockImplementation((...args) => {
      if (args[0] === workspace && args[1].endsWith(".html") && ++writes === 2) {
        writeFileSync(file, concurrent);
        throw new Error("Injected destination write failure");
      }
      return write(...args);
    });
    await expect(transferDesignNode(workspace, input)).rejects.toThrow(/rollback needs recovery/);
    expect(await readFile(file, "utf8")).toBe(concurrent);
    const root = storage.designPrivateStorageDirectory(workspace);
    const journals = (await readdir(root)).filter((name) => /^metadata-[a-f0-9]+\.json$/.test(name));
    expect(journals).toHaveLength(1);
    const inverse = await readFile(path.join(root, journals[0]!), "utf8");
    expect(JSON.parse(inverse).changes).toEqual(expect.arrayContaining([expect.objectContaining({ after: source })]));
    expect(() => recoverWorkspaceDesignMetadata(workspace)).toThrow(/retained recovery record/);
    expect(await readFile(path.join(root, journals[0]!), "utf8")).toBe(inverse);
  });

  it("rechecks stylesheet identity after preparing all source changes", async () => {
    const { source, file, input } = await fixture();
    const linked = source.replace("<head>", '<head><link rel="stylesheet" href="../tokens.css">');
    await writeFile(file, linked);
    const css = path.join(workspace, DESIGN_DIRECTORY_NAME, "tokens.css");
    await writeFile(css, ".child {color:red}");
    const identity = await readDesignFrameRenderIdentity(workspace, input.frame);
    const check = transactions.assertSafeDesignWriteTarget;
    let changed = false;
    vi.spyOn(transactions, "assertSafeDesignWriteTarget").mockImplementation(async (...args) => {
      if (args[1] === file && !changed) { changed = true; await writeFile(css, ".child {color:blue}"); }
      return check(...args);
    });
    await expect(transferDesignNode(workspace, { ...input, sourceVersion: identity.sourceVersion })).rejects.toThrow(/changed/);
    expect(changed).toBe(true);
    expect(await readFile(file, "utf8")).toBe(linked);
    expect(await listDesignFrames(workspace)).toHaveLength(1);
  });

  it.each([1, 2])("rejects a source dependency changed at destination identity read %s", async (injectAt) => {
    const from = await createDesignFrame(workspace);
    const to = await createDesignFrame(workspace);
    const source = '<!doctype html><html><head><link rel="stylesheet" href="../from.css"></head><body style="margin:0"><main data-oid="source-root" style="position:relative;width:600px;height:400px"><div data-oid="child" class="child" style="position:absolute;left:20px;top:30px;width:100px;height:80px">Keep</div></main></body></html>';
    const target = '<!doctype html><html><head><link rel="stylesheet" href="../to.css"></head><body style="margin:0"><main data-oid="target-root" style="position:relative;width:600px;height:400px"></main></body></html>';
    const directory = path.join(workspace, DESIGN_DIRECTORY_NAME);
    const css = path.join(directory, "from.css");
    await writeFile(path.join(directory, from.file), source);
    await writeFile(path.join(directory, to.file), target);
    await writeFile(css, ".child{color:red}");
    await writeFile(path.join(directory, "to.css"), ".child{color:red}");
    const fromIdentity = await readDesignFrameRenderIdentity(workspace, from.file);
    const toIdentity = await readDesignFrameRenderIdentity(workspace, to.file);
    const fromPoint = await captureDesignFrameRestorePoint(workspace, from.file);
    const toPoint = await captureDesignFrameRestorePoint(workspace, to.file);
    const prepare = preparation.prepareFrameRenderSource;
    let reads = 0, injected = false;
    vi.spyOn(preparation, "prepareFrameRenderSource").mockImplementation(async (...args) => {
      const result = await prepare(...args);
      if (args[1] === target && args[7]?.identityOnly && ++reads === injectAt) {
        injected = true;
        await writeFile(css, ".child{color:blue}");
      }
      return result;
    });
    await expect(transferDesignNode(workspace, {
      frame: from.file, sourceVersion: fromIdentity.sourceVersion, nodeId: "child",
      destinationFrame: to.file, destinationSourceVersion: toIdentity.sourceVersion, parentId: "target-root",
      relocation: { width: 100, height: 80, matrix: [1, 0, 0, 1, 20, 30], inheritedStyles: { color: "red" } },
      movementGuard: { sourceVersion: fromIdentity.sourceVersion, geometry: fromPoint.geometry },
      destinationMovementGuard: { sourceVersion: toIdentity.sourceVersion, geometry: toPoint.geometry },
      geometry: toPoint.geometry,
    })).rejects.toThrow(/changed/);
    expect(injected).toBe(true);
    expect(await readFile(path.join(directory, from.file), "utf8")).toBe(source);
    expect(await readFile(path.join(directory, to.file), "utf8")).toBe(target);
    expect(await readFile(css, "utf8")).toBe(".child{color:blue}");
  });

  it("rechecks cached dependencies at the lifecycle journal publication boundary", async () => {
    const { source, file, input } = await fixture();
    const css = path.join(workspace, DESIGN_DIRECTORY_NAME, "context.css");
    const linked = source.replace("<head>", '<head><link rel="stylesheet" href="../context.css">');
    await writeFile(css, ".child{color:red}");
    await writeFile(file, linked);
    const identity = await readDesignFrameRenderIdentity(workspace, input.frame);
    const write = storage.writePrivateDesignState;
    let injected = false;
    vi.spyOn(storage, "writePrivateDesignState").mockImplementation((...args) => {
      if (!injected && /^metadata-[a-f0-9]+\.json$/.test(args[1])) {
        const options = args[3];
        return write(args[0], args[1], args[2], {
          temporaryToken: "c".repeat(32),
          ...options,
          afterPrepare: () => {
            options?.afterPrepare?.();
            injected = true;
            writeFileSync(css, ".child{color:tan}");
          },
        });
      }
      return write(...args);
    });
    await expect(transferDesignNode(workspace, { ...input, sourceVersion: identity.sourceVersion })).rejects.toThrow(/changed/);
    expect(injected).toBe(true);
    expect(await readFile(file, "utf8")).toBe(linked);
    expect((await readdir(storage.designPrivateStorageDirectory(workspace))).filter((name) => /^metadata-[a-f0-9]+\.json$/.test(name))).toEqual([]);
  });
});
