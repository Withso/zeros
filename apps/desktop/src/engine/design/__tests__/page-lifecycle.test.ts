import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDesignFrame,
  createDesignPage,
  deleteDesignPage,
  initializeDesignDocument,
  renameDesignPage,
} from "../document";
import { withDesignDirectoryNameLease } from "../directory-registry";
import { readCanvas } from "../document-storage";
import { serializeDesignRegistration } from "../manifest";

describe("Design page lifecycle", () => {
  let root: string;
  const directory = "Product - Design";
  const read = (file = "meta/canvas.json") =>
    readFileSync(path.join(root, directory, file), "utf8");
  const run = <T>(action: () => Promise<T>) =>
    withDesignDirectoryNameLease(root, directory, action);
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-design-page-lifecycle-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    await run(() => initializeDesignDocument(root));
  });
  afterEach(() => {
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("creates stable pages in catalog order with default titles and empty folders", () =>
    run(async () => {
      const initial = JSON.parse(read()).pages[0];
      const second = await createDesignPage(root);
      const third = await createDesignPage(root);
      expect(second).toMatchObject({
        id: expect.stringMatching(/^page_[a-f0-9]{32}$/),
        title: "Page 2",
        folder: "page-2",
        frameFiles: [],
      });
      expect(third).toMatchObject({ title: "Page 3", folder: "page-3" });
      expect(third.id).not.toBe(second.id);
      expect(
        JSON.parse(read()).pages.map((page: { id: string }) => page.id),
      ).toEqual([initial.id, second.id, third.id]);
      expect(readdirSync(path.join(root, directory, second.folder))).toEqual(
        [],
      );
    }));

  it("generates portable lowercase slugs unique against every root entry and reserved name", () =>
    run(async () => {
      writeFileSync(path.join(root, directory, "CHECKOUT"), "Keep root file");
      mkdirSync(path.join(root, directory, "checkout-2"));
      const checkout = await createDesignPage(root, { title: "  Checkout  " });
      expect(checkout).toMatchObject({
        title: "Checkout",
        folder: "checkout-3",
      });
      const meta = await createDesignPage(root, { title: "Meta" });
      expect(meta.folder).toBe("meta-2");
      const symbols = await createDesignPage(root, { title: "✨" });
      expect(symbols.folder).toMatch(/^page-\d+(?:-\d+)?$/);
      const long = await createDesignPage(root, { title: "A".repeat(120) });
      expect(long.folder).toHaveLength(64);
      expect(
        (await createDesignPage(root, { title: "A".repeat(120) })).folder,
      ).toHaveLength(64);
      expect(read("CHECKOUT")).toBe("Keep root file");
    }));

  it.each([
    { title: "Café déjà vu", folder: "cafe-deja-vu", frame: "cafe-deja-vu" },
    { title: "✨", folder: "page-2", frame: "frame" },
    {
      title: `${"A".repeat(63)} b`,
      folder: "a".repeat(63),
      frame: `${"a".repeat(63)}-b`,
    },
    {
      title: `${"A".repeat(71)} b`,
      folder: "a".repeat(64),
      frame: `${"a".repeat(71)}-`,
    },
  ])(
    "preserves page and frame naming boundaries for $title",
    ({ title, folder, frame }) =>
      run(async () => {
        const page = await createDesignPage(root, { title });
        const created = await createDesignFrame(root, {
          title,
          pageId: page.id,
        });
        expect(page.folder).toBe(folder);
        expect(created.file).toBe(`${folder}/${frame}.html`);
      }),
  );

  it("skips default titles still in use after an earlier page is deleted", () =>
    run(async () => {
      const second = await createDesignPage(root);
      const third = await createDesignPage(root);
      await deleteDesignPage(root, second.id, []);
      const next = await createDesignPage(root);
      expect(next).toMatchObject({ title: "Page 4", folder: "page-4" });
      expect(
        JSON.parse(read()).pages.map((page: { title: string }) => page.title),
      ).toEqual(["Page 1", third.title, "Page 4"]);
      expect(existsSync(path.join(root, directory, "page-3-2"))).toBe(false);
    }));

  it("requires both an unused default title and a free unsuffixed folder", () =>
    run(async () => {
      const second = await createDesignPage(root);
      await renameDesignPage(root, second.id, "Page 3");
      writeFileSync(path.join(root, directory, "PAGE-4"), "Keep root file");
      const next = await createDesignPage(root);
      expect(next).toMatchObject({ title: "Page 5", folder: "page-5" });
      expect(read("PAGE-4")).toBe("Keep root file");
      expect(existsSync(path.join(root, directory, "page-4-2"))).toBe(false);
    }));

  it("renames only the title while preserving folder, membership and extensions", () =>
    run(async () => {
      const page = await createDesignPage(root, { title: "Checkout" });
      await createDesignFrame(root, { title: "Home", pageId: page.id });
      const authored = JSON.parse(read());
      authored.extension = { keep: true };
      authored.pages[1].custom = { keep: null };
      writeFileSync(
        path.join(root, directory, "meta/canvas.json"),
        JSON.stringify(authored),
      );
      const renamed = await renameDesignPage(root, page.id, "  Purchase  ");
      const after = JSON.parse(read());
      expect(renamed).toMatchObject({
        id: page.id,
        title: "Purchase",
        folder: "checkout",
      });
      expect(after).toEqual({
        ...authored,
        pages: [authored.pages[0], { ...authored.pages[1], title: "Purchase" }],
      });
      expect(existsSync(path.join(root, directory, "purchase"))).toBe(false);
    }));

  it.each(["", " ", "a".repeat(121), "Bad\u0007title", "\nTitle"])(
    "rejects an invalid title before changing the catalog: %j",
    (title) =>
      run(async () => {
        const before = read();
        const pageId = JSON.parse(before).pages[0].id;
        await expect(createDesignPage(root, { title })).rejects.toThrow(
          /title/i,
        );
        await expect(renameDesignPage(root, pageId, title)).rejects.toThrow(
          /title/i,
        );
        expect(read()).toBe(before);
      }),
  );

  it("refuses the 65th page without adding a folder", () =>
    run(async () => {
      const canvas = JSON.parse(read());
      for (let index = 2; index <= 64; index++)
        canvas.pages.push({
          id: `page_${index}`,
          title: `Page ${index}`,
          folder: `page-${index}`,
          frames: [],
        });
      writeFileSync(
        path.join(root, directory, "meta/canvas.json"),
        JSON.stringify(canvas),
      );
      const before = read();
      await expect(createDesignPage(root)).rejects.toThrow(/64|page limit/i);
      expect(read()).toBe(before);
      expect(existsSync(path.join(root, directory, "page-65"))).toBe(false);
    }));

  it("refuses the last page and missing page identities", () =>
    run(async () => {
      const before = read();
      await expect(
        deleteDesignPage(root, JSON.parse(before).pages[0].id, []),
      ).rejects.toThrow(/last page/i);
      await expect(
        renameDesignPage(root, "missing", "Missing"),
      ).rejects.toThrow(/page.*not found|page.*missing/i);
      await expect(deleteDesignPage(root, "missing", [])).rejects.toThrow(
        /page.*not found|page.*missing/i,
      );
      expect(read()).toBe(before);
    }));

  it("deletes only confirmed registered sources and retains nonempty folders", () =>
    run(async () => {
      const page = await createDesignPage(root, { title: "Checkout" });
      const frame = await createDesignFrame(root, {
        title: "Home",
        pageId: page.id,
      });
      const canvas = await readCanvas(root);
      const ids = canvas.pages!.find(
        (candidate) => candidate.id === page.id,
      )!.frames;
      writeFileSync(
        path.join(root, directory, page.folder, "notes.html"),
        "Keep unregistered source",
      );
      mkdirSync(path.join(root, directory, page.folder, "assets"));
      writeFileSync(
        path.join(root, directory, page.folder, "assets/logo.txt"),
        "Keep nested asset",
      );
      const before = read();
      await expect(deleteDesignPage(root, page.id, [])).rejects.toThrow(
        /membership|frames.*changed|changed.*frames/i,
      );
      expect(read()).toBe(before);
      await deleteDesignPage(root, page.id, ids);
      expect(existsSync(path.join(root, directory, frame.file))).toBe(false);
      expect(read(`${page.folder}/notes.html`)).toBe(
        "Keep unregistered source",
      );
      expect(read(`${page.folder}/assets/logo.txt`)).toBe("Keep nested asset");
      expect(JSON.parse(read()).pages).toHaveLength(1);
    }));

  it("compares confirmed membership as a set and removes only an empty page folder", () =>
    run(async () => {
      const page = await createDesignPage(root, { title: "Checkout" });
      await createDesignFrame(root, { title: "One", pageId: page.id });
      await createDesignFrame(root, { title: "Two", pageId: page.id });
      const ids = (await readCanvas(root)).pages!.find(
        (candidate) => candidate.id === page.id,
      )!.frames;
      await expect(
        deleteDesignPage(root, page.id, [ids[0]!, ids[0]!]),
      ).rejects.toThrow(/distinct|duplicate|membership/i);
      await deleteDesignPage(root, page.id, [...ids].reverse());
      expect(existsSync(path.join(root, directory, page.folder))).toBe(false);
      expect(Object.keys(JSON.parse(read()).frames)).toEqual([]);
    }));

  it("deletes a cloned empty page whose folder is absent", () =>
    run(async () => {
      const page = await createDesignPage(root, { title: "Empty" });
      rmdirSync(path.join(root, directory, page.folder));
      await deleteDesignPage(root, page.id, []);
      expect(JSON.parse(read()).pages).toHaveLength(1);
    }));

  it.each(["source", "folder"])(
    "deletes a page whose registered %s is already missing",
    (missing) =>
      run(async () => {
        const page = await createDesignPage(root, { title: "Missing" });
        const frame = await createDesignFrame(root, {
          title: "Gone",
          pageId: page.id,
        });
        const keep = await createDesignFrame(root, {
          title: "Keep",
          pageId: JSON.parse(read()).pages[0].id,
        });
        const ids = (await readCanvas(root)).pages!.find(
          (candidate) => candidate.id === page.id,
        )!.frames;
        rmSync(
          path.join(
            root,
            directory,
            missing === "source" ? frame.file : page.folder,
          ),
          { recursive: true },
        );
        await deleteDesignPage(root, page.id, ids);
        const after = JSON.parse(read());
        expect(after.pages).toHaveLength(1);
        expect(
          Object.values(after.frames).map(
            (entry: unknown) => (entry as { source: string }).source,
          ),
        ).toEqual([keep.file]);
        expect(existsSync(path.join(root, directory, keep.file))).toBe(true);
        expect(existsSync(path.join(root, directory, page.folder))).toBe(false);
      }),
  );

  it("migrates a root-v2 directory before admitting page lifecycle writes", () =>
    run(async () => {
      rmSync(path.join(root, directory), { recursive: true });
      mkdirSync(path.join(root, directory));
      writeFileSync(
        path.join(root, directory, "design.toml"),
        serializeDesignRegistration("design_legacy"),
      );
      writeFileSync(
        path.join(root, directory, "canvas.json"),
        JSON.stringify({
          version: 1,
          pages: [{ id: "screens", title: "Screens", frames: ["home"] }],
          frames: {
            home: {
              kind: "html",
              source: "home.html",
              title: "Home",
              x: 0,
              y: 0,
              width: 390,
              height: 844,
            },
          },
        }),
      );
      writeFileSync(
        path.join(root, directory, "home.html"),
        '<link href="tokens.css"><h1>Keep me</h1>',
      );
      const page = await createDesignPage(root);
      expect(page.title).toBe("Page 2");
      expect(JSON.parse(read()).pages[0]).toMatchObject({
        id: "screens",
        title: "Screens",
        folder: "page-1",
        frames: ["home"],
      });
      expect(read("page-1/home.html")).toContain('href="../tokens.css"');
      expect(existsSync(path.join(root, directory, "design.toml"))).toBe(false);
    }));
});
