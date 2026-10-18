import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storage from "../metadata-storage";
import * as transactions from "../document-transactions";
import { captureDesignFrameRestorePoint, createDesignFrame, DESIGN_DIRECTORY_NAME, listDesignFrames, readDesignFrameRenderIdentity, restoreDesignFrameChanges, transferDesignNode } from "../document";

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

  it.each([".parent > .child { color:red }", ".child{width:30vw}"])("refuses unsupported context without changing source or catalog: %s", async (css) => {
    const { before, input } = await fixture(css);
    await expect(transferDesignNode(workspace, input)).rejects.toThrow(/safely/);
    expect(await captureDesignFrameRestorePoint(workspace, input.frame)).toEqual(before);
    expect(await listDesignFrames(workspace)).toHaveLength(1);
  });

  it("does not overwrite a source saved after measurement", async () => {
    const { source, file, input } = await fixture();
    await writeFile(file, source.replace("--accent:red", "--accent:blue"));
    await expect(transferDesignNode(workspace, input)).rejects.toThrow(/changed/);
    expect(await readFile(file, "utf8")).toContain("--accent:blue");
    expect(await listDesignFrames(workspace)).toHaveLength(1);
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
});
