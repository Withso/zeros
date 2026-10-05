import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDesignFrame, deleteDesignFrame, duplicateDesignFrame, initializeDesignDocument, restoreDesignFrame } from "../document";
import { designDirectoryNameFor, withDesignDirectoryNameLease } from "../directory-registry";
import { adoptExistingDesignDirectory, previewExistingDesignDirectory } from "../adopt-directory";
import { createDesignDirectoryPages, readDirectoryDesignLayout } from "../metadata";
import { parseDesignManifest, serializeDesignRegistration } from "../manifest";
import { decodeCanvasFile } from "../canvas-file";
import { runGit } from "../../git/git-exec";

describe("creating Design pages layouts", () => {
  let root: string;
  const directory = "Product - Design";
  const read = (file: string) => readFileSync(path.join(root, directory, file), "utf8");
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-design-pages-create-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
  });
  afterEach(() => {
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("initializes directly at meta with a durable default page and no gitkeep", async () => {
    const created = await withDesignDirectoryNameLease(root, directory, () => initializeDesignDocument(root));
    expect(created.created).toContain(`${directory}/meta/design.toml`);
    expect(created.created).toContain(`${directory}/meta/canvas.json`);
    expect(parseDesignManifest(read("meta/design.toml"))).toMatchObject({ version: 3, canvas: "canvas.json" });
    const canvas = JSON.parse(read("meta/canvas.json"));
    expect(canvas).toMatchObject({ version: 2, pages: [{ id: expect.any(String), title: "Page 1", folder: "page-1", frames: [] }], frames: {} });
    expect(canvas.pages[0].id).toMatch(/^page_[a-f0-9]{32}$/);
    expect(readdirSync(path.join(root, directory, "page-1"))).toEqual([]);
    expect(existsSync(path.join(root, directory, "design.toml"))).toBe(false);
    expect(existsSync(path.join(root, directory, "canvas.json"))).toBe(false);
    expect(read("rules.md")).toContain("meta/canvas.json");
    expect(read("rules.md")).toContain("page");
    expect(read("rules.md")).not.toContain("pages[0]");
    expect(read("tokens.css")).toContain(":root");
    const before = read("meta/canvas.json");
    await withDesignDirectoryNameLease(root, directory, () => initializeDesignDocument(root));
    expect(read("meta/canvas.json")).toBe(before);
    expect(designDirectoryNameFor(root)).not.toBe(`${directory}/meta`);
  });

  it("adopts a source folder directly into v3 while retaining unregistered assets", async () => {
    mkdirSync(path.join(root, directory, "meta"), { recursive: true });
    writeFileSync(path.join(root, directory, "meta/notes.txt"), "Keep this file");
    const source = '<!doctype html><title>Home</title><a href="https://example.test/">Home</a>';
    writeFileSync(path.join(root, directory, "home.html"), source);
    const preview = await previewExistingDesignDirectory(root, directory);
    expect(preview).toMatchObject({ metadataSource: "rebuild", frameCount: 1 });
    expect(existsSync(path.join(root, directory, "meta/design.toml"))).toBe(false);
    await adoptExistingDesignDirectory(root, directory, preview.revision);
    expect(readDirectoryDesignLayout(root, directory)?.kind).toBe("meta-v3");
    expect(read("page-1/home.html")).toBe(source);
    expect(read("meta/notes.txt")).toBe("Keep this file");
    expect(read("tokens.css")).toContain(":root");
    expect(read("rules.md")).toContain("meta/canvas.json");
    expect(Object.keys(decodeCanvasFile(read("meta/canvas.json")).frames as object)).toEqual(["page-1/home.html"]);
  });

  it("re-adopts a preserved v3 scene without losing its catalog or sources", async () => {
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["config", "user.name", "Test"]);
    await runGit(root, ["config", "user.email", "test@example.com"]);
    await withDesignDirectoryNameLease(root, directory, () => initializeDesignDocument(root));
    const registration = read("meta/design.toml");
    const canvas = read("meta/canvas.json");
    await runGit(root, ["add", directory]);
    await runGit(root, ["commit", "-m", "fixture"]);
    rmSync(path.join(root, directory, "meta/design.toml"));
    const preview = await previewExistingDesignDirectory(root, directory);
    expect(preview.metadataSource).toBe("git");
    await adoptExistingDesignDirectory(root, directory, preview.revision);
    expect(read("meta/design.toml")).toBe(registration);
    expect(read("meta/canvas.json")).toBe(canvas);
    expect((await runGit(root, ["diff", "--cached", "--name-only"], { readOnly: true })).stdout).toBe("");
  });

  it("keeps the existing sole-page frame helpers usable after direct v3 creation", async () => {
    await withDesignDirectoryNameLease(root, directory, async () => {
      await initializeDesignDocument(root);
      const frame = await createDesignFrame(root, { title: "Home" });
      expect(frame.file).toBe("page-1/home.html");
      expect(read(frame.file)).toContain('href="../tokens.css"');
      const duplicate = await duplicateDesignFrame(root, frame.file);
      expect(duplicate.file).toBe("page-1/home-copy.html");
      const deleted = await deleteDesignFrame(root, frame.file);
      expect(JSON.parse(read("meta/canvas.json")).pages[0].frames).toHaveLength(1);
      await restoreDesignFrame(root, deleted);
      expect(JSON.parse(read("meta/canvas.json")).pages[0].frames).toHaveLength(2);
    });
  });

  it.each([
    { id: "design_existing", folder: directory, reason: /identity|same ID/i },
    { id: "design_Existing", folder: directory, reason: /portable spelling/i },
    { id: "design_new", folder: "Existing/Child", reason: /overlap/i },
  ])("rejects conflicting registration $id at $folder before writing", async ({ id, folder, reason }) => {
    mkdirSync(path.join(root, "Existing/meta"), { recursive: true });
    writeFileSync(path.join(root, "Existing/meta/design.toml"), serializeDesignRegistration("design_existing", 3));
    mkdirSync(path.join(root, folder), { recursive: true });
    writeFileSync(path.join(root, folder, "notes.txt"), "Keep source");
    const canvas = decodeCanvasFile(JSON.stringify({ version: 1, frames: {} }));
    await withDesignDirectoryNameLease(root, folder, async () => {
      expect(() => createDesignDirectoryPages(root, folder, canvas, { id })).toThrow(reason);
    });
    expect(existsSync(path.join(root, folder, "meta/design.toml"))).toBe(false);
    expect(existsSync(path.join(root, folder, "rules.md"))).toBe(false);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
    expect(readFileSync(path.join(root, folder, "notes.txt"), "utf8")).toBe("Keep source");
  });

  it("enforces the 64-directory budget before admitting direct creation", async () => {
    for (let index = 0; index < 64; index++) {
      const folder = `Registered-${index}/meta`;
      mkdirSync(path.join(root, folder), { recursive: true });
      writeFileSync(path.join(root, folder, "design.toml"), serializeDesignRegistration(`design_${index}`, 3));
    }
    mkdirSync(path.join(root, directory));
    await withDesignDirectoryNameLease(root, directory, async () => {
      const canvas = decodeCanvasFile(JSON.stringify({ version: 1, frames: {} }));
      expect(() => createDesignDirectoryPages(root, directory, canvas)).toThrow(/Too many Design directories/i);
    });
    expect(existsSync(path.join(root, directory, "meta"))).toBe(false);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
  });
});
