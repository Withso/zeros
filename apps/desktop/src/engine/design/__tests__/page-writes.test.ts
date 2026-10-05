import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureDesignFrameRestorePoint, createDesignFrame, createDesignPage, deleteDesignPage, duplicateDesignFrame, readDesignFrameRenderIdentity, restoreDesignFrame, restoreDesignFrameChanges, transferDesignNode } from "../document";
import { readCanvas } from "../document-storage";
import { withDesignDirectoryNameLease } from "../directory-registry";
import { pagesCanvas, pagesDirectory, pagesManifest } from "./pages-fixtures";

describe("page-owned frame writes", () => {
  let root: string;
  const read = (file: string) => readFileSync(path.join(root, pagesDirectory, file), "utf8");
  const run = <T>(action: () => Promise<T>) => withDesignDirectoryNameLease(root, pagesDirectory, action);
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-design-page-writes-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    mkdirSync(path.join(root, pagesDirectory, "meta"), { recursive: true });
    writeFileSync(path.join(root, pagesDirectory, "meta/design.toml"), pagesManifest);
    writeFileSync(path.join(root, pagesDirectory, "meta/canvas.json"), JSON.stringify(pagesCanvas));
    writeFileSync(path.join(root, pagesDirectory, "tokens.css"), ":root { --accent: blue; }");
    for (const file of ["page-1/home.html", "checkout/home.html"]) {
      mkdirSync(path.dirname(path.join(root, pagesDirectory, file)), { recursive: true });
      writeFileSync(path.join(root, pagesDirectory, file), '<!doctype html><html><head><title>Home</title><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="root" data-zeros-frame-root=""><p data-oid="label">Home</p><a href="local.html">Local</a></main></body></html>');
    }
  });
  afterEach(() => {
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("creates in an explicit page, preserves memberships and creates a missing folder", () => run(async () => {
    const frame = await createDesignFrame(root, { title: "Home", pageId: "empty" });
    expect(frame).toMatchObject({ file: "empty/home.html", pageId: "empty", frameId: expect.any(String) });
    expect(read(frame.file)).toContain('href="../tokens.css"');
    const canvas = JSON.parse(read("meta/canvas.json"));
    expect(canvas.pages.slice(0, 2)).toEqual(pagesCanvas.pages.slice(0, 2));
    expect(canvas.pages[2].frames).toEqual([frame.frameId]);
    expect(frame).toMatchObject({ x: 0, y: 0, z: 0 });
  }));

  it("rejects missing and ambiguous page targets without writing source", () => run(async () => {
    const before = read("meta/canvas.json");
    await expect(createDesignFrame(root, { title: "Wrong" })).rejects.toThrow(/pageId required/i);
    await expect(createDesignFrame(root, { title: "Wrong", pageId: "missing" })).rejects.toThrow(/page.*not found|page.*missing/i);
    await expect(duplicateDesignFrame(root, "page-1/home.html")).rejects.toThrow(/pageId required/i);
    expect(read("meta/canvas.json")).toBe(before);
    expect(existsSync(path.join(root, pagesDirectory, "wrong.html"))).toBe(false);
  }));

  it("keeps automatic placement local to a page", () => run(async () => {
    const first = await createDesignFrame(root, { pageId: "empty", title: "One" });
    const second = await createDesignFrame(root, { pageId: "empty", title: "Two" });
    expect(first).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(second).toMatchObject({ x: 1560, y: 0, z: 1 });
    const other = await createDesignFrame(root, { pageId: "checkout", title: "Other" });
    expect(other.z).toBe(1);
  }));

  it("creates text frames in the explicit page", () => run(async () => {
    const frame = await createDesignFrame(root, { pageId: "empty", title: "Label", seed: { kind: "text", nodeId: "text", text: "Hello", fixedSize: false } });
    expect(frame).toMatchObject({ pageId: "empty", file: "empty/label.html", kind: "text" });
    expect(read(frame.file)).toContain('href="../tokens.css"');
    expect(read(frame.file)).toContain("Hello");
  }));

  it("duplicates into the requested page and preserves source-relative URL origins", () => run(async () => {
    const copied = await duplicateDesignFrame(root, "page-1/home.html", { pageId: "checkout" });
    expect(copied).toMatchObject({ pageId: "checkout", file: "checkout/home-copy.html", z: 1 });
    expect(read(copied.file)).toContain('href="../page-1/local.html"');
    expect(read(copied.file)).toContain('href="../tokens.css"');
    expect(read(copied.file)).not.toContain('data-oid="label"');
    expect(JSON.parse(read("meta/canvas.json")).pages[0].frames).toEqual(["home"]);
  }));

  it("enforces the 256-frame budget across pages", () => run(async () => {
    const canvas = JSON.parse(read("meta/canvas.json"));
    for (let index = 2; index < 256; index++) {
      const id = `f_${index}`;
      canvas.frames[id] = { kind: "html", source: `page-1/frame-${index}.html`, title: "Frame", x: 0, y: 0, width: 10, height: 10 };
      canvas.pages[0].frames.push(id);
      writeFileSync(path.join(root, pagesDirectory, `page-1/frame-${index}.html`), "<h1>Frame</h1>");
    }
    writeFileSync(path.join(root, pagesDirectory, "meta/canvas.json"), JSON.stringify(canvas));
    await expect(createDesignFrame(root, { pageId: "empty" })).rejects.toThrow(/256|too many frames|frame limit/i);
    expect(existsSync(path.join(root, pagesDirectory, "empty/frame.html"))).toBe(false);
  }));

  it("records the page identity and refuses restoration after page deletion or folder reuse", () => run(async () => {
    const restore = await captureDesignFrameRestorePoint(root, "checkout/home.html");
    expect(restore.pageId).toBe("checkout");
    await deleteDesignPage(root, "checkout", ["checkout_home"]);
    await expect(restoreDesignFrame(root, restore)).rejects.toThrow(/page.*not found|page.*removed|page.*missing/i);
    expect(existsSync(path.join(root, pagesDirectory, "checkout"))).toBe(false);
    const replacement = await createDesignPage(root, { title: "Checkout" });
    expect(replacement.folder).toBe("checkout");
    expect(replacement.id).not.toBe(restore.pageId);
    await expect(restoreDesignFrame(root, restore)).rejects.toThrow(/page.*not found|page.*removed|page.*missing/i);
    expect(existsSync(path.join(root, pagesDirectory, restore.file))).toBe(false);
  }));

  it("refuses transfer-history restoration into a deleted page before making directories", () => run(async () => {
    const restore = await captureDesignFrameRestorePoint(root, "checkout/home.html");
    await deleteDesignPage(root, "checkout", ["checkout_home"]);
    await expect(restoreDesignFrameChanges(root, [{ before: restore, after: null }], "undo")).rejects.toThrow(/page.*not found|page.*removed|page.*missing/i);
    expect(existsSync(path.join(root, pagesDirectory, "checkout"))).toBe(false);
  }));

  it("detaches a layer into an explicit page while retaining URL origins", () => run(async () => {
    const identity = await readDesignFrameRenderIdentity(root, "page-1/home.html");
    const moved = await transferDesignNode(root, { frame: "page-1/home.html", sourceVersion: identity.sourceVersion, nodeId: "label", pageId: "empty", geometry: { x: 0, y: 0, w: 390, h: 844, z: 0 } });
    expect(moved.frame).toBe("empty/frame.html");
    expect(moved.changes[1]?.after?.pageId).toBe("empty");
    expect(read(moved.frame)).toContain('href="../tokens.css"');
    expect((await readCanvas(root)).pages!.find(page => page.id === "empty")!.frames).toHaveLength(1);
  }));
});
