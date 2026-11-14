import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listed = vi.hoisted(() => ({ calls: 0, coarse: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readdirSync = ((...args: Parameters<typeof actual.readdirSync>) => {
    listed.calls++;
    return actual.readdirSync(...args);
  }) as typeof actual.readdirSync;
  // A filesystem whose directory stamps do not move within one tick.
  const lstatSync = ((file: string, options?: { bigint?: boolean }) =>
    listed.coarse && options?.bigint
      ? { dev: 1n, ino: 1n, size: 1n, nlink: 1n, mtimeNs: 1n, ctimeNs: 1n }
      : actual.lstatSync(file, options as never)) as typeof actual.lstatSync;
  return { ...actual, readdirSync, lstatSync, default: { ...actual, readdirSync, lstatSync } };
});

import { DESIGN_DIRECTORY_NAME, initializeDesignDocument } from "../document";
import { readCanvas } from "../document-storage";
import { assertSafeDesignStoragePath, atomicWriteDesignStorageFile, withDesignStorageListings } from "../metadata-storage";

describe("Design storage path listings", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "zeros-storage-listings-")));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
  });
  afterEach(() => {
    listed.coarse = false;
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("a page migration lists its folders a bounded number of times per frame", async () => {
    const frames = 60;
    const directory = path.join(root, DESIGN_DIRECTORY_NAME);
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < frames; index++)
      writeFileSync(path.join(directory, `frame-${String(index).padStart(4, "0")}.html`),
        `<!doctype html><html><head><title>Frame ${index}</title></head><body><main data-oid="m${index}">${index}</main></body></html>`);
    listed.calls = 0;
    await initializeDesignDocument(root);
    expect(Object.keys((await readCanvas(root)).frames)).toHaveLength(frames);
    // Each frame's checks re-list only folders a write has changed since.
    expect(listed.calls).toBeLessThanOrEqual(frames * 15);
  });

  // The stamp sees another process's change only when the directory's
  // timestamps move, and coarse clocks (Linux) keep them within a tick: these
  // directories start in the past, so the change must move them.
  const aged = (directory: string) => utimesSync(directory, 1_000, 1_000);

  it("a reused listing still refuses a spelling added during the pass", () => {
    mkdirSync(path.join(root, "pages"));
    aged(path.join(root, "pages"));
    withDesignStorageListings(() => {
      expect(assertSafeDesignStoragePath(root, "pages/frame.html")).toBe(path.join(root, "pages", "frame.html"));
      writeFileSync(path.join(root, "pages", "Frame.HTML"), "");
      expect(() => assertSafeDesignStoragePath(root, "pages/frame.html")).toThrow(/ambiguous spelling/);
    });
  });

  it("a reused listing still accepts a spelling removed during the pass", () => {
    mkdirSync(path.join(root, "pages"));
    writeFileSync(path.join(root, "pages", "Frame.HTML"), "");
    aged(path.join(root, "pages"));
    withDesignStorageListings(() => {
      expect(() => assertSafeDesignStoragePath(root, "pages/frame.html")).toThrow(/ambiguous spelling/);
      rmSync(path.join(root, "pages", "Frame.HTML"));
      expect(assertSafeDesignStoragePath(root, "pages/frame.html")).toBe(path.join(root, "pages", "frame.html"));
    });
  });

  it("a spelling this pass writes is refused even when the directory's stamp does not move", () => {
    mkdirSync(path.join(root, "pages"));
    listed.coarse = true;
    withDesignStorageListings(() => {
      expect(assertSafeDesignStoragePath(root, "pages/frame.html")).toBe(path.join(root, "pages", "frame.html"));
      atomicWriteDesignStorageFile(root, "pages/Frame.HTML", "authored");
      expect(() => assertSafeDesignStoragePath(root, "pages/frame.html")).toThrow(/ambiguous spelling/);
    });
  });

  it("a directory this pass creates is listed afresh even when its parent's stamp does not move", () => {
    listed.coarse = true;
    withDesignStorageListings(() => {
      expect(assertSafeDesignStoragePath(root, "Pages/frame.html")).toBe(path.join(root, "Pages", "frame.html"));
      atomicWriteDesignStorageFile(root, "Pages/frame.html", "authored");
      expect(() => assertSafeDesignStoragePath(root, "pages/frame.html")).toThrow(/ambiguous spelling/);
    });
  });

  it("refuses asynchronous work", () => {
    expect(() => withDesignStorageListings(async () => undefined)).toThrow(/synchronous/);
  });
});
