import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureDesignFrameRestorePoint,
  createDesignFrame,
  createDesignFrameWithRestorePoint,
  designFrameCreateBatchesForTests,
  designMutationSnapshotReadsForTests,
  readDesignMutationSnapshot,
  createDesignPage,
  deleteDesignFrame,
  deleteDesignPage,
  duplicateDesignFrame,
  readDesignFrameRenderIdentity,
  restoreDesignFrame,
  restoreDesignFrameChanges,
  transferDesignNode,
} from "../document";
import { readCanvas, writeCanvas } from "../document-storage";
import { withDesignDirectoryNameLease } from "../directory-registry";
import { pagesCanvas, pagesDirectory, pagesManifest } from "./pages-fixtures";

describe("page-owned frame writes", () => {
  let root: string;
  const read = (file: string) =>
    readFileSync(path.join(root, pagesDirectory, file), "utf8");
  const run = <T>(action: () => Promise<T>) =>
    withDesignDirectoryNameLease(root, pagesDirectory, action);
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-design-page-writes-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    mkdirSync(path.join(root, pagesDirectory, "meta"), { recursive: true });
    writeFileSync(
      path.join(root, pagesDirectory, "meta/design.toml"),
      pagesManifest,
    );
    writeFileSync(
      path.join(root, pagesDirectory, "meta/canvas.json"),
      JSON.stringify(pagesCanvas),
    );
    writeFileSync(
      path.join(root, pagesDirectory, "tokens.css"),
      ":root { --accent: blue; }",
    );
    for (const file of ["page-1/home.html", "checkout/home.html"]) {
      mkdirSync(path.dirname(path.join(root, pagesDirectory, file)), {
        recursive: true,
      });
      writeFileSync(
        path.join(root, pagesDirectory, file),
        '<!doctype html><html><head><title>Home</title><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="root" data-zeros-frame-root=""><p data-oid="label">Home</p><a href="local.html">Local</a></main></body></html>',
      );
    }
  });
  afterEach(() => {
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("creates in an explicit page, preserves memberships and creates a missing folder", () =>
    run(async () => {
      const frame = await createDesignFrame(root, {
        title: "Home",
        pageId: "empty",
      });
      expect(frame).toMatchObject({
        file: "empty/home.html",
        pageId: "empty",
        frameId: expect.any(String),
      });
      expect(read(frame.file)).toContain('href="../tokens.css"');
      const canvas = JSON.parse(read("meta/canvas.json"));
      expect(canvas.pages.slice(0, 2)).toEqual(pagesCanvas.pages.slice(0, 2));
      expect(canvas.pages[2].frames).toEqual([frame.frameId]);
      expect(frame).toMatchObject({ x: 0, y: 0, z: 0 });
    }));

  it("rejects missing and ambiguous page targets without writing source", () =>
    run(async () => {
      const before = read("meta/canvas.json");
      await expect(createDesignFrame(root, { title: "Wrong" })).rejects.toThrow(
        /pageId required/i,
      );
      await expect(
        createDesignFrame(root, { title: "Wrong", pageId: "missing" }),
      ).rejects.toThrow(/page.*not found|page.*missing/i);
      await expect(
        duplicateDesignFrame(root, "page-1/home.html"),
      ).rejects.toThrow(/pageId required/i);
      expect(read("meta/canvas.json")).toBe(before);
      expect(existsSync(path.join(root, pagesDirectory, "wrong.html"))).toBe(
        false,
      );
    }));

  it("keeps automatic placement local to a page", () =>
    run(async () => {
      const first = await createDesignFrame(root, {
        pageId: "empty",
        title: "One",
      });
      const second = await createDesignFrame(root, {
        pageId: "empty",
        title: "Two",
      });
      expect(first).toMatchObject({ x: 0, y: 0, z: 0 });
      expect(second).toMatchObject({ x: 1560, y: 0, z: 1 });
      const other = await createDesignFrame(root, {
        pageId: "checkout",
        title: "Other",
      });
      expect(other.z).toBe(1);
    }));

  it("creates text frames in the explicit page", () =>
    run(async () => {
      const frame = await createDesignFrame(root, {
        pageId: "empty",
        title: "Label",
        seed: { kind: "text", nodeId: "text", text: "Hello", fixedSize: false },
      });
      expect(frame).toMatchObject({
        pageId: "empty",
        file: "empty/label.html",
        kind: "text",
      });
      expect(read(frame.file)).toContain('href="../tokens.css"');
      expect(read(frame.file)).toContain("Hello");
    }));

  it("duplicates into the requested page and preserves source-relative URL origins", () =>
    run(async () => {
      const copied = await duplicateDesignFrame(root, "page-1/home.html", {
        pageId: "checkout",
      });
      expect(copied).toMatchObject({
        pageId: "checkout",
        file: "checkout/home-copy.html",
        z: 1,
      });
      expect(read(copied.file)).toContain('href="../page-1/local.html"');
      expect(read(copied.file)).toContain('href="../tokens.css"');
      expect(read(copied.file)).not.toContain('data-oid="label"');
      expect(JSON.parse(read("meta/canvas.json")).pages[0].frames).toEqual([
        "home",
      ]);
    }));

  /** Register native frames on one page until it holds `total`. */
  const fillPage = (pageIndex: number, total: number) => {
    const canvas = JSON.parse(read("meta/canvas.json"));
    const page = canvas.pages[pageIndex];
    for (let index = page.frames.length; index < total; index++) {
      const id = `${page.id}_filler_${index}`;
      const source = `${page.folder}/filler-${index}.html`;
      canvas.frames[id] = { kind: "html", source, title: "Filler", x: 0, y: 0, width: 10, height: 10 };
      page.frames.push(id);
      writeFileSync(path.join(root, pagesDirectory, source), "<h1>Filler</h1>");
    }
    writeFileSync(path.join(root, pagesDirectory, "meta/canvas.json"), JSON.stringify(canvas));
  };
  const pageFrames = async (pageId: string) =>
    (await readCanvas(root)).pages!.find((page) => page.id === pageId)!.frames;
  const full = /Design page "Screens" already has 1,000 frames, the most a page holds/;

  it("caps frames per page, not per directory, on every admitting write", () =>
    run(async () => {
      fillPage(0, 1_000);
      const before = read("meta/canvas.json");
      await expect(createDesignFrame(root, { pageId: "screens" })).rejects.toThrow(full);
      await expect(duplicateDesignFrame(root, "checkout/home.html", { pageId: "screens" })).rejects.toThrow(full);
      const identity = await readDesignFrameRenderIdentity(root, "checkout/home.html");
      await expect(transferDesignNode(root, {
        frame: "checkout/home.html", sourceVersion: identity.sourceVersion, nodeId: "label",
        pageId: "screens", geometry: { x: 0, y: 0, w: 390, h: 844, z: 0 },
      })).rejects.toThrow(/too many frames|1,000 frames/);
      expect(read("meta/canvas.json")).toBe(before);
      expect(existsSync(path.join(root, pagesDirectory, "page-1/frame.html"))).toBe(false);
      expect(existsSync(path.join(root, pagesDirectory, "page-1/home-copy.html"))).toBe(false);
      // The directory already holds 1,001 frames; other pages still admit more.
      const elsewhere = await createDesignFrame(root, { pageId: "empty" });
      expect(elsewhere.pageId).toBe("empty");
      expect(await duplicateDesignFrame(root, "page-1/home.html", { pageId: "checkout" })).toMatchObject({ pageId: "checkout" });
      expect(await pageFrames("screens")).toHaveLength(1_000);
    }));

  it("refuses to restore a deleted frame or redo a layer move onto a page that filled up", () =>
    run(async () => {
      fillPage(0, 1_000);
      const restore = await captureDesignFrameRestorePoint(root, "page-1/home.html");
      await deleteDesignFrame(root, "page-1/home.html");
      await createDesignFrame(root, { pageId: "screens", title: "Late" });
      await expect(restoreDesignFrame(root, restore)).rejects.toThrow(full);
      expect(existsSync(path.join(root, pagesDirectory, "page-1/home.html"))).toBe(false);
      const identity = await readDesignFrameRenderIdentity(root, "checkout/home.html");
      const moved = await transferDesignNode(root, {
        frame: "checkout/home.html", sourceVersion: identity.sourceVersion, nodeId: "label",
        pageId: "empty", geometry: { x: 0, y: 0, w: 390, h: 844, z: 0 },
      });
      await restoreDesignFrameChanges(root, moved.changes, "undo");
      fillPage(2, 1_000);
      await expect(restoreDesignFrameChanges(root, moved.changes, "redo")).rejects.toThrow(/too many frames|1,000 frames/);
      expect(await pageFrames("empty")).toHaveLength(1_000);
      expect(existsSync(path.join(root, pagesDirectory, moved.frame))).toBe(false);
    }));

  it("admits concurrent creates on different pages without losing any", () =>
    run(async () => {
      const titles = ["One", "Two", "Three", "Four", "Five"];
      for (const title of titles) await createDesignPage(root, { title });
      const pages = (await readCanvas(root)).pages!;
      expect(pages).toHaveLength(8);
      const created = await Promise.all(pages.map((page, index) =>
        createDesignFrame(root, { pageId: page.id, title: `Concurrent ${index}` })));
      const canvas = await readCanvas(root);
      for (const [index, page] of canvas.pages!.entries())
        expect(page.frames).toContain(created[index]!.frameId);
      expect(new Set(created.map((frame) => frame.file)).size).toBe(8);
      for (const frame of created) expect(existsSync(path.join(root, pagesDirectory, frame.file))).toBe(true);
    }));

  it("lands concurrent creates in one canvas write with distinct files, isolating a bad request", () =>
    run(async () => {
      const before = designFrameCreateBatchesForTests();
      const results = await Promise.allSettled([
        ...Array.from({ length: 6 }, () => createDesignFrameWithRestorePoint(root, { pageId: "empty", title: "Same" })),
        createDesignFrameWithRestorePoint(root, { pageId: "missing", title: "Lost" }),
        createDesignFrameWithRestorePoint(root, { pageId: "checkout", title: "Other" }),
      ]);
      expect(designFrameCreateBatchesForTests() - before).toBe(1);
      expect(results[6]).toMatchObject({ status: "rejected" });
      const created = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      expect(created.map(({ frame }) => frame.file)).toEqual([
        "empty/same.html", "empty/same-2.html", "empty/same-3.html", "empty/same-4.html",
        "empty/same-5.html", "empty/same-6.html", "checkout/other.html",
      ]);
      expect(await pageFrames("empty")).toEqual(created.slice(0, 6).map(({ frame }) => frame.frameId));
      for (const { frame, restorePoint } of created)
        expect(await captureDesignFrameRestorePoint(root, frame.file)).toEqual(restorePoint);
    }));

  it("shares one acknowledgement read among writers waiting for it, preparing every affected frame", () =>
    run(async () => {
      const files = ["page-1/home.html", "checkout/home.html"];
      const before = designMutationSnapshotReadsForTests();
      const [first, second] = await Promise.all(files.map((file) => readDesignMutationSnapshot(root, [file])));
      expect(designMutationSnapshotReadsForTests() - before).toBe(1);
      for (const snapshot of [first!, second!])
        expect(snapshot.frames.map((frame) => frame.file).sort()).toEqual([...files].sort());
    }));

  it("admits exactly the remaining room when creates race into one nearly full page", () =>
    run(async () => {
      fillPage(0, 999);
      const results = await Promise.allSettled([1, 2, 3].map((index) =>
        createDesignFrame(root, { pageId: "screens", title: `Race ${index}` })));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results.filter((result) => result.status === "rejected"))
        expect(String((result as PromiseRejectedResult).reason)).toMatch(full);
      expect(await pageFrames("screens")).toHaveLength(1_000);
    }));

  it("keeps native canvas formatting when a write leaves the scene unchanged", () =>
    run(async () => {
      // The first write adds the migrated Foundation manifest the fixture lacks.
      await writeCanvas(root, await readCanvas(root));
      const compact = JSON.stringify(JSON.parse(read("meta/canvas.json")));
      writeFileSync(path.join(root, pagesDirectory, "meta/canvas.json"), compact);
      await writeCanvas(root, await readCanvas(root), [
        { file: `${pagesDirectory}/page-1/home.html`, before: read("page-1/home.html"), after: "<h1>Edited</h1>" },
      ]);
      expect(read("meta/canvas.json")).toBe(compact);
      const canvas = await readCanvas(root);
      canvas.frames["page-1/home.html"]!.x = 640;
      await writeCanvas(root, canvas);
      const canonical = read("meta/canvas.json");
      expect(canonical).not.toBe(compact);
      expect(JSON.parse(canonical).frames.home.x).toBe(640);
      const again = await readCanvas(root);
      again.frames["page-1/home.html"]!.x = 960;
      await writeCanvas(root, again);
      expect(JSON.parse(read("meta/canvas.json")).frames.home.x).toBe(960);
      await writeCanvas(root, await readCanvas(root));
      expect(JSON.parse(read("meta/canvas.json")).frames.home.x).toBe(960);
    }));

  it("records the page identity and refuses restoration after page deletion or folder reuse", () =>
    run(async () => {
      const restore = await captureDesignFrameRestorePoint(
        root,
        "checkout/home.html",
      );
      expect(restore.pageId).toBe("checkout");
      await deleteDesignPage(root, "checkout", ["checkout_home"]);
      await expect(restoreDesignFrame(root, restore)).rejects.toThrow(
        /page.*not found|page.*removed|page.*missing/i,
      );
      expect(existsSync(path.join(root, pagesDirectory, "checkout"))).toBe(
        false,
      );
      const replacement = await createDesignPage(root, { title: "Checkout" });
      expect(replacement.folder).toBe("checkout");
      expect(replacement.id).not.toBe(restore.pageId);
      await expect(restoreDesignFrame(root, restore)).rejects.toThrow(
        /page.*not found|page.*removed|page.*missing/i,
      );
      expect(existsSync(path.join(root, pagesDirectory, restore.file))).toBe(
        false,
      );
    }));

  it("refuses transfer-history restoration into a deleted page before making directories", () =>
    run(async () => {
      const restore = await captureDesignFrameRestorePoint(
        root,
        "checkout/home.html",
      );
      await deleteDesignPage(root, "checkout", ["checkout_home"]);
      await expect(
        restoreDesignFrameChanges(
          root,
          [{ before: restore, after: null }],
          "undo",
        ),
      ).rejects.toThrow(/page.*not found|page.*removed|page.*missing/i);
      expect(existsSync(path.join(root, pagesDirectory, "checkout"))).toBe(
        false,
      );
    }));

  it("detaches a layer into an explicit page while retaining URL origins", () =>
    run(async () => {
      const identity = await readDesignFrameRenderIdentity(
        root,
        "page-1/home.html",
      );
      const moved = await transferDesignNode(root, {
        frame: "page-1/home.html",
        sourceVersion: identity.sourceVersion,
        nodeId: "label",
        pageId: "empty",
        geometry: { x: 0, y: 0, w: 390, h: 844, z: 0 },
      });
      expect(moved.frame).toBe("empty/frame.html");
      expect(moved.changes[1]?.after?.pageId).toBe("empty");
      expect(read(moved.frame)).toContain('href="../tokens.css"');
      expect(
        (await readCanvas(root)).pages!.find((page) => page.id === "empty")!
          .frames,
      ).toHaveLength(1);
    }));
});
