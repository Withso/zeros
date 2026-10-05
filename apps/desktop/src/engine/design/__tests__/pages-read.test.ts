import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../../git/git-exec";
import { discoverDesignDirectories, resolveDesignDirectoryForEnter } from "../directory";
import { designDirectoryNameFor, primeDesignDirectoryName, forgetDesignDirectoryName } from "../directory-registry";
import { discoverFrameFiles, readCanvas, writeCanvas } from "../document-storage";
import { readDesignWorkspaceSnapshot } from "../document";
import { designDocumentMetadataPath, readDesignDirectoryRegistry, readDirectoryDesignLayout, refreshDesignManifestDiscovery } from "../metadata";
import { designRegistryAtGitRef } from "../metadata-git";
import { rememberRecognizedDesignDirectories, stickyRecognizedDesignDirectories } from "../recognition-store";
import { pagesCanvas, pagesDirectory, pagesManifest } from "./pages-fixtures";

describe("reading Design directory pages", () => {
  let root: string;
  const write = async (file: string, source: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-pages-read-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    await write(`${pagesDirectory}/meta/design.toml`, pagesManifest);
    await write(`${pagesDirectory}/meta/canvas.json`, JSON.stringify(pagesCanvas, null, 2) + "\n");
    await write(`${pagesDirectory}/rules.md`, "# Custom rules\n");
    await write(`${pagesDirectory}/page-1/home.html`, '<!doctype html><html><head></head><body><div data-oid="home">Home</div></body></html>');
    await write(`${pagesDirectory}/checkout/home.html`, '<!doctype html><html><head></head><body><div data-oid="checkout">Checkout</div></body></html>');
    primeDesignDirectoryName(root, pagesDirectory);
  });
  afterEach(async () => {
    forgetDesignDirectoryName(root);
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("recognizes the logical root, retains its ID and never registers meta", async () => {
    expect(await discoverDesignDirectories(root)).toEqual([pagesDirectory]);
    expect(readDesignDirectoryRegistry(root)?.directories).toEqual({ design_pages: { path: pagesDirectory } });
    expect(readDirectoryDesignLayout(root, pagesDirectory)).toMatchObject({
      kind: "meta-v3", directory: pagesDirectory,
      manifestFile: `${pagesDirectory}/meta/design.toml`, documentFile: `${pagesDirectory}/meta/canvas.json`,
    });
    expect(designDocumentMetadataPath(root, pagesDirectory)).toBe(path.join(root, pagesDirectory, "meta/canvas.json"));
    expect(await resolveDesignDirectoryForEnter({ path: root, repoRoot: root })).toBe(pagesDirectory);
    expect(designDirectoryNameFor(root)).toBe(pagesDirectory);
    await rememberRecognizedDesignDirectories(root, await discoverDesignDirectories(root));
    expect(await stickyRecognizedDesignDirectories(root)).toEqual([pagesDirectory]);
  });

  it("reads membership and empty missing page folders without changing source bytes", async () => {
    const manifestBefore = await readFile(path.join(root, pagesDirectory, "meta/design.toml"), "utf8");
    const canvasBefore = await readFile(path.join(root, pagesDirectory, "meta/canvas.json"), "utf8");
    const canvas = await readCanvas(root);
    expect(canvas.pages).toEqual(pagesCanvas.pages);
    expect(await discoverFrameFiles(root)).toEqual(["page-1/home.html", "checkout/home.html"]);
    expect(canvas.frame_info["checkout/home.html"].id).toBe("checkout_home");
    expect(await readFile(path.join(root, pagesDirectory, "meta/design.toml"), "utf8")).toBe(manifestBefore);
    expect(await readFile(path.join(root, pagesDirectory, "meta/canvas.json"), "utf8")).toBe(canvasBefore);
  });

  it("includes every page and exact frame ownership in the directory snapshot", async () => {
    const snapshot = await readDesignWorkspaceSnapshot(root);
    expect(snapshot.pages).toEqual([
      { id: "screens", title: "Screens", folder: "page-1", frameFiles: ["page-1/home.html"] },
      { id: "checkout", title: "Checkout", folder: "checkout", frameFiles: ["checkout/home.html"] },
      { id: "empty", title: "Empty", folder: "empty", frameFiles: [] },
    ]);
    expect(snapshot.frames.map((frame) => [frame.file, frame.pageId, frame.frameId])).toEqual([
      ["page-1/home.html", "screens", "home"], ["checkout/home.html", "checkout", "checkout_home"],
    ]);
  });

  it("selects canvas output version and metadata location from the resolved layout", async () => {
    const canvas = await readCanvas(root);
    canvas.frames["checkout/home.html"].x = 50;
    await writeCanvas(root, canvas);
    const source = JSON.parse(await readFile(path.join(root, pagesDirectory, "meta/canvas.json"), "utf8"));
    expect(source.version).toBe(2);
    expect(source.pages).toEqual(pagesCanvas.pages);
    expect(source.extension).toEqual(pagesCanvas.extension);
    expect(source.frames.checkout_home.x).toBe(50);
    expect(await readFile(path.join(root, pagesDirectory, "meta/design.toml"), "utf8")).toBe(pagesManifest);
    await expect(readFile(path.join(root, pagesDirectory, "design.toml"))).rejects.toThrow();
  });

  it("fails closed when the canvas version does not match the manifest layout", async () => {
    await write(`${pagesDirectory}/meta/canvas.json`, JSON.stringify({ version: 1, frames: {} }));
    await expect(readCanvas(root)).rejects.toThrow(/requires canvas version 2/i);
  });

  it.each(["meta", "META", "Meta/design.toml"])("keeps an unrelated entry at %s readable in a legacy layout", async (file) => {
    await rm(path.join(root, pagesDirectory, "meta"), { recursive: true });
    await write(`${pagesDirectory}/design.toml`, pagesManifest.replace("version = 3", "version = 2"));
    await write(`${pagesDirectory}/canvas.json`, JSON.stringify({
      version: 1, pages: [{ id: "screens", title: "Screens", frames: ["home"] }],
      frames: { home: { ...pagesCanvas.frames.home, source: "home.html" } },
    }));
    await write(`${pagesDirectory}/home.html`, '<!doctype html><html><body><main data-oid="home">Home</main></body></html>');
    await write(`${pagesDirectory}/${file}`, "Unrelated legacy source.\n");
    expect((await readCanvas(root)).frames).toHaveProperty("home.html");
    expect(await readFile(path.join(root, pagesDirectory, file), "utf8")).toBe("Unrelated legacy source.\n");
  });

  it("reads v3 roots from exact index and HEAD manifests, independently of worktree bytes", async () => {
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["config", "user.name", "Test"]);
    await runGit(root, ["config", "user.email", "test@example.com"]);
    await runGit(root, ["add", "--", pagesDirectory]);
    await runGit(root, ["commit", "-m", "fixture"]);
    await write(`${pagesDirectory}/meta/design.toml`, pagesManifest.replace("version = 3", "version = 99"));
    expect((await designRegistryAtGitRef(root, ":"))?.directories).toEqual({ design_pages: { path: pagesDirectory } });
    expect((await designRegistryAtGitRef(root, "HEAD"))?.directories).toEqual({ design_pages: { path: pagesDirectory } });
    await write(`${pagesDirectory}/meta/design.toml`, pagesManifest);
    await runGit(root, ["mv", "--", pagesDirectory, "apps/Moved"]);
    expect((await designRegistryAtGitRef(root, ":"))?.directories.design_pages.path).toBe("apps/Moved");
    expect(await discoverDesignDirectories(root)).toEqual(["apps/Moved", pagesDirectory]);
  });

  it("rejects competing root and meta registrations without rewriting either", async () => {
    await write(`${pagesDirectory}/design.toml`, pagesManifest.replace("version = 3", "version = 2"));
    expect(() => readDesignDirectoryRegistry(root)).toThrow(/competing|multiple|both/i);
    await expect(readCanvas(root)).rejects.toThrow(/competing|multiple|both/i);
  });

  it.each(["root", "symlink", "file", "file-alias", "page-symlink"])("rejects unsafe layout evidence: %s", async (kind) => {
    if (kind === "root") {
      await rename(path.join(root, pagesDirectory, "meta/design.toml"), path.join(root, pagesDirectory, "design.toml"));
    } else if (kind === "symlink") {
      await rm(path.join(root, pagesDirectory, "meta/design.toml"));
      await write("registration.toml", pagesManifest);
      await symlink(path.join(root, "registration.toml"), path.join(root, pagesDirectory, "meta/design.toml"));
    } else if (kind === "page-symlink") {
      await symlink(path.join(root, pagesDirectory, "checkout"), path.join(root, pagesDirectory, "empty"));
    } else {
      await write(`${pagesDirectory}/${kind === "file-alias" ? "EMPTY" : "empty"}`, "This is a file, not a page folder.");
    }
    refreshDesignManifestDiscovery(root);
    await expect(readCanvas(root)).rejects.toThrow();
  });
});
