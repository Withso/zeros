import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDesignDocument, createDesignFrame } from "../document";
import { withDesignDirectoryNameLease } from "../directory-registry";
import { createDesignPage, deleteDesignPage, renameDesignPage } from "../page-lifecycle";
import { DesignPageTargetError } from "../pages";
import { restoreDesignCatalogChange, type DesignCatalogChange } from "../page-history";
import { upsertDesignTheme } from "../theme-lifecycle";
import * as storage from "../document-storage";

describe("exact Design catalog restore points", () => {
  let root: string;
  const directory = "Product - Design";
  const inDirectory = <T>(run: () => Promise<T>, name = directory) => withDesignDirectoryNameLease(root, name, run);
  const canvasPath = () => path.join(root, directory, "meta/canvas.json");
  const read = () => readFileSync(canvasPath(), "utf8");
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-design-catalog-history-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    await inDirectory(() => initializeDesignDocument(root));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  async function createdPage() {
    let change!: DesignCatalogChange;
    const page = await inDirectory(() => createDesignPage(root, { title: "Checkout" }, value => { change = value; }));
    return { page, change };
  }

  it("refuses a different registration and a different directory even with identical catalog values", async () => {
    const { change } = await createdPage();
    const saved = read();
    const manifest = path.join(root, directory, "meta/design.toml");
    const registration = readFileSync(manifest, "utf8");
    writeFileSync(manifest, registration.replace(/id = "[^"]+"/, 'id = "design_replaced"'));
    await expect(inDirectory(() => restoreDesignCatalogChange(root, change, "undo"))).rejects.toBeInstanceOf(DesignPageTargetError);
    expect(read()).toBe(saved);
    writeFileSync(manifest, registration);
    const other = "Other - Design";
    cpSync(path.join(root, directory), path.join(root, other), { recursive: true });
    writeFileSync(path.join(root, other, "meta/design.toml"), registration.replace(/id = "[^"]+"/, 'id = "design_other"'));
    const otherCanvas = path.join(root, other, "meta/canvas.json");
    const before = readFileSync(otherCanvas, "utf8");
    await expect(inDirectory(() => restoreDesignCatalogChange(root, change, "undo"), other)).rejects.toBeInstanceOf(DesignPageTargetError);
    expect(readFileSync(otherCanvas, "utf8")).toBe(before);
    await inDirectory(() => restoreDesignCatalogChange(root, change, "undo"));
  });

  it("recognizes a natively removed page as an invalid target", async () => {
    const { page, change } = await createdPage();
    await inDirectory(() => deleteDesignPage(root, page.id, []));
    const saved = read();
    await expect(inDirectory(() => restoreDesignCatalogChange(root, change, "undo"))).rejects.toBeInstanceOf(DesignPageTargetError);
    expect(read()).toBe(saved);
  });

  it("refuses a symlinked page folder without touching its target or metadata", async () => {
    const { page, change } = await createdPage();
    await inDirectory(() => restoreDesignCatalogChange(root, change, "undo"));
    const saved = read();
    const outside = path.join(root, "foreign");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep.txt"), "Keep");
    symlinkSync(outside, path.join(root, directory, page.folder));
    await expect(inDirectory(() => restoreDesignCatalogChange(root, change, "redo"))).rejects.toThrow(/real directories|storage/i);
    expect(read()).toBe(saved);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("Keep");
  });

  it("uses the metadata CAS if an external edit wins between read and restoration", async () => {
    const { change } = await createdPage();
    const actualRead = storage.readCanvas;
    let external = "";
    vi.spyOn(storage, "readCanvas").mockImplementationOnce(async (...args) => {
      const canvas = await actualRead(...args);
      const native = JSON.parse(read());
      native.extension = { native: true };
      external = JSON.stringify(native);
      writeFileSync(canvasPath(), external);
      return canvas;
    });
    await expect(inDirectory(() => restoreDesignCatalogChange(root, change, "undo"))).rejects.toThrow(/changed/i);
    expect(read()).toBe(external);
  });

  it("does not capture failed writes or remove a native file while cleaning a refused restore", async () => {
    const { page } = await createdPage();
    const frame = await inDirectory(() => createDesignFrame(root, { pageId: page.id }));
    let change!: DesignCatalogChange;
    await inDirectory(() => deleteDesignPage(root, page.id, [frame.frameId!], value => { change = value; }));
    const saved = read();
    const write = vi.spyOn(storage, "writeCanvas").mockImplementationOnce(async () => {
      writeFileSync(path.join(root, directory, page.folder, "native.txt"), "Keep");
      throw new Error("write refused");
    });
    await expect(inDirectory(() => restoreDesignCatalogChange(root, change, "undo"))).rejects.toThrow("write refused");
    expect(read()).toBe(saved);
    expect(existsSync(path.join(root, directory, frame.file))).toBe(false);
    expect(readFileSync(path.join(root, directory, page.folder, "native.txt"), "utf8")).toBe("Keep");
    write.mockRestore();
    await inDirectory(() => restoreDesignCatalogChange(root, change, "undo"));
    const capture = vi.fn();
    vi.spyOn(storage, "writeCanvas").mockRejectedValueOnce(new Error("write refused"));
    await expect(inDirectory(() => renameDesignPage(root, page.id, "Renamed", capture))).rejects.toThrow("write refused");
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not overwrite a native theme added after the upsert read", async () => {
    const actualRead = storage.readCanvas;
    let external = "";
    vi.spyOn(storage, "readCanvas").mockImplementationOnce(async (...args) => {
      const canvas = await actualRead(...args);
      const native = JSON.parse(read());
      native.themes = [{ id: "native", label: "Native" }];
      external = JSON.stringify(native);
      writeFileSync(canvasPath(), external);
      return canvas;
    });
    const capture = vi.fn();
    await expect(inDirectory(() => upsertDesignTheme(root, { id: "light", label: "Day" }, capture))).rejects.toThrow(/changed/i);
    expect(read()).toBe(external);
    expect(capture).not.toHaveBeenCalled();
  });
});
