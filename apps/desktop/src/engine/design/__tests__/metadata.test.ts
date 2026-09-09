import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitDesignMetadata,
  designDocumentMetadataPath,
  parseDesignDirectoryRegistry,
  readDesignDirectoryRegistry,
  recoverWorkspaceDesignMetadata,
  writePrivateDesignState,
} from "../metadata";

describe("tracked Design metadata", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-design-metadata-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    mkdirSync(path.join(root, "Product - Design"));
  });
  afterEach(() => {
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  it("registers once, moves legacy metadata out of the source folder and keeps checkout copies independent", () => {
    const legacy = path.join(root, "Product - Design", ".zeros-canvas.json");
    writeFileSync(legacy, '{"version":2,"frames":{}}');
    commitDesignMetadata(root, "Product - Design", '{"version":3,"frames":{}}');
    const registry = readDesignDirectoryRegistry(root)!;
    const [id] = Object.keys(registry.directories);
    expect(registry.directories[id].path).toBe("Product - Design");
    expect(existsSync(legacy)).toBe(false);
    expect(designDocumentMetadataPath(root, "Product - Design")).toBe(
      path.join(root, ".zeros", "design", id, "document.json"),
    );
    commitDesignMetadata(
      root,
      "Product - Design",
      '{"version":3,"frames":{"a.html":{}}}',
    );
    expect(Object.keys(readDesignDirectoryRegistry(root)!.directories)).toEqual(
      [id],
    );
    expect(
      readFileSync(
        designDocumentMetadataPath(root, "Product - Design"),
        "utf8",
      ),
    ).toContain("a.html");
  });
  it.each([
    'version = 1\n[directories.design_a]\npath = "../outside"',
    'version = 2\n[directories.design_a]\npath = "Design"',
    'version = 1\n[directories.bad]\npath = "Design"',
    'version = 1\n[directories.design_a]\npath = "Design"\n[directories.design_b]\npath = "design"',
    'version = 1\n[directories.design_a]\npath = "Design"\n[directories.design_b]\npath = "Design/nested"',
    'version = 1\n[directories.design_A]\npath = "First"\n[directories.design_a]\npath = "Second"',
  ])("rejects invalid or overlapping registry mappings", (raw) => {
    expect(() => parseDesignDirectoryRegistry(raw)).toThrow();
  });
  it("refuses linked registry files and symlinked metadata parents", () => {
    mkdirSync(path.join(root, ".zeros"));
    const outside = path.join(root, "outside.toml");
    writeFileSync(outside, "version = 1\n[directories]\n");
    const registry = path.join(root, ".zeros", "design-dir.toml");
    linkSync(outside, registry);
    expect(() => readDesignDirectoryRegistry(root)).toThrow();
    rmSync(registry);
    symlinkSync(outside, registry);
    expect(() => readDesignDirectoryRegistry(root)).toThrow();
    rmSync(registry);
    symlinkSync(
      path.join(root, "Product - Design"),
      path.join(root, ".zeros", "design"),
    );
    expect(() =>
      commitDesignMetadata(root, "Product - Design", "{}"),
    ).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("version = 1\n[directories]\n");
  });
  it("does not overwrite source edits that race a metadata migration", () => {
    const source = path.join(root, "Product - Design", "frame.html");
    writeFileSync(source, "new external edit");
    expect(() =>
      commitDesignMetadata(root, "Product - Design", "{}", [
        {
          file: "Product - Design/frame.html",
          before: "old",
          after: "migrated",
        },
      ]),
    ).toThrow(/changed/i);
    expect(readFileSync(source, "utf8")).toBe("new external edit");
    expect(existsSync(path.join(root, ".zeros", "design-dir.toml"))).toBe(
      false,
    );
  });

  it("replays an interrupted metadata/source pair and refuses competing edits", () => {
    const directory = "Product - Design";
    commitDesignMetadata(root, directory, "old metadata");
    const target = designDocumentMetadataPath(root, directory);
    const frame = `${directory}/frame.html`;
    writeFileSync(path.join(root, frame), "old source");
    const changes = [
      {
        file: path.relative(root, target),
        before: "old metadata",
        after: "new metadata",
      },
      { file: frame, before: "old source", after: "new source" },
    ];
    const name = `metadata-${createHash("sha256").update(directory).digest("hex").slice(0, 24)}.json`;
    const journal = writePrivateDesignState(
      root,
      name,
      JSON.stringify({
        version: 1,
        workspace: path.resolve(root),
        directory,
        changes,
      }),
    );
    writeFileSync(target, "new metadata");
    writeFileSync(path.join(root, frame), "competing source");
    expect(() => recoverWorkspaceDesignMetadata(root)).toThrow(/changed/);
    expect(readFileSync(path.join(root, frame), "utf8")).toBe(
      "competing source",
    );
    expect(existsSync(journal)).toBe(true);
    writeFileSync(path.join(root, frame), "old source");
    recoverWorkspaceDesignMetadata(root);
    expect(readFileSync(path.join(root, frame), "utf8")).toBe("new source");
    expect(existsSync(journal)).toBe(false);
  });

  it("checks the metadata snapshot captured before an asynchronous edit", () => {
    const directory = "Product - Design";
    commitDesignMetadata(root, directory, "original");
    const target = designDocumentMetadataPath(root, directory);
    const expected = {
      file: path.relative(root, target),
      source: "original",
      registry: readFileSync(path.join(root, ".zeros/design-dir.toml"), "utf8"),
    };
    writeFileSync(target, "external edit");
    expect(() =>
      commitDesignMetadata(root, directory, "stale edit", [], expected),
    ).toThrow(/changed/);
    expect(readFileSync(target, "utf8")).toBe("external edit");
  });
});
