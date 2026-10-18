import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectDesignCatalog,
  readDesignCatalogMetadata,
} from "../catalog-storage";
import * as storage from "../document-storage";
import {
  primeDesignDirectoryName,
  forgetDesignDirectoryName,
  withDesignDirectoryNameLease,
} from "../directory-registry";
import { designPrivateStorageDirectory } from "../metadata-storage";
import { createDesignFrame } from "../frame-lifecycle";
import { withDesignWorkspaceMutation } from "../document-write-lock";

const directory = "Product - Design";
function scene(count: number, version = 2) {
  const ids = Array.from({ length: count }, (_, i) => `f${i}`);
  return {
    version,
    pages: [
      {
        id: "p",
        title: "Page",
        ...(version === 2 ? { folder: "page-1" } : {}),
        frames: ids,
        extension: { preserve: true },
      },
    ],
    frames: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          kind: "html",
          source: `${version === 2 ? "page-1/" : ""}${id}.html`,
          title: id,
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          z: 0,
          extension: "authored",
        },
      ]),
    ),
  };
}
describe("observational registered catalog metadata", () => {
  let root: string;
  const write = async (file: string, text: string) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  const seed = async (count = 3, version = 2) => {
    const folder = `${directory}/${version === 2 ? "meta/" : ""}`;
    await write(
      `${folder}design.toml`,
      `format = "zeros-design"\nversion = ${version === 2 ? 3 : 2}\nid = "design_test"\ncanvas = "canvas.json"\n`,
    );
    await write(`${folder}canvas.json`, JSON.stringify(scene(count, version)));
    for (let i = 0; i < count; i++)
      await write(
        `${directory}/${version === 2 ? "page-1/" : ""}f${i}.html`,
        `<html><body data-oid="n${i}">Synthetic</body></html>`,
      );
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-catalog-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    primeDesignDirectoryName(root, directory);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    forgetDesignDirectoryName(root);
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });
  it.each([1, 2])(
    "reads public canvas v%i metadata without reading HTML, normalizing files or migrating",
    async (version) => {
      await seed(3, version);
      const file = path.join(
        root,
        directory,
        version === 2 ? "meta/canvas.json" : "canvas.json",
      );
      const before = await readFile(file, "utf8");
      const readSource = vi
        .spyOn(storage, "readBoundedDesignFrameSource")
        .mockRejectedValue(new Error("must not compose"));
      const result = await readDesignCatalogMetadata(root, directory);
      expect(result.frames).toHaveLength(3);
      expect(
        result.frames.every(
          (frame) =>
            frame.preparation === "unprepared" &&
            !Object.hasOwn(frame, "sourceVersion"),
        ),
      ).toBe(true);
      expect(readSource).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe(before);
      expect(await readdir(path.join(root, directory))).not.toContain(".zeros");
    },
  );
  it("retains missing membership without inventing a source-derived title or render identity", async () => {
    await seed();
    await rm(path.join(root, directory, "page-1/f1.html"));
    expect(
      (await readDesignCatalogMetadata(root, directory)).frames[1],
    ).toMatchObject({ id: "f1", title: "f1", preparation: "unprepared" });
  });
  it("does not wait behind the mutation lane when the authored index is settled", async () => {
    await seed();
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = withDesignWorkspaceMutation(root, async () => {
      entered();
      await pending;
    });
    await inside;
    try {
      expect(
        (await readDesignCatalogMetadata(root, directory)).frames,
      ).toHaveLength(3);
    } finally {
      release();
      await mutation;
    }
  });
  it.each(["metadata", "transaction", "pages", "directory-rename", "legacy"])(
    "refuses a pending %s journal without attempting recovery",
    async (kind) => {
      await seed();
      const key = createHash("sha256")
        .update(directory)
        .digest("hex")
        .slice(0, 24);
      const file =
        kind === "legacy"
          ? path.join(root, directory, ".zeros-transaction.json")
          : path.join(
              designPrivateStorageDirectory(root),
              kind === "directory-rename"
                ? "directory-rename.json"
                : `${kind}-${key}.json`,
            );
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "pending");
      await expect(
        readDesignCatalogMetadata(root, directory),
      ).rejects.toMatchObject({ reason: "unsettled" });
      expect(await readFile(file, "utf8")).toBe("pending");
    },
  );
  it("fences changed bytes and same-path directory replacement across a held read", async () => {
    await seed();
    const original = storage.readCanvasContext;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(storage, "readCanvasContext").mockImplementation(
      async (target) => {
        const value = await original(target);
        entered();
        await pending;
        return value;
      },
    );
    const reading = readDesignCatalogMetadata(root, directory);
    await inside;
    await rename(path.join(root, directory), path.join(root, "previous"));
    await seed();
    release();
    await expect(reading).rejects.toMatchObject({ reason: "stale" });
  });
  it("binds inode and metadata revision independently and rejects unsafe metadata", async () => {
    await seed();
    const before = inspectDesignCatalog(root, directory);
    await write(
      `${directory}/meta/canvas.json`,
      JSON.stringify({ ...scene(3), extension: "changed" }),
    );
    const after = inspectDesignCatalog(root, directory);
    expect(after.binding).toBe(before.binding);
    expect(after.revision).not.toBe(before.revision);
    const target = path.join(root, directory, "meta/canvas.json");
    await rename(target, path.join(root, "foreign.json"));
    await symlink(path.join(root, "foreign.json"), target);
    await expect(readDesignCatalogMetadata(root, directory)).rejects.toThrow();
  });
  it("keeps 256 production admission and rejects a prospective 257th legacy write", async () => {
    await seed(256);
    const file = path.join(root, directory, "meta/canvas.json");
    const before = await readFile(file, "utf8");
    expect(
      (await readDesignCatalogMetadata(root, directory)).frames,
    ).toHaveLength(256);
    await expect(
      withDesignDirectoryNameLease(root, directory, () =>
        createDesignFrame(root, { pageId: "p", title: "Overflow" }),
      ),
    ).rejects.toThrow(/256/);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(path.join(root, directory, "page-1"))).toHaveLength(
      256,
    );
    await write(`${directory}/meta/canvas.json`, JSON.stringify(scene(257)));
    await expect(readDesignCatalogMetadata(root, directory)).rejects.toThrow();
  });
});
